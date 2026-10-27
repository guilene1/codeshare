// Share popup "Editors · Can edit" (owner-only Edit Link management, masked, page-session only,
// confirmed replace/revoke) and the Explorer/Connected vertical splitter.
import { test, expect, type Page, type Browser } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

async function apiCall(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch(`/api/rooms/${id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}
// Does this token still grant editing? (Asked anonymously, with only the Bearer link.)
const linkAccess = (page: Page, token: string) =>
  page.evaluate(async (token) => {
    const id = location.pathname.split("/")[2];
    const r = await fetch(`/api/rooms/${id}`, { credentials: "omit", headers: { authorization: `Bearer ${token}` } });
    return r.ok ? (await r.json()).access : r.status;
  }, token);
const tokenOf = (link: string) => link.split("/edit/")[1];
const share = (page: Page) => page.getByRole("button", { name: "Share", exact: true }).click();
const editors = (page: Page) => page.getByRole("region", { name: "Editors" });

test("owner: Editors · Can edit sits below Students, masked, kept for the page session, confirmed replace and revoke", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signUp(page, "Share Owner");
  await createWorkspace(page, "Share popup");
  await share(page);
  const dialog = page.getByRole("dialog");
  // Order and no duplicates: Students, then Editors, then People with access.
  const headings = await dialog.locator("h3").allTextContents();
  expect(headings.map((h) => h.trim())).toEqual(["Students · View only", "Editors · Can edit", "People with access"]);
  await expect(dialog.getByText("Co-editor access")).toHaveCount(0);
  // Students section unchanged.
  await expect(dialog.getByLabel("Student link", { exact: true })).toHaveValue(page.url().split("?")[0]);
  await expect(dialog.getByRole("button", { name: "Copy Student Link", exact: true })).toBeVisible();

  // No link yet.
  await expect(editors(page)).toContainText("No Edit Link exists yet");
  await editors(page).getByRole("button", { name: "Create Edit Link", exact: true }).click();
  const field = editors(page).getByLabel("Edit link", { exact: true });
  await expect(field).toHaveAttribute("type", "password"); // masked by default
  const link = await field.inputValue();
  expect(link).toMatch(/\/w\/[\w-]{16}\/edit\/[\w-]{43}$/);
  await editors(page).getByRole("button", { name: "Show edit link" }).click();
  await expect(field).toHaveAttribute("type", "text");
  await editors(page).getByRole("button", { name: "Hide edit link" }).click();
  await expect(field).toHaveAttribute("type", "password");
  await editors(page).getByRole("button", { name: "Copy edit link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await editors(page).getByRole("button", { name: "Copy Edit Link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  expect(await linkAccess(page, tokenOf(link))).toBe("editor");

  // Kept in page memory: closing and reopening the popup still shows it.
  await page.getByRole("button", { name: "Close dialog" }).click();
  await share(page);
  await expect(editors(page).getByLabel("Edit link", { exact: true })).toHaveValue(link);
  // Never written to browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(tokenOf(link));

  // After a refresh it cannot be shown again; the explanation says so.
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await share(page);
  await expect(editors(page).getByLabel("Edit link", { exact: true })).toHaveCount(0);
  await expect(editors(page)).toContainText("can't be displayed again");
  expect(await linkAccess(page, tokenOf(link))).toBe("editor"); // still active

  // Replace needs confirmation; Cancel changes nothing.
  await editors(page).getByRole("button", { name: "Replace link", exact: true }).click();
  await expect(editors(page).getByRole("group", { name: "Confirm Edit Link change" })).toContainText("Replace the Edit Link?");
  await editors(page).getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await linkAccess(page, tokenOf(link))).toBe("editor");
  await editors(page).getByRole("button", { name: "Replace link", exact: true }).click();
  await editors(page).getByRole("button", { name: "Yes, replace link" }).click();
  const replaced = await editors(page).getByLabel("Edit link", { exact: true }).inputValue();
  expect(replaced).not.toBe(link);
  expect(await linkAccess(page, tokenOf(link))).toBe(403); // old link stops working
  expect(await linkAccess(page, tokenOf(replaced))).toBe("editor");

  // Revoke needs confirmation too.
  await editors(page).getByRole("button", { name: "Revoke link", exact: true }).click();
  await expect(editors(page).getByRole("group", { name: "Confirm Edit Link change" })).toContainText("Revoke the Edit Link?");
  await editors(page).getByRole("button", { name: "Yes, revoke link" }).click();
  await expect(editors(page)).toContainText("No Edit Link exists yet");
  expect(await linkAccess(page, tokenOf(replaced))).toBe(403);
  await page.screenshot({ path: "test-results/share-popup-owner.png" });
});

async function pages(browser: Browser, n: number) {
  const contexts = await Promise.all(Array.from({ length: n }, () => browser.newContext()));
  return { contexts, pages: await Promise.all(contexts.map((c) => c.newPage())) };
}

test("non-owners cannot see or manage Edit Links; the Student Link stays view-only", async ({ browser }) => {
  test.setTimeout(150_000);
  const { contexts, pages: [owner, ed, vera, guest, student] } = await pages(browser, 5);
  try {
    const edEmail = uniqueEmail("ed"),
      veraEmail = uniqueEmail("vera");
    await signUp(ed, "Ed Editor", edEmail);
    await signUp(vera, "Vera Viewer", veraEmail);
    await signUp(owner, "Link Owner");
    const url = await createWorkspace(owner, "Edit link permissions");
    for (const s of [{ email: edEmail, role: "editor" }, { email: veraEmail, role: "viewer" }])
      expect((await apiCall(owner, "/shares", "POST", s)).status).toBe(201);
    await share(owner);
    await editors(owner).getByRole("button", { name: "Create Edit Link", exact: true }).click();
    const link = await editors(owner).getByLabel("Edit link", { exact: true }).inputValue();

    // Account editor: edits, but has no Editors section and cannot create or revoke links.
    await ed.goto(url);
    await expect(ed.getByLabel("Workspace access")).toContainText("Editing");
    await share(ed);
    await expect(editors(ed)).toHaveCount(0);
    await expect(ed.getByRole("button", { name: /Create Edit Link|Replace link|Revoke link/ })).toHaveCount(0);
    expect((await apiCall(ed, "/editor-link", "POST", {})).status).toBe(403);
    expect((await apiCall(ed, "/editor-link", "DELETE")).status).toBe(403);
    // Registered viewer: no Share at all.
    await vera.goto(url);
    await expect(vera.getByLabel("Workspace access")).toContainText("View Only");
    await expect(vera.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    // Edit Link holder: edits, sees only their own link (masked), with no management.
    await guest.goto(link);
    await guest.getByLabel("Your name").fill("Guest");
    await guest.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await expect(guest.getByLabel("Workspace access")).toContainText("Editing");
    await share(guest);
    await expect(editors(guest).getByLabel("Edit link", { exact: true })).toHaveAttribute("type", "password");
    await expect(guest.getByRole("button", { name: /Create Edit Link|Replace link|Revoke link/ })).toHaveCount(0);
    // Student Link: strictly view-only, with no trace of the Edit Link.
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    expect(await student.content()).not.toContain(tokenOf(link));
    expect((await apiCall(student, "/documents", "POST", { filename: "x.md", language: "markdown" })).status).toBe(403);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

// Connected fills in once presence arrives (the owner's own row), so measure only after that.
const settled = (page: Page) => expect(page.locator(".sidebar-people")).toContainText("(you)");
const heights = (page: Page) =>
  page.evaluate(() => {
    const h = (s: string) => Math.round(document.querySelector(s)!.getBoundingClientRect().height);
    return { explorer: h(".course-explorer"), people: h(".sidebar-people") };
  });
async function dragSplitter(page: Page, dy: number) {
  const box = (await page.getByRole("separator", { name: "Resize Connected panel" }).boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 4 });
  await page.mouse.move(x, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("Explorer / Connected splitter: drag, minimums, scrolling, keyboard, saving, reset, window resize, width resizing", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signUp(page, "Split Owner");
  await createWorkspace(page, "Splitter");
  // Enough files for the Explorer to scroll.
  for (let i = 1; i <= 24; i++)
    expect((await apiCall(page, "/documents", "POST", { filename: `file-${String(i).padStart(2, "0")}.md`, language: "markdown" })).status).toBe(201);
  const splitter = page.getByRole("separator", { name: "Resize Connected panel" });
  await expect(splitter).toBeVisible();
  await settled(page);
  await expect(splitter).toHaveAttribute("aria-orientation", "horizontal");
  expect(await splitter.evaluate((el) => getComputedStyle(el).cursor)).toBe("row-resize");
  const initial = await heights(page);

  // Dragging up gives Connected more room; dragging down gives the Explorer more.
  await dragSplitter(page, -100);
  const up = await heights(page);
  expect(up.people - initial.people).toBeGreaterThanOrEqual(95);
  expect(initial.explorer - up.explorer).toBeGreaterThanOrEqual(95);
  await dragSplitter(page, 60);
  const down = await heights(page);
  expect(up.people - down.people).toBeGreaterThanOrEqual(55);
  expect(down.explorer - up.explorer).toBeGreaterThanOrEqual(55);

  // Minimums: neither section disappears.
  await dragSplitter(page, 2000);
  expect((await heights(page)).people).toBe(96);
  await dragSplitter(page, -2000);
  expect((await heights(page)).explorer).toBeGreaterThanOrEqual(120);
  expect((await heights(page)).explorer).toBeLessThanOrEqual(122);

  // Independent scrolling.
  await dragSplitter(page, 2000); // Connected at its minimum: its content now scrolls too
  const scroll = await page.evaluate(() => {
    const e = document.querySelector(".course-explorer")!,
      p = document.querySelector(".sidebar-people")!;
    e.scrollTop = 200;
    return { explorerScrolls: e.scrollHeight > e.clientHeight, peopleScrolls: p.scrollHeight > p.clientHeight, explorerTop: e.scrollTop, peopleTop: p.scrollTop };
  });
  expect(scroll).toMatchObject({ explorerScrolls: true, peopleScrolls: true, peopleTop: 0 });
  expect(scroll.explorerTop).toBeGreaterThan(0);

  // Keyboard: arrow up grows Connected by a step; Enter resets.
  await splitter.focus();
  await page.keyboard.press("ArrowUp");
  expect((await heights(page)).people).toBe(120);

  // Saved locally and restored after refresh.
  await dragSplitter(page, -150);
  const chosen = (await heights(page)).people;
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("devshare.peopleHeight") ?? "null"))).toBe(chosen);
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await settled(page);
  expect((await heights(page)).people).toBe(chosen);

  // A shorter window keeps both minimums; the sidebar never overflows.
  await page.setViewportSize({ width: 1280, height: 560 });
  const short = await heights(page);
  expect(short.explorer).toBeGreaterThanOrEqual(120);
  expect(short.people).toBeGreaterThanOrEqual(96);
  expect(await page.locator(".sidebar").evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await heights(page)).people).toBe(chosen);

  // Width resizing still works alongside, and both are kept.
  const widthHandle = page.getByRole("separator", { name: "Resize Explorer", exact: true });
  const box = (await widthHandle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 300, { steps: 5 });
  await page.mouse.up();
  expect(await page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(314);
  expect((await heights(page)).people).toBe(chosen);

  // Double-click resets to the default split and forgets the saved height.
  await splitter.dblclick();
  expect(await page.evaluate(() => localStorage.getItem("devshare.peopleHeight"))).toBe("null");
  expect((await heights(page)).people).toBe(initial.people);
  await page.screenshot({ path: "test-results/sidebar-split-desktop.png" });
});

test("splitter: touch drag on a tablet; hidden for viewers and on phones", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const viewerContext = await browser.newContext();
  try {
    const page = await context.newPage();
    await signUp(page, "Touch Split");
    const url = await createWorkspace(page, "Touch split");
    await settled(page);
    const before = (await heights(page)).people;
    const box = (await page.getByRole("separator", { name: "Resize Connected panel" }).boundingBox())!;
    const x = Math.round(box.x + box.width / 2),
      y = Math.round(box.y + box.height / 2);
    const cdp = await context.newCDPSession(page);
    const touch = (type: string, py: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: py }] });
    await touch("touchStart", y);
    for (let step = 1; step <= 5; step++) await touch("touchMove", y - step * 12);
    await touch("touchEnd", y - 60);
    // A 60 px touch drag upward grows Connected by exactly that much.
    const grown = (await heights(page)).people - before;
    expect(grown).toBeGreaterThanOrEqual(58);
    expect(grown).toBeLessThanOrEqual(62);

    // Phones: the Explorer is an overlay without a splitter.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator(".status-bar")).toContainText("Connected");
    await page.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.getByRole("separator", { name: "Resize Connected panel" })).toBeHidden();
    await page.screenshot({ path: "test-results/sidebar-split-mobile.png" });

    // Viewers have no Connected section, so no splitter.
    const viewer = await viewerContext.newPage();
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await expect(viewer.getByRole("separator", { name: "Resize Connected panel" })).toHaveCount(0);
  } finally {
    await context.close();
    await viewerContext.close();
  }
});
