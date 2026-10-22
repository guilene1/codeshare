import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

// Calls the workspace API from inside a signed-in page (cookie + CSRF), like the app does.
async function apiCall(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const response = await fetch(`/api/rooms/${id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    { path, method, body },
  );
}
// Records whether a page ever receives a Kodelumi presence/activity frame (type 4).
function watchJsonFrames(page: Page) {
  const seen = { count: 0 };
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" && payload[0] === 4) seen.count++;
    }),
  );
  return seen;
}
const summary = (page: Page) => page.locator(".activity-summary");
async function openPanel(page: Page) {
  if ((await page.getByRole("dialog", { name: "Workspace activity" }).count()) === 0)
    await summary(page).click();
  return page.getByRole("dialog", { name: "Workspace activity" });
}

test("Owners and Editors see live presence and attributed activity; Viewers see none of it", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const [ownerContext, edContext, veraContext, studentContext] = contexts;
  const [owner, ed, vera, student] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, ed, vera, student]) page.on("pageerror", (e) => errors.push(e.message));
  const veraFrames = watchJsonFrames(vera),
    studentFrames = watchJsonFrames(student),
    ownerFrames = watchJsonFrames(owner);
  try {
    const edEmail = uniqueEmail("ed"),
      veraEmail = uniqueEmail("vera");
    await signUp(ed, "Ed Editor", edEmail);
    await signUp(vera, "Vera Viewer", veraEmail);
    await signUp(owner, "Olivia Owner");
    const url = await createWorkspace(owner, "Presence lab");
    for (const share of [
      { email: edEmail, role: "editor" },
      { email: veraEmail, role: "viewer" },
    ])
      expect((await apiCall(owner, "/shares", "POST", share)).status).toBe(201);

    // The owner sees the summary at once, with the workspace creation as the last update.
    await expect(summary(owner)).toContainText("1 online");
    await expect(summary(owner)).toContainText("Updated Today at");
    await expect(summary(owner)).toContainText("Olivia Owner");

    for (const page of [ed, vera, student]) await page.goto(url);
    await expect(ed.getByLabel("Workspace access")).toContainText("Editing");
    await expect(vera.getByLabel("Workspace access")).toContainText("View Only");
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    // A second owner tab does not count as another person.
    const ownerTab2 = await ownerContext.newPage();
    await ownerTab2.goto(url);
    await expect(ownerTab2.locator(".status-bar")).toContainText("Connected");

    await expect(summary(owner)).toContainText("4 online");
    const panel = await openPanel(owner);
    const online = panel.getByRole("region", { name: "Online now" });
    await expect(online.locator("li")).toHaveText([
      /Olivia Owner \(you\)\s*Owner/,
      /Ed Editor\s*Editor/,
      /Vera Viewer\s*Viewer/,
      "1 anonymous viewer",
    ]);
    await expect(owner.locator(".sidebar-people")).toContainText("1 anonymous viewer");
    await expect(owner.locator(".sidebar-people .person")).toHaveCount(3);
    await owner.screenshot({ path: "test-results/activity-owner-panel.png" });

    // The editor sees the same presence, marked as themselves.
    await expect(summary(ed)).toContainText("4 online");
    await expect((await openPanel(ed)).getByRole("region", { name: "Online now" })).toContainText(
      "Ed Editor (you)",
    );
    await ed.keyboard.press("Escape");

    // Viewers: no summary, no Connected section, no API access, and no type-4 frames.
    for (const page of [vera, student]) {
      await expect(page.locator(".workspace-activity")).toHaveCount(0);
      await expect(page.locator(".sidebar-people")).toHaveCount(0);
      const response = await apiCall(page, "/activity");
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("Olivia");
    }

    // The editor types: the owner sees the edit attributed to them, live.
    await ed.locator(".monaco-editor textarea").first().focus();
    await ed.keyboard.press("Control+End");
    await ed.keyboard.type("\n# tuned by Ed");
    const last = panel.getByRole("region", { name: "Last updated" });
    await expect(last).toContainText("Ed Editor", { timeout: 10_000 });
    await expect(last).toContainText("File edited");
    await expect(last).toContainText("main.tf");
    await expect(last).toContainText(/Today at \d{1,2}:\d{2}/);
    // Many keystrokes, one activity row.
    await ed.keyboard.type(" and more");
    await expect(summary(owner)).toContainText("Ed Editor");
    const recent = panel.getByRole("region", { name: "Recent activity" });
    await expect(recent.locator("li", { hasText: "File edited" })).toHaveCount(1);

    // A file created, renamed and deleted by the editor appears with attribution.
    const created = await apiCall(ed, "/documents", "POST", {
      filename: "kubernetes.yaml",
      language: "yaml",
    });
    expect(created.status).toBe(201);
    await expect(recent.locator("li").first()).toContainText("File created");
    await expect(recent.locator("li").first()).toContainText("kubernetes.yaml");
    await expect(recent.locator("li").first()).toContainText("Ed Editor");
    expect((await apiCall(ed, `/documents/${created.body.id}`, "PATCH", { filename: "k8s.yaml" })).status).toBe(200);
    await expect(recent.locator("li").first()).toContainText("File renamed");
    expect((await apiCall(owner, "/folders", "POST", { name: "Week 1" })).status).toBe(201);
    await expect(recent.locator("li").first()).toContainText("Folder created");
    await expect(recent.locator("li").first()).toContainText("Olivia Owner");
    // Sharing changes are never part of this feed.
    await expect(recent).not.toContainText("Shared with");

    // People leaving update the counts; closing one owner tab keeps the owner online.
    await studentContext.close();
    await ownerTab2.close();
    await expect(summary(owner)).toContainText("3 online");
    await expect(online).toContainText("0 anonymous viewers");
    await expect(online).toContainText("Olivia Owner (you)");
    await expect(owner.locator(".presence-count")).toContainText("0");

    expect(veraFrames.count).toBe(0);
    expect(studentFrames.count).toBe(0);
    expect(ownerFrames.count).toBeGreaterThan(0);
    // View-only access is unchanged.
    await expect(vera.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const context of [ownerContext, edContext, veraContext, studentContext])
      await context.close().catch(() => {});
  }
});

test("activity pages with Show more, and the summary fits desktop, tablet and phone", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Paging Owner");
  await createWorkspace(page, "Paging lab");
  // 24 folder events plus the workspace creation: more than one page of 20.
  for (let i = 1; i <= 24; i++)
    expect((await apiCall(page, "/folders", "POST", { name: `Module ${i}` })).status).toBe(201);
  // Lets the test cut the workspace socket and hold reconnects, like a server restart.
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const w = window as unknown as { __blockSockets: boolean; __sockets: WebSocket[] };
    w.__blockSockets = false;
    w.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(w.__blockSockets ? "ws://127.0.0.1:9/blocked" : url, protocols);
        w.__sockets.push(this);
      }
    };
  });
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  const panel = await openPanel(page);
  const items = panel.getByRole("region", { name: "Recent activity" }).locator("li");
  await expect(items).toHaveCount(20);
  await expect(items.first()).toContainText("Module 24");
  await panel.getByRole("button", { name: "Show more activity" }).click();
  await expect(items).toHaveCount(25);
  await expect(items.last()).toContainText("Workspace created");
  await expect(panel.getByRole("button", { name: "Show more activity" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // An outage (as during a server restart): no stale count while disconnected, and a
  // fresh one after reconnecting.
  await page.evaluate(() => {
    const w = window as unknown as { __blockSockets: boolean; __sockets: WebSocket[] };
    w.__blockSockets = true;
    for (const socket of w.__sockets) socket.close();
  });
  await expect(page.locator(".status-bar")).not.toContainText("Connected");
  await expect(summary(page)).toContainText("Connecting…");
  await page.evaluate(() => {
    (window as unknown as { __blockSockets: boolean }).__blockSockets = false;
  });
  await expect(summary(page)).toContainText("1 online", { timeout: 15_000 });

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(summary(page)).toBeVisible();
    await expect(summary(page)).toContainText("1 online");
    const dialog = await openPanel(page);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/activity-${width}.png` });
    await page.keyboard.press("Escape");
  }
  // The resizable Explorer still works next to the summary.
  await page.setViewportSize({ width: 1280, height: 800 });
  if ((await page.locator(".sidebar").count()) === 0)
    await page.getByRole("button", { name: "Toggle explorer" }).click();
  const handle = page.getByRole("separator", { name: "Resize Explorer" });
  await handle.dblclick();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(334);
  await expect(summary(page)).toBeVisible();
});
