// Large documents in the browser: real clipboard pastes up to 1 MB, LF line endings on Windows,
// the 1 MB limit message, live API updates in an open editor with conflict handling, and the
// "code block into a new lesson" flow that posts content over REST.
import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createWorkspace, signUp } from "./helpers";

const KB = 1024;
function code(bytes: number, seed = "") {
  let out = "";
  for (let i = 0; out.length < bytes; i++)
    out += `  const item_${seed}${i} = { name: "value-${i}", path: "/srv/app/${i}" }; // note\n`;
  return out.slice(0, bytes);
}
// Reads what the server saved, straight from the test database.
const saved = (workspace: string, filename: string) => {
  const db = new DatabaseSync("data/e2e.sqlite", { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT content FROM documents WHERE room_id=? AND filename=?")
        .get(workspace, filename) as { content: string } | undefined
    )?.content;
  } finally {
    db.close();
  }
};
async function newFile(page: Page, name: string) {
  await page.getByRole("button", { name: "New file", exact: true }).first().click();
  await page.getByLabel("Filename", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create file", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".monaco-editor .view-lines").first().click();
}
// The owner's API calls from inside the page (session cookie + CSRF), like any API client.
function api(page: Page, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(
    async ({ path, method, body, headers }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const response = await fetch(`/api/rooms/${id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, method, body, headers },
  );
}

// One workspace (workspace creation is rate limited); each size goes in its own folder, which
// is a separate lesson with its own 2 MB budget.
test("clipboard pastes of 8 KB to 1 MB are saved exactly, with LF line endings", async ({ page, context }) => {
  test.setTimeout(400_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signUp(page, "Paste Owner");
  const url = await createWorkspace(page, "Paste sizes");
  const workspace = url.split("/").pop()!;
  for (const kb of [8, 16, 32, 64, 128, 256, 512, 1024]) {
    const folder = await api(page, "/folders", "POST", { name: `Size ${kb} KB` });
    expect(folder.status).toBe(201);
    await page.goto(`${url}?folder=${folder.body.id}`);
    await expect(page.locator(".status-bar")).toContainText("Connected");
    await newFile(page, `big-${kb}.txt`);
    const content = code(kb * KB, String(kb));
    // A real paste (Ctrl+V): on Windows the clipboard hands the editor CRLF line endings.
    await page.evaluate((text) => navigator.clipboard.writeText(text), content);
    await page.keyboard.press("Control+V");
    await expect
      .poll(() => saved(workspace, `big-${kb}.txt`)?.length, { timeout: 60_000, message: `${kb} KB` })
      .toBe(content.length);
    expect(saved(workspace, `big-${kb}.txt`), `${kb} KB exact`).toBe(content);
    await expect(page.locator(".connection-warning[role=alert]")).toHaveCount(0);
  }
});

test("typing Enter in a new file stores LF, and a paste over 1 MB is refused clearly", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signUp(page, "Limit Owner");
  const workspace = (await createWorkspace(page, "Limits")).split("/").pop()!;
  await newFile(page, "typed.txt");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await expect.poll(() => saved(workspace, "typed.txt")).toBe("one\ntwo");

  await newFile(page, "too-big.txt");
  await page.evaluate((text) => navigator.clipboard.writeText(text), code(1024 * KB + 2048));
  await page.keyboard.press("Control+V");
  await expect(page.locator(".connection-warning[role=alert]")).toContainText("Files can be up to 1 MB", {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  expect(saved(workspace, "too-big.txt")).toBe("");
});

test("API updates appear live in an open editor; stale API writes are refused; reload keeps content", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Sync Owner");
  const workspace = (await createWorkspace(page, "Live sync")).split("/").pop()!;
  const created = await api(page, "/documents", "POST", { filename: "notes.txt", language: "plaintext", content: "start\n" });
  expect(created.status).toBe(201);
  await page.locator(".sidebar").getByRole("button", { name: "notes.txt", exact: true }).click();
  await expect(page.getByRole("tab", { name: "notes.txt", exact: true })).toHaveAttribute("aria-selected", "true");

  // A 300 KB replacement through the content API shows up in the open editor.
  const big = "Updated by the API\n" + code(300 * KB);
  const put = await api(page, `/documents/${created.body.id}/content`, "PUT", { content: big }, { "if-match": created.body.version });
  expect(put.status).toBe(200);
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Updated by the API", { timeout: 15_000 });
  await expect.poll(() => saved(workspace, "notes.txt")).toBe(big);

  // The browser edits; an API write based on the old version is refused and nothing is lost.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("browser ");
  await expect.poll(() => saved(workspace, "notes.txt")?.startsWith("browser Updated by the API")).toBe(true);
  const stale = await api(page, `/documents/${created.body.id}/content`, "PUT", { content: "overwrite" }, { "if-match": put.body.version });
  expect(stale.status).toBe(409);
  expect(saved(workspace, "notes.txt")?.startsWith("browser Updated by the API")).toBe(true);

  // Reload: the content is still there, and the API reads exactly what was saved.
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  const read = await api(page, `/documents/${created.body.id}/content`);
  expect(read.status).toBe(200);
  expect(read.body.content).toBe(saved(workspace, "notes.txt"));
  expect(read.body.content.startsWith("browser Updated by the API")).toBe(true);

  // "Add code block → new lesson" posts the block over REST: no longer limited to 16 KB.
  for (const kb of [8, 16, 32, 60]) {
    const content = "```shell\n" + code(kb * KB) + "\n```\n";
    const lesson = await api(page, "/documents", "POST", { filename: `lesson-${kb}.md`, language: "markdown", content });
    expect(lesson.status, `${kb} KB block as a new lesson`).toBe(201);
  }
});

test("opening a single-line file sends no edit, for editors and anonymous viewers", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page, "Open Owner");
  const url = await createWorkspace(page, "Open only");
  const workspace = url.split("/").pop()!;
  const created = await api(page, "/documents", "POST", { filename: "one-line.py", language: "python", content: 'print("hello")' });
  expect(created.status).toBe(201);
  await page.locator(".sidebar").getByRole("button", { name: "one-line.py", exact: true }).click();
  await expect(page.getByRole("tab", { name: "one-line.py", exact: true })).toHaveAttribute("aria-selected", "true");
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await viewer.locator(".sidebar").getByRole("button", { name: "one-line.py", exact: true }).click();
    await expect(viewer.locator(".monaco-editor .view-lines").first()).toContainText("hello");
    await page.waitForTimeout(2000);
    // The viewer stayed connected (a write would have been refused and disconnected it).
    await expect(viewer.locator(".connection-warning")).toHaveCount(0);
    await expect(viewer.getByLabel("Connection status")).toContainText("Live");
  } finally {
    await context.close();
  }
  expect(saved(workspace, "one-line.py")).toBe('print("hello")');
  const activity = await api(page, "/activity");
  expect(activity.body.entries.filter((e: { action: string }) => e.action === "file.edited")).toEqual([]);
});
