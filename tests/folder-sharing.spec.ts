// Folder sharing, Phase 4: the recipient interface. A folder-only recipient opens the shared
// folder by its link or from Shared with Me, sees only that folder and what is inside it,
// edits there when they are an Editor, and nothing about the rest of the workspace ever
// reaches their browser: not on the page, in the title, in storage, in API responses or in
// live frames. Shares are created over the REST API (the Share Folder popup is Phase 5).
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { chooseDocumentView, createWorkspace, openFromExplorer, signUp, uniqueEmail } from "./helpers";

const TITLE = "Kodelumi • Learn, Code, Share";
const SECRETS = ["Course WS-SECRET", "PARENT-SECRET", "SIBLING-SECRET", "ROOT-SECRET", "sibling-file.md", "root-file.md"];

// The workspace API from inside a signed-in page (cookie + CSRF), like the app does.
async function api(page: Page, id: string, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ id, path, method, body }) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch(`/api/rooms/${id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { id, path, method, body },
  );
}

// Records everything an API response or live frame delivers to this page.
function recordTraffic(page: Page, seen: string[] = []) {
  page.on("response", async (response) => {
    if (!new URL(response.url()).pathname.startsWith("/api/")) return;
    try {
      seen.push(await response.text());
    } catch {
      /* bodies of redirects or aborted requests */
    }
  });
  page.on("websocket", (ws) =>
    ws.on("framereceived", (frame) =>
      seen.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("latin1")),
    ),
  );
  return seen;
}
async function expectNoSecrets(page: Page, traffic: string[], where: string) {
  const visible = await page.locator("body").innerText();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const secret of SECRETS) {
    expect(visible, `${where}: page shows "${secret}"`).not.toContain(secret);
    expect(storage, `${where}: storage holds "${secret}"`).not.toContain(secret);
    expect(page.url(), `${where}: URL holds "${secret}"`).not.toContain(secret);
    expect(traffic.join("\n"), `${where}: network delivered "${secret}"`).not.toContain(secret);
  }
  await expect(page).toHaveTitle(TITLE);
}

// A Restricted workspace: root file, a parent folder holding the shared folder (with a
// subfolder) and a sibling, each with secrets the recipient must never see.
async function course(browser: Browser) {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signUp(owner, "Folder Owner");
  const url = await createWorkspace(owner, "Course WS-SECRET");
  const id = url.split("/w/")[1];
  const folder = async (name: string, parent_id?: string) =>
    (await api(owner, id, "/folders", "POST", { name, parent_id })).body.id as string;
  const parent = await folder("Parent PARENT-SECRET");
  const shared = await folder("Shared Notes", parent);
  const nested = await folder("Nested Labs", shared);
  const sibling = await folder("Sibling SIBLING-SECRET", parent);
  const file = async (lesson: string | null, filename: string, content: string) => {
    const r = await api(owner, id, `/documents${lesson ? "?folder=" + lesson : ""}`, "POST", { filename, language: "markdown", content });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  await file(null, "root-file.md", "ROOT-SECRET");
  await file(sibling, "sibling-file.md", "SIBLING-SECRET");
  const notes = await file(shared, "notes.md", "# Shared notes\n\nRead this first.\n\n```bash\necho shared\n```\n");
  await file(nested, "lab.md", "# Lab one\n");
  const share = async (folderId: string, email: string, role: "viewer" | "editor") =>
    expect((await api(owner, id, `/folders/${folderId}/shares`, "POST", { email, role })).status).toBeLessThan(300);
  return { ownerContext, owner, id, url, parent, shared, nested, sibling, notes, share };
}
async function recipient(browser: Browser, name: string, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, "-"));
  await signUp(page, name, email);
  return { context, page, email, errors };
}
const folderButton = (page: Page, name: string) =>
  page.locator(".sidebar").getByRole("button", { name: "Open folder " + name, exact: true });

// One course for the whole file, in order; every test brings its own recipients. (The server
// keeps at most 16 lessons in memory and frees idle ones only after 30-45 s, so a new course
// per test would exhaust it and make the following tests fail for reasons unrelated to them.)
test.describe.configure({ mode: "serial" });
let c: Awaited<ReturnType<typeof course>>;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  c = await course(browser);
});
test.afterAll(async () => {
  await c?.ownerContext.close().catch(() => {});
});
test("a Viewer opens the shared folder from Shared with Me and by link, reads it live, and sees nothing else of the workspace", async ({ browser }) => {
  test.setTimeout(180_000);
  const viewer = await recipient(browser, "Folder Viewer");
  const contexts: BrowserContext[] = [viewer.context];
  try {
    await c.share(c.shared, viewer.email, "viewer");
    const page = viewer.page;
    const traffic = recordTraffic(page);
    // Shared with Me: a folder card, beside (not replacing) shared workspaces.
    await page.goto("/workspaces?view=shared");
    const card = page.locator(".shared-with-me").getByRole("article", { name: "Shared Notes" });
    await expect(card).toContainText("Shared folder");
    await expect(card).toContainText("Viewer");
    await expect(card).toContainText("Shared by Folder Owner");
    await expect(card.locator(".workspace-card-icon svg")).toBeVisible();
    await card.getByRole("button", { name: "Open folder Shared Notes" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${c.id}\\?folder=${c.shared}$`));
    // The folder, its owner and the role; read-only.
    await expect(page.locator(".room-title")).toContainText("SHARED FOLDER");
    await expect(page.locator(".room-title")).toContainText("Shared Notes");
    await expect(page.getByLabel("Folder access")).toContainText("Viewer");
    await expect(page.getByLabel("Shared folder details")).toContainText("Shared by Folder Owner");
    await expect(page.getByLabel("Connection status")).toContainText("Live");
    await expect(folderButton(page, "Shared Notes")).toBeVisible();
    await expect(folderButton(page, "Nested Labs")).toBeVisible();
    await expect(page.locator(".sidebar .folder-row")).toHaveCount(2);
    await expect(page.getByTitle("Open workspace root")).toHaveCount(0);
    // No workspace sharing, presence, activity or editing controls.
    for (const label of ["Share", "Copy workspace link", "New file", "Add file tab", "Create folder"])
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(page.locator(".sidebar-people, .presence-count, .markdown-switch")).toHaveCount(0);
    await expect(page.locator(".folder-menu")).toHaveCount(0);
    // Reading: Markdown preview, highlighted code block with its Copy button, live updates.
    await openFromExplorer(page, "notes.md");
    const preview = page.getByLabel("Markdown preview");
    await expect(preview).toContainText("Read this first.");
    await expect(preview.getByRole("button", { name: "Copy code" })).toBeVisible();
    await expect(preview.locator("pre")).toContainText("echo shared");
    expect((await api(c.owner, c.id, `/documents/${c.notes}/content`, "PUT", { content: "# Shared notes\n\nUpdated live.\n", baseVersion: "*" })).status).toBe(200);
    await expect(preview).toContainText("Updated live.");
    // The inherited subfolder opens too.
    await folderButton(page, "Nested Labs").click();
    await openFromExplorer(page, "lab.md");
    await expect(page).toHaveURL(new RegExp(`folder=${c.nested}`));
    // Refresh keeps the place.
    await page.reload();
    await expect(page.getByLabel("Connection status")).toContainText("Live");
    await expect(page.getByRole("tab", { name: "lab.md" })).toHaveAttribute("aria-selected", "true");
    await expectNoSecrets(page, traffic, "viewer in the folder");
    // Direct links: the bare workspace link opens their folder; a link to a folder they
    // can't open says so generically and opens theirs; neither reveals anything.
    await page.goto(c.url);
    await expect(page).toHaveURL(new RegExp(`folder=${c.shared}$`));
    await expect(page.getByLabel("Connection status")).toContainText("Live");
    for (const other of [c.sibling, c.parent, "00000000-0000-0000-0000-000000000000"]) {
      await page.goto(`${c.url}?folder=${other}`);
      await expect(page.locator(".toast")).toContainText("That folder isn’t available");
      await expect(page).toHaveURL(new RegExp(`folder=${c.shared}$`));
    }
    await expectNoSecrets(page, traffic, "viewer after direct links");
    expect(viewer.errors).toEqual([]);
    // Signed out, the same link shows the plain not-found screen with a way to sign in.
    const visitorContext = await browser.newContext();
    contexts.push(visitorContext);
    const visitor = await visitorContext.newPage();
    const visitorTraffic = recordTraffic(visitor);
    await visitor.goto(`${c.url}?folder=${c.shared}`);
    await expect(visitor.getByText("Workspace not found", { exact: false })).toBeVisible();
    await visitor.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(visitor).toHaveURL(/\/signin\?next=/);
    await expectNoSecrets(visitor, visitorTraffic, "signed-out visitor");
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});

