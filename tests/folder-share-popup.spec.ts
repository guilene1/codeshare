// Folder sharing, Phase 5: the Share Folder popup. Workspace sharing managers (the owner and
// direct Editors) share one folder with accounts and teams from the folder's menu; inherited
// grants are shown read-only with the parent folder they come from; changes reach the
// recipients' open tabs at once. Nobody else gets the action, and the server refuses them too.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch(`/api${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}
type Account = { context: BrowserContext; page: Page; email: string; errors: string[] };
async function account(browser: Browser, name: string, options: Parameters<Browser["newContext"]>[0] = {}): Promise<Account> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, "-"));
  await signUp(page, name, email);
  return { context, page, email, errors };
}
async function joinTeam(owner: Page, team: string, member: Account) {
  expect((await api(owner, `/teams/${team}/invitations`, "POST", { email: member.email })).status).toBe(201);
  for (const invitation of (await api(member.page, "/me/invitations")).body.invitations)
    expect((await api(member.page, `/me/invitations/${invitation.id}/accept`, "POST", {})).status).toBe(200);
}
const folderButton = (page: Page, name: string) =>
  page.locator(".sidebar").getByRole("button", { name: "Open folder " + name, exact: true });
async function openShareFolder(page: Page, name: string) {
  await page.getByLabel("Manage folder " + name).click();
  await page.locator(".folder-menu[open]").getByRole("button", { name: "Share folder" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Share folder “${name}”` })).toBeVisible();
  return dialog;
}

// One Restricted course for the file, in order (the server keeps at most 16 lessons in memory).
test.describe.configure({ mode: "serial" });
let owner: Account, id: string, url: string, shared: string, nested: string, sibling: string;
const contexts: BrowserContext[] = [];
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  owner = await account(browser, "Popup Owner", { permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(owner.context);
  url = await createWorkspace(owner.page, "Popup Course");
  id = url.split("/w/")[1];
  const folder = async (name: string, parent_id?: string) =>
    (await api(owner.page, `/rooms/${id}/folders`, "POST", { name, parent_id })).body.id as string;
  const parent = await folder("Parent");
  shared = await folder("Shared Notes", parent);
  nested = await folder("Nested Labs", shared);
  sibling = await folder("Sibling", parent);
  expect((await api(owner.page, `/rooms/${id}/documents?folder=${shared}`, "POST", { filename: "notes.md", language: "markdown", content: "# Notes\n" })).status).toBe(201);
  await owner.page.reload();
  await expect(owner.page.locator(".status-bar")).toContainText("Connected");
});
test.afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => {});
});

test("the owner shares a folder with an account and a team, sees inherited access read-only, and changes and revokes it live", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = owner.page;
  const reader = await account(browser, "Folder Reader");
  const member = await account(browser, "Team Member");
  contexts.push(reader.context, member.context);
  const team = (await api(page, "/teams", "POST", { name: "Lab Partners" })).body.id as string;
  await joinTeam(page, team, member);
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  // No indicator before anything is shared.
  await expect(folderButton(page, "Shared Notes").getByRole("img", { name: "Shared folder" })).toHaveCount(0);
  // Keyboard: the folder menu opens with Enter and its Share folder item is a real button.
  await page.getByLabel("Manage folder Shared Notes").focus();
  await page.keyboard.press("Enter");
  const item = page.locator(".folder-menu[open]").getByRole("button", { name: "Share folder" });
  await item.focus();
  await page.keyboard.press("Enter");
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Share folder “Shared Notes”" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  dialog = await openShareFolder(page, "Shared Notes");
  // The folder link (only IDs) copies, from either control. The two controls have distinct
  // accessible names (screen readers compare names without case).
  const folderLink = `${new URL(url).origin}/w/${id}?folder=${shared}`;
  const copyControls = dialog.locator('section[aria-label="Folder link"] button');
  const names = await copyControls.evaluateAll((buttons) =>
    buttons.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().toLowerCase()),
  );
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
  for (const name of ["Copy link from the Folder link field", "Copy Folder Link"]) {
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await dialog.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".toast")).toContainText("Folder link copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(folderLink);
  }
  // Meaningful errors: an invalid email, an email without an account.
  const people = dialog.getByRole("region", { name: "People with access" });
  const email = people.getByLabel("Email address");
  await email.fill("not-an-email");
  await people.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.getByRole("alert")).toContainText("Enter a complete email address");
  await email.fill(uniqueEmail("nobody"));
  await people.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.getByRole("alert")).toContainText("No Kodelumi account uses that email");
  // Shared as Viewer: listed as direct access.
  await email.fill(reader.email);
  await people.getByLabel("Permission", { exact: true }).selectOption("viewer");
  await people.getByRole("button", { name: "Share", exact: true }).click();
  const direct = people.getByRole("list", { name: "People with direct access" });
  await expect(direct).toContainText("Folder Reader");
  await expect(direct.getByLabel("Permission for Folder Reader")).toHaveValue("viewer");
  await expect(email).toHaveValue("");
  // Sharing again with the same person explains instead of duplicating.
  await email.fill(reader.email.toUpperCase());
  await people.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.getByRole("alert")).toContainText("Folder Reader already has Viewer access");
  await expect(direct.getByRole("listitem")).toHaveCount(1);
  await email.fill("");
  // A team the owner belongs to, as Editor.
  const teams = dialog.getByRole("region", { name: "Teams with access" });
  await teams.getByLabel("Team", { exact: true }).selectOption({ label: "Lab Partners" });
  await teams.getByLabel("Team permission").selectOption("editor");
  await teams.getByRole("button", { name: "Share", exact: true }).click();
  await expect(teams.getByRole("list", { name: "Teams with direct access" })).toContainText("Lab Partners");
  await expect(teams.getByLabel("Team", { exact: true })).toBeDisabled(); // every team has access now
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  // The Explorer marks the shared folder, and nothing else.
  await expect(folderButton(page, "Shared Notes").getByRole("img", { name: "Shared folder" })).toBeVisible();
  for (const other of ["Parent", "Nested Labs", "Sibling"])
    await expect(folderButton(page, other).getByRole("img", { name: "Shared folder" })).toHaveCount(0);
  // The subfolder lists both grants as inherited, read-only, from the shared folder.
  dialog = await openShareFolder(page, "Nested Labs");
  const inheritedPeople = dialog.getByRole("list", { name: "People with inherited access" });
  await expect(inheritedPeople).toContainText("Folder Reader");
  await expect(inheritedPeople).toContainText("From “Shared Notes”");
  await expect(inheritedPeople).toContainText("Viewer");
  await expect(inheritedPeople.getByRole("combobox")).toHaveCount(0);
  await expect(inheritedPeople.getByRole("button")).toHaveCount(0);
  const inheritedTeams = dialog.getByRole("list", { name: "Teams with inherited access" });
  await expect(inheritedTeams).toContainText("Lab Partners");
  await expect(inheritedTeams).toContainText("Editor");
  await expect(dialog.getByRole("list", { name: "People with direct access" })).toHaveCount(0);
  // ...and the server refuses changing them from the child too.
  const readerId = (await api(page, `/rooms/${id}/folders/${shared}/shares`)).body.direct.people[0].userId;
  const refused = await api(page, `/rooms/${id}/folders/${nested}/shares/${readerId}`, "DELETE");
  expect([refused.status, refused.body.inheritedFrom.name]).toEqual([409, "Shared Notes"]);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  // The recipients: a Viewer, and a team Editor (through Shared with Me).
  await reader.page.goto(`${url}?folder=${shared}`);
  await expect(reader.page.getByLabel("Folder access")).toContainText("Viewer");
  await member.page.goto("/workspaces?view=shared");
  await member.page.locator(".shared-with-me").getByRole("button", { name: "Open folder Shared Notes" }).click();
  await expect(member.page.getByLabel("Folder access")).toContainText("Editor");
  // Role change from the popup: the reader's open tab becomes an Editor at once.
  dialog = await openShareFolder(page, "Shared Notes");
  await dialog.getByLabel("Permission for Folder Reader").selectOption("editor");
  await expect(reader.page.getByLabel("Folder access")).toContainText("Editor");
  await expect(reader.page.getByRole("button", { name: "New file", exact: true })).toBeVisible();
  // Revocation asks first; Cancel keeps the share.
  await dialog.getByRole("button", { name: "Remove Folder Reader" }).click();
  const confirm = dialog.getByRole("group", { name: "Confirm folder access removal" });
  await expect(confirm).toContainText("Remove Folder Reader’s access to this folder?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByRole("list", { name: "People with direct access" })).toContainText("Folder Reader");
  await dialog.getByRole("button", { name: "Remove Folder Reader" }).click();
  await confirm.getByRole("button", { name: "Remove access" }).click();
  await expect(dialog.getByRole("region", { name: "People with access" })).toContainText("Not shared with any accounts yet.");
  await expect(reader.page.getByRole("heading", { name: "This folder isn’t available" })).toBeVisible();
  // The team share too: its member's tab ends the same way.
  await dialog.getByRole("button", { name: "Remove Lab Partners" }).click();
  await dialog.getByRole("group", { name: "Confirm folder access removal" }).getByRole("button", { name: "Remove access" }).click();
  await expect(dialog.getByRole("region", { name: "Teams with access" })).toContainText("Not shared with any teams yet.");
  await expect(member.page.getByRole("heading", { name: "This folder isn’t available" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(folderButton(page, "Shared Notes").getByRole("img", { name: "Shared folder" })).toHaveCount(0);
  for (const a of [owner, reader, member]) expect(a.errors).toEqual([]);
});

test("Restricted only: while a folder is shared the workspace can't become Anyone with the link, and an open workspace explains instead of sharing", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = owner.page;
  const reader = await account(browser, "Restricted Reader");
  contexts.push(reader.context);
  expect((await api(page, `/rooms/${id}/folders/${sibling}/shares`, "POST", { email: reader.email, role: "viewer" })).status).toBe(201);
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog");
  await expect(share.getByLabel("General access")).toHaveValue("private");
  // (A disabled <option>: read the DOM property, which is what the browser enforces.)
  await expect.poll(() => share.locator('option[value="link"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  await expect(share).toContainText("A folder is shared on its own, so this workspace stays Restricted.");
  await share.getByRole("button", { name: "Close dialog" }).click();
  const blocked = await api(page, `/rooms/${id}/visibility`, "PUT", { visibility: "link" });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toContain("Remove those folder shares");
  expect((await api(page, `/rooms/${id}`)).body.visibility).toBe("private");
  // Once the share is gone, the choice is back.
  const readerId = (await api(page, `/rooms/${id}/folders/${sibling}/shares`)).body.direct.people[0].userId;
  expect((await api(page, `/rooms/${id}/folders/${sibling}/shares/${readerId}`, "DELETE")).status).toBe(200);
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect.poll(() => page.getByRole("dialog").locator('option[value="link"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(false);
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  // A workspace open to anyone with the link: the popup explains and offers no sharing.
  const openUrl = await createWorkspace(page, "Open Popup Course", { studentLink: true });
  const openId = openUrl.split("/w/")[1];
  expect((await api(page, `/rooms/${openId}/folders`, "POST", { name: "Week 1" })).status).toBe(201);
  await expect(folderButton(page, "Week 1")).toBeVisible();
  const dialog = await openShareFolder(page, "Week 1");
  await expect(dialog.getByRole("region", { name: "Folder sharing unavailable" })).toContainText("only when the workspace’s General access is Restricted");
  await expect(dialog.getByLabel("Email address")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy Folder Link", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  expect((await api(page, `/rooms/${openId}`)).body.visibility).toBe("link"); // unchanged
  // Back to the main course for the next tests.
  await page.goto(url);
  await expect(page.locator(".status-bar")).toContainText("Connected");
  expect(owner.errors).toEqual([]);
});

test("shared-folder marks update at once in every sharing manager's open tabs, and in nobody else's", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = owner.page;
  const manager = await account(browser, "Second Manager");
  const watcher = await account(browser, "Team Watcher");
  const recipient = await account(browser, "Mark Recipient");
  contexts.push(manager.context, watcher.context, recipient.context);
  expect((await api(page, `/rooms/${id}/shares`, "POST", { email: manager.email, role: "editor" })).status).toBe(201);
  const crew = (await api(page, "/teams", "POST", { name: "Crew" })).body.id as string;
  await joinTeam(page, crew, watcher);
  expect((await api(page, `/rooms/${id}/team-shares`, "POST", { teamId: crew, role: "editor" })).status).toBe(201);
  // Open tabs: the owner's second tab, a direct Editor (a manager) and a team-derived Editor.
  const otherTab = await owner.context.newPage();
  const pageErrors: string[] = [];
  otherTab.on("pageerror", (e) => pageErrors.push(e.message));
  for (const p of [page, otherTab, manager.page, watcher.page]) {
    await p.goto(url);
    await expect(p.locator(".status-bar")).toContainText("Connected");
    await expect(folderButton(p, "Sibling")).toBeVisible();
  }
  const mark = (p: Page) => folderButton(p, "Sibling").getByRole("img", { name: "Shared folder" });
  for (const p of [page, otherTab, manager.page, watcher.page]) await expect(mark(p)).toHaveCount(0);
  // The owner shares from the popup: every manager tab shows the mark without reloading.
  const dialog = await openShareFolder(page, "Sibling");
  const people = dialog.getByRole("region", { name: "People with access" });
  await people.getByLabel("Email address").fill(recipient.email);
  await people.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.getByRole("list", { name: "People with direct access" })).toContainText("Mark Recipient");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  for (const p of [page, otherTab, manager.page]) await expect(mark(p)).toBeVisible();
  // While it's shared, the other tab's Share popup already blocks Anyone with the link.
  await otherTab.getByRole("button", { name: "Share", exact: true }).click();
  await expect.poll(() => otherTab.getByRole("dialog").locator('option[value="link"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  await otherTab.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  // The direct Editor removes it: the owner's tabs follow at once.
  const recipientId = (await api(manager.page, `/rooms/${id}/folders/${sibling}/shares`)).body.direct.people[0].userId;
  expect((await api(manager.page, `/rooms/${id}/folders/${sibling}/shares/${recipientId}`, "DELETE")).status).toBe(200);
  for (const p of [page, otherTab, manager.page]) await expect(mark(p)).toHaveCount(0);
  // A team-derived Editor never sees marks (nor asks for them).
  await watcher.page.waitForTimeout(500);
  await expect(watcher.page.locator(".shared-mark")).toHaveCount(0);
  expect((await api(watcher.page, `/rooms/${id}/folder-shares`)).status).toBe(403);
  // Clean up: the next test sets up its own roles.
  expect((await api(page, `/rooms/${id}/team-shares/${crew}`, "DELETE")).status).toBe(200);
  expect((await api(page, `/rooms/${id}/shares/${(await api(page, `/rooms/${id}/shares`)).body.shares.find((s: { email: string }) => s.email === manager.email).userId}`, "DELETE")).status).toBe(200);
  await otherTab.close();
  for (const errors of [owner.errors, pageErrors, manager.errors, watcher.errors]) expect(errors).toEqual([]);
});

test("only the owner and direct Editors get Share folder; team-derived Editors, Edit Link guests, Viewers and folder-only Editors don't", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = owner.page;
  const directEditor = await account(browser, "Direct Editor");
  const teamEditor = await account(browser, "Team Editor");
  const viewer = await account(browser, "Workspace Viewer");
  const folderEditor = await account(browser, "Folder Editor");
  contexts.push(directEditor.context, teamEditor.context, viewer.context, folderEditor.context);
  expect((await api(page, `/rooms/${id}/shares`, "POST", { email: directEditor.email, role: "editor" })).status).toBe(201);
  expect((await api(page, `/rooms/${id}/shares`, "POST", { email: viewer.email, role: "viewer" })).status).toBe(201);
  const staff = (await api(page, "/teams", "POST", { name: "Staff" })).body.id as string;
  await joinTeam(page, staff, teamEditor);
  expect((await api(page, `/rooms/${id}/team-shares`, "POST", { teamId: staff, role: "editor" })).status).toBe(201);
  expect((await api(page, `/rooms/${id}/folders/${shared}/shares`, "POST", { email: folderEditor.email, role: "editor" })).status).toBe(201);
  const editLink = (await api(page, `/rooms/${id}/editor-link`, "POST", {})).body.token as string;
  const guestContext = await browser.newContext();
  contexts.push(guestContext);
  const guest = await guestContext.newPage();
  const shareItem = async (p: Page, folder: string) => {
    // The tree loads separately from the access badge: wait for the folder itself, so "no
    // menu" means no menu, not "not loaded yet".
    await expect(folderButton(p, folder)).toBeVisible();
    const menu = p.getByLabel("Manage folder " + folder);
    if (!(await menu.count())) return "no menu";
    await menu.click();
    const count = await p.locator(".folder-menu[open]").getByRole("button", { name: "Share folder" }).count();
    await menu.click();
    return count ? "share folder" : "menu without share";
  };
  // The direct Editor: the action, and it works.
  await directEditor.page.goto(url);
  await expect(directEditor.page.getByLabel("Workspace access")).toContainText("Editing");
  expect(await shareItem(directEditor.page, "Sibling")).toBe("share folder");
  const dialog = await openShareFolder(directEditor.page, "Sibling");
  const people = dialog.getByRole("region", { name: "People with access" });
  await people.getByLabel("Email address").fill(viewer.email);
  await people.getByLabel("Permission", { exact: true }).selectOption("editor");
  await people.getByRole("button", { name: "Share", exact: true }).click();
  await expect(people.getByRole("list", { name: "People with direct access" })).toContainText("Workspace Viewer");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  // Everyone else: no Share folder item (a team-derived Editor still organizes folders).
  await teamEditor.page.goto(url);
  await expect(teamEditor.page.getByLabel("Workspace access")).toContainText("Editing");
  expect(await shareItem(teamEditor.page, "Sibling")).toBe("menu without share");
  await guest.goto(`${url}/edit/${editLink}`);
  await guest.getByLabel("Your name").fill("Guest");
  await guest.getByRole("button", { name: "Open Workspace", exact: true }).click();
  await expect(guest.getByLabel("Workspace access")).toContainText("Editing");
  expect(await shareItem(guest, "Sibling")).toBe("menu without share");
  await viewer.page.goto(url);
  await expect(viewer.page.getByLabel("Workspace access")).toContainText("View Only");
  // (Live means their folder grants are loaded: the page reads them before connecting.)
  await expect(viewer.page.getByLabel("Connection status")).toContainText("Live");
  expect(await shareItem(viewer.page, "Shared Notes")).toBe("no menu");
  // (With Editor rights on Sibling from the direct Editor's share, it may organize there,
  // but still never share it.)
  expect(await shareItem(viewer.page, "Sibling")).toBe("menu without share");
  await folderEditor.page.goto(`${url}?folder=${shared}`);
  await expect(folderEditor.page.getByLabel("Folder access")).toContainText("Editor");
  expect(await shareItem(folderEditor.page, "Shared Notes")).toBe("menu without share");
  expect(await shareItem(folderEditor.page, "Nested Labs")).toBe("menu without share");
  // No indicators for them either, and the server refuses their attempts.
  for (const p of [teamEditor.page, guest, viewer.page])
    await expect(p.locator(".sidebar").getByRole("img", { name: "Shared folder" })).toHaveCount(0);
  for (const [who, p, status] of [["team Editor", teamEditor.page, 403], ["viewer", viewer.page, 403], ["folder Editor", folderEditor.page, 404]] as const) {
    const r = await api(p, `/rooms/${id}/folders/${shared}/shares`);
    expect(r.status, who).toBe(status);
    expect(JSON.stringify(r.body), who).not.toContain("Workspace Viewer");
  }
  const guestTry = await guest.evaluate(
    async ({ id, shared, editLink }) =>
      (await fetch(`/api/rooms/${id}/folders/${shared}/shares`, { headers: { authorization: "Bearer " + editLink } })).status,
    { id, shared, editLink },
  );
  expect(guestTry).toBe(403);
  for (const a of [directEditor, teamEditor, viewer, folderEditor]) expect(a.errors).toEqual([]);
});

test("the Share Folder popup fits phones, tablets and desktops", async ({ browser }) => {
  test.setTimeout(180_000);
  for (const { name, ...options } of [
    { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: "tablet", viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
    { name: "desktop", viewport: { width: 1280, height: 720 } },
  ]) {
    const context = await browser.newContext({ ...options, storageState: await owner.context.storageState() });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(".status-bar")).toContainText("Connected");
    if (!(await page.locator(".sidebar").isVisible())) await page.getByRole("button", { name: "Toggle explorer" }).first().click();
    const dialog = await openShareFolder(page, "Nested Labs");
    await expect(dialog.getByRole("region", { name: "People with access" }).getByLabel("Email address")).toBeVisible();
    // The popup stays within the screen and never scrolls sideways.
    const box = (await dialog.boundingBox())!;
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(options.viewport.width + 1);
    expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth), `${name}: sideways scroll`).toBeLessThanOrEqual(1);
    for (const control of ["Email address", "Permission"])
      expect(await dialog.getByRole("region", { name: "People with access" }).getByLabel(control, { exact: true }).isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await context.close();
  }
});
