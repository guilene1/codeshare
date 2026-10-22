// Explorer clicks made before (or in the same render as) a lesson's first sync must open the
// clicked file; remembered tabs restore around them; the view-only interface stays minimal.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

// Holds the page's outgoing WebSocket messages until the test releases them, so the first
// sync is guaranteed to arrive after a click (no timing guesses).
const HOLD_SOCKETS = () => {
  const Native = window.WebSocket;
  const queue: Array<() => void> = [];
  const w = window as unknown as { __held: boolean; __releaseSockets: () => void };
  w.__held = true;
  w.__releaseSockets = () => {
    w.__held = false;
    queue.splice(0).forEach((send) => send());
  };
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const send = this.send.bind(this);
      this.send = (data) => (w.__held ? queue.push(() => send(data)) : send(data));
    }
  };
};
const release = (page: Page) =>
  page.evaluate(() => (window as unknown as { __releaseSockets: () => void }).__releaseSockets());
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const explorerFile = (page: Page, name: string) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true });
// The owner reads a file's exact text through the content API (proves nothing was modified).
async function content(owner: Page, fileId: string) {
  return owner.evaluate(async (fileId) => {
    const id = location.pathname.split("/")[2];
    return (await (await fetch(`/api/rooms/${id}/documents/${fileId}/content`)).json()).content as string;
  }, fileId);
}
async function fileIds(owner: Page) {
  return owner.evaluate(async () => {
    const id = location.pathname.split("/")[2];
    const tree = await (await fetch(`/api/rooms/${id}/tree`)).json();
    return Object.fromEntries(
      tree.documents.map((d: { filename: string; id: string }) => [d.filename, d.id]),
    ) as Record<string, string>;
  });
}
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
// Opens the workspace with sockets held, clicks a file at once, then lets the sync happen.
async function clickBeforeSync(page: Page, url: string, filename: string) {
  await page.addInitScript(HOLD_SOCKETS);
  await page.goto(url);
  await explorerFile(page, filename).click();
  await release(page);
  await expect(tab(page, filename)).toHaveAttribute("aria-selected", "true");
  // The first sync has really happened (its restored first tab exists), and did not win.
  await expect(tab(page, "main.tf")).toBeVisible();
  await expect(tab(page, filename)).toHaveAttribute("aria-selected", "true");
}

test("a file clicked before the first sync opens for Owners, Editors and Viewers", async ({ browser }) => {
  test.setTimeout(150_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const [ownerPage, edPage, veraPage, studentPage] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    const edEmail = uniqueEmail("ed"),
      veraEmail = uniqueEmail("vera");
    await signUp(edPage, "Ed Editor", edEmail);
    await signUp(veraPage, "Vera Viewer", veraEmail);
    await signUp(ownerPage, "Olivia Owner");
    const url = await createWorkspace(ownerPage, "Early clicks");
    for (const share of [
      { email: edEmail, role: "editor" },
      { email: veraEmail, role: "viewer" },
    ])
      expect((await apiCall(ownerPage, "/shares", "POST", share)).status).toBe(201);
    const ids = await fileIds(ownerPage);
    const before = { outputs: await content(ownerPage, ids["outputs.tf"]), variables: await content(ownerPage, ids["variables.tf"]) };

    // Owner (in a fresh tab), editor, registered viewer and anonymous viewer.
    const ownerTab = await contexts[0].newPage();
    for (const [page, access] of [
      [ownerTab, "Editing"],
      [edPage, "Editing"],
      [veraPage, "View Only"],
      [studentPage, "View Only"],
    ] as const) {
      await clickBeforeSync(page, url, "outputs.tf");
      await expect(page.getByLabel("Workspace access")).toContainText(access);
      // Switching between files stays reliable.
      await explorerFile(page, "variables.tf").click();
      await expect(tab(page, "variables.tf")).toHaveAttribute("aria-selected", "true");
      await tab(page, "outputs.tf").click();
      await expect(tab(page, "outputs.tf")).toHaveAttribute("aria-selected", "true");
    }
    // Opening and switching files never changed their content.
    expect(await content(ownerPage, ids["outputs.tf"])).toBe(before.outputs);
    expect(await content(ownerPage, ids["variables.tf"])).toBe(before.variables);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

test("remembered tabs restore after refresh, and an immediate click after refresh still wins", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Tab Owner");
  const url = await createWorkspace(page, "Tab restore");
  // Open two files; variables.tf is active.
  await explorerFile(page, "outputs.tf").click();
  await explorerFile(page, "variables.tf").click();
  await expect(tab(page, "variables.tf")).toHaveAttribute("aria-selected", "true");
  // A closed tab stays closed after refresh (closable tabs preserved).
  await tab(page, "outputs.tf").getByRole("button", { name: /Close/ }).click();
  await expect(tab(page, "outputs.tf")).toHaveCount(0);

  // Plain refresh: exactly the remembered tabs come back, with the same active tab.
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await expect(page.getByRole("tablist", { name: "Open files" }).getByRole("tab")).toHaveText(["main.tf", "variables.tf"]);
  await expect(tab(page, "variables.tf")).toHaveAttribute("aria-selected", "true");

  // Refresh with an immediate click: remembered tabs are restored and the click wins.
  await page.addInitScript(HOLD_SOCKETS);
  await page.reload();
  await explorerFile(page, "outputs.tf").click();
  await release(page);
  await expect(tab(page, "outputs.tf")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "main.tf")).toBeVisible();
  await expect(tab(page, "variables.tf")).toBeVisible();
  await expect(tab(page, "outputs.tf")).toHaveAttribute("aria-selected", "true");
});

test("a viewer clicking into a folder before its first sync opens that file", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page, "Folder Owner");
  const url = await createWorkspace(page, "Folder clicks");
  const folder = await apiCall(page, "/folders", "POST", { name: "Week 1" });
  expect(folder.status).toBe(201);
  for (const filename of ["lab.py", "notes.py"]) {
    const created = await apiCall(page, `/documents?folder=${folder.body.id}`, "POST", {
      filename,
      language: "python",
      content: `print("${filename}")\n`,
    });
    expect(created.status).toBe(201);
  }
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.addInitScript(HOLD_SOCKETS);
    await viewer.goto(url);
    await viewer.getByRole("button", { name: "Open folder Week 1", exact: true }).click();
    await explorerFile(viewer, "notes.py").click();
    await release(viewer);
    await expect(tab(viewer, "notes.py")).toHaveAttribute("aria-selected", "true");
    await expect(viewer.locator(".monaco-editor .view-lines").first()).toContainText('print("notes.py")');
  } finally {
    await context.close();
  }
});