test("an Editor edits and organizes inside the shared folder, but can't rename or delete the shared folder itself", async ({ browser }) => {
  test.setTimeout(180_000);
  const editor = await recipient(browser, "Folder Editor");
  try {
    await c.share(c.shared, editor.email, "editor");
    const page = editor.page;
    const traffic = recordTraffic(page);
    await page.goto(`${c.url}?folder=${c.shared}`);
    await expect(page.getByLabel("Folder access")).toContainText("Editor");
    await expect(page.getByLabel("Connection status")).toContainText("Connected");
    await expect(page.getByLabel("Shared folder details")).toContainText("Editor");
    // Still no workspace-level controls.
    for (const label of ["Share", "Copy workspace link"])
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(page.locator(".sidebar-people, .presence-count")).toHaveCount(0);
    // Live editing in the shared folder reaches the owner.
    await openFromExplorer(page, "notes.md");
    await chooseDocumentView(page, "Edit");
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.type("Edited by the recipient. ", { delay: 15 });
    await expect
      .poll(async () => (await api(c.owner, c.id, `/documents/${c.notes}/content`)).body.content as string)
      .toContain("Edited by the recipient.");
    // New file in the shared folder.
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Filename").fill("answers.md");
    await page.getByRole("dialog").getByRole("button", { name: "Create file" }).click();
    await expect(page.getByRole("tab", { name: "answers.md" })).toBeVisible();
    // The shared folder itself: a subfolder may be created in it, but its own entry has no
    // Rename, Move or Delete.
    await page.getByLabel("Manage folder Shared Notes").click();
    const sharedMenu = page.locator(".folder-menu[open]");
    await expect(sharedMenu.getByRole("button", { name: "New subfolder" })).toBeVisible();
    for (const action of ["Rename", "Move up", "Move down", "Delete"])
      await expect(sharedMenu.getByRole("button", { name: action, exact: true })).toHaveCount(0);
    await sharedMenu.getByRole("button", { name: "New subfolder" }).click();
    await page.getByRole("dialog").getByLabel("Folder name").fill("Drafts");
    await page.getByRole("dialog").getByRole("button", { name: "Create Folder" }).click();
    await expect(folderButton(page, "Drafts")).toBeVisible();
    // Inside: full organizing of the subfolder (inherited Editor rights).
    await page.getByLabel("Manage folder Drafts").click();
    await page.locator(".folder-menu[open]").getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Folder name").fill("Drafts v2");
    await page.getByRole("dialog").getByRole("button", { name: "Rename Folder" }).click();
    await expect(folderButton(page, "Drafts v2")).toBeVisible();
    await folderButton(page, "Drafts v2").click();
    await expect(page).toHaveURL(/folder=/);
    await expect(page.getByLabel("Folder access")).toContainText("Editor");
    await page.getByLabel("Manage folder Drafts v2").click();
    await page.locator(".folder-menu[open]").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete Folder" }).click();
    await expect(folderButton(page, "Drafts v2")).toHaveCount(0);
    // Deleting the open folder returns to its parent (there is no root for a recipient).
    await expect(page).toHaveURL(new RegExp(`folder=${c.shared}$`));
    // The owner still sees the whole workspace, with the recipient's changes in place.
    const tree = (await api(c.owner, c.id, "/tree")).body;
    expect(tree.folders.map((f: { name: string }) => f.name).sort()).toEqual(["Nested Labs", "Parent PARENT-SECRET", "Shared Notes", "Sibling SIBLING-SECRET"]);
    expect(tree.documents.some((d: { filename: string }) => d.filename === "answers.md")).toBe(true);
    await expectNoSecrets(page, traffic, "editor");
    expect(editor.errors).toEqual([]);
  } finally {
    await editor.context.close().catch(() => {});
  }
});

test("inherited and combined roles, live downgrade and revocation across tabs, and a graceful end of access", async ({ browser }) => {
  test.setTimeout(180_000);
  const person = await recipient(browser, "Mixed Recipient");
  try {
    // Viewer on the shared folder, Editor on its subfolder: the role follows the lesson.
    await c.share(c.shared, person.email, "viewer");
    await c.share(c.nested, person.email, "editor");
    const [first, second] = [person.page, await person.context.newPage()];
    const traffic = recordTraffic(second, recordTraffic(first));
    await first.goto(`${c.url}?folder=${c.shared}`);
    await expect(first.getByLabel("Folder access")).toContainText("Viewer");
    await expect(first.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    await second.goto(`${c.url}?folder=${c.nested}`);
    await expect(second.getByLabel("Folder access")).toContainText("Editor");
    await expect(second.getByLabel("Connection status")).toContainText("Connected");
    await expect(second.getByRole("button", { name: "New file", exact: true })).toBeVisible();
    // Shared with Me lists both folders, each with its own role.
    await first.goto("/workspaces?view=shared");
    await expect(first.locator(".shared-with-me").getByRole("article", { name: "Shared Notes" })).toContainText("Viewer");
    await expect(first.locator(".shared-with-me").getByRole("article", { name: "Nested Labs" })).toContainText("Editor");
    await first.goto(`${c.url}?folder=${c.nested}`);
    await expect(first.getByLabel("Folder access")).toContainText("Editor");
    // Downgraded live: both tabs drop to Viewer without leaving the folder.
    expect((await api(c.owner, c.id, `/folders/${c.nested}/shares/${(await api(c.owner, c.id, `/folders/${c.nested}/shares`)).body.direct.people[0].userId}`, "PATCH", { role: "viewer" })).status).toBe(200);
    for (const page of [first, second]) {
      await expect(page.getByLabel("Folder access")).toContainText("Viewer");
      await expect(page.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    }
    // The direct share on the subfolder removed: still a Viewer there through the parent.
    const shares = (await api(c.owner, c.id, `/folders/${c.nested}/shares`)).body.direct.people as { userId: string }[];
    expect((await api(c.owner, c.id, `/folders/${c.nested}/shares/${shares[0].userId}`, "DELETE")).status).toBe(200);
    await second.reload();
    await expect(second.getByLabel("Connection status")).toContainText("Live");
    await expect(second.getByLabel("Folder access")).toContainText("Viewer");
    // The last share removed: every open tab ends on the same generic screen.
    expect((await api(c.owner, c.id, `/folders/${c.shared}/shares/${shares[0].userId}`, "DELETE")).status).toBe(200);
    for (const page of [first, second]) {
      await expect(page.getByRole("region", { name: "Folder unavailable" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "This folder isn’t available" })).toBeVisible();
    }
    // Refresh after revocation: the plain not-found screen.
    await second.reload();
    await expect(second.getByText("Workspace not found", { exact: false })).toBeVisible();
    // Shared with Me no longer lists it.
    await first.getByRole("button", { name: "Shared with Me" }).click();
    await expect(first.locator(".shared-with-me")).toContainText("Nothing has been shared with you yet");
    for (const page of [first, second]) await expectNoSecrets(page, traffic, "after revocation");
    expect(person.errors).toEqual([]);
  } finally {
    await person.context.close().catch(() => {});
  }
});

test("a workspace Viewer with Editor rights on one folder keeps the workspace view and edits only in that folder", async ({ browser }) => {
  test.setTimeout(180_000);
  const member = await recipient(browser, "Workspace Viewer");
  try {
    expect((await api(c.owner, c.id, "/shares", "POST", { email: member.email, role: "viewer" })).status).toBe(201);
    await c.share(c.shared, member.email, "editor");
    const page = member.page;
    // Elsewhere: the usual view-only workspace (its name included, since they may see it).
    await page.goto(`${c.url}?folder=${c.sibling}`);
    await expect(page.getByLabel("Workspace access")).toContainText("View Only");
    await expect(page.locator(".room-title")).toContainText("Course WS-SECRET");
    await expect(page.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    // In the shared folder: editing, live; still no sharing, presence or activity.
    await folderButton(page, "Shared Notes").click();
    await expect(page.getByLabel("Workspace access")).toContainText("Editing");
    await expect(page.getByLabel("Connection status")).toContainText("Connected");
    await expect(page.getByRole("button", { name: "New file", exact: true })).toBeVisible();
    for (const label of ["Share", "Copy workspace link"])
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(page.locator(".sidebar-people, .presence-count")).toHaveCount(0);
    // Organizing: inside the shared folder only; nothing on the folder itself or elsewhere.
    await page.getByLabel("Manage folder Shared Notes").click();
    const menu = page.locator(".folder-menu[open]");
    await expect(menu.getByRole("button", { name: "New subfolder" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Manage folder Nested Labs")).toBeVisible();
    for (const name of ["Parent PARENT-SECRET", "Sibling SIBLING-SECRET"])
      await expect(page.getByLabel("Manage folder " + name)).toHaveCount(0);
    await openFromExplorer(page, "notes.md");
    await chooseDocumentView(page, "Edit");
    await page.locator(".monaco-editor textarea").focus();
    await page.keyboard.type("Member edit. ", { delay: 15 });
    await expect
      .poll(async () => (await api(c.owner, c.id, `/documents/${c.notes}/content`)).body.content as string)
      .toContain("Member edit.");
    // Back to a folder without the grant: view-only again.
    await folderButton(page, "Parent PARENT-SECRET").click();
    await expect(page.getByLabel("Workspace access")).toContainText("View Only");
    await expect(page.getByLabel("Connection status")).toContainText("Live");
    expect(member.errors).toEqual([]);
  } finally {
    await member.context.close().catch(() => {});
  }
});

test("the shared-folder view fits phones and tablets", async ({ browser }) => {
  test.setTimeout(180_000);
  const sizes = [
    { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: "tablet", viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
    { name: "laptop", viewport: { width: 1280, height: 720 } },
  ];
  const contexts: BrowserContext[] = [];
  try {
    for (const { name, ...options } of sizes) {
      const r = await recipient(browser, `Recipient ${name}`, options);
      contexts.push(r.context);
      await c.share(c.shared, r.email, "editor");
      const page = r.page;
      await page.goto("/workspaces?view=shared");
      await page.locator(".shared-with-me").getByRole("button", { name: "Open folder Shared Notes" }).click();
      await expect(page.getByLabel("Connection status")).toContainText("Connected");
      await expect(page.getByLabel("Folder access")).toBeVisible();
      // The Explorer opens on demand on small screens, with the shared folder in it.
      if (!(await page.locator(".sidebar").isVisible())) await page.getByRole("button", { name: "Toggle explorer" }).first().click();
      await expect(folderButton(page, "Shared Notes")).toBeVisible();
      await expect(page.getByLabel("Shared folder details")).toBeVisible();
      await openFromExplorer(page, "notes.md");
      await expect(page.getByLabel("Markdown preview")).toContainText("Shared notes");
      // No horizontal scrolling of the page.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name}: horizontal overflow`).toBeLessThanOrEqual(1);
      expect(r.errors).toEqual([]);
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});