async function viewerAndOwner(browser: Browser) {
  const ownerContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const viewerContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  return { ownerContext, viewerContext, owner: await ownerContext.newPage(), viewer: await viewerContext.newPage() };
}

test("View Only: no view switch or language label; Explorer, tabs, highlighting and Copy remain", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ownerContext, viewerContext, owner, viewer } = await viewerAndOwner(browser);
  try {
    await signUp(owner, "UI Owner");
    const url = await createWorkspace(owner, "Clean viewer");
    const fence = "`".repeat(3);
    expect(
      (
        await apiCall(owner, "/documents", "POST", {
          filename: "guide.md",
          language: "markdown",
          content: `# Guide\n\n${fence}shell\nkubectl get pods\n${fence}\n`,
        })
      ).status,
    ).toBe(201);
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");

    // Removed for viewers: the "Workspace root / Files & Editor" bar and the language label.
    await expect(viewer.locator(".workspace-views")).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: /Files & Editor/ })).toHaveCount(0);
    await expect(viewer.getByText("Workspace root", { exact: true })).toHaveCount(0);
    await expect(viewer.getByLabel("File language")).toHaveCount(0);
    await expect(viewer.locator(".toolbar-language")).toHaveCount(0);
    // No editing controls.
    for (const label of ["New file", "Rename file", "Delete file", "Insert Code Block", "Programming language"])
      await expect(viewer.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(viewer.getByLabel("Programming language")).toHaveCount(0);

    // Kept: Explorer (with its toggle), tabs and syntax highlighting.
    await expect(viewer.locator(".sidebar")).toBeVisible();
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(viewer.locator(".sidebar")).toHaveCount(0);
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(viewer.locator(".sidebar")).toBeVisible();
    await explorerFile(viewer, "main.tf").click();
    await expect(tab(viewer, "main.tf")).toHaveAttribute("aria-selected", "true");
    const tokenClasses = await viewer
      .locator(".monaco-editor .view-lines span[class^='mtk']")
      .evaluateAll((spans) => new Set(spans.map((s) => s.className)).size);
    expect(tokenClasses).toBeGreaterThan(2);
    // Status bar: the language stays; editor-only details (cursor, indentation, encoding) go.
    const status = viewer.locator(".status-bar");
    await expect(status.locator(".status-language")).toHaveText("Terraform / HCL");
    // Connection state and access live in the header for viewers, not in the status bar.
    for (const duplicate of ["Live", "View Only"]) await expect(status).not.toContainText(duplicate);
    await expect(status.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
    for (const detail of [/Ln \d+, Col \d+/, /Spaces:/, /UTF-8/]) await expect(status).not.toContainText(detail);
    // The viewer cannot change the file.
    await viewer.locator(".monaco-editor .view-lines").first().click();
    await viewer.keyboard.type("hacked");
    await expect(viewer.locator(".monaco-editor .view-lines").first()).not.toContainText("hacked");

    // Copy code still works on a Markdown lesson.
    await explorerFile(viewer, "guide.md").click();
    await viewer.locator(".inline-block").getByRole("button", { name: "Copy code" }).click();
    expect(await viewer.evaluate(() => navigator.clipboard.readText())).toBe("kubectl get pods");
    await expect(viewer.locator(".status-bar .status-language")).toHaveText("Markdown");
    await viewer.screenshot({ path: "test-results/view-only-clean.png" });
    // Phone width: the Explorer toggle is still reachable.
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.reload();
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(viewer.locator(".sidebar")).toBeVisible();
    await viewer.screenshot({ path: "test-results/view-only-clean-mobile.png" });

    // Owners keep the full editing interface.
    await expect(owner.locator(".workspace-views")).toBeVisible();
    await expect(owner.getByRole("button", { name: /Files & Editor/ })).toBeVisible();
    await expect(owner.getByText("Workspace root", { exact: true })).toBeVisible();
    await expect(owner.getByLabel("Programming language")).toBeVisible();
    await expect(owner.locator(".activity-summary")).toBeVisible();
    // Owners keep the full status bar.
    const ownerStatus = owner.locator(".status-bar");
    for (const detail of [/Ln \d+, Col \d+/, /Spaces: \d+/, /UTF-8/]) await expect(ownerStatus).toContainText(detail);
    await expect(ownerStatus.locator(".status-language")).toHaveText("Terraform / HCL");
  } finally {
    await ownerContext.close();
    await viewerContext.close();
  }
});
