// Documents open in Preview; a chosen Edit or Split view holds across files for the page
// session; the toolbar Close file button hides only the active tab and never deletes anything.
import { test, expect, type Page } from "@playwright/test";
import { chooseDocumentView, createWorkspace, openFromExplorer, signUp } from "./helpers";

async function api(page: Page, path: string, method = "GET", body?: unknown) {
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
const view = (page: Page, name: "Edit" | "Split" | "Preview") =>
  page.locator(".markdown-switch").getByRole("button", { name, exact: true });
const sourceEditor = (page: Page) => page.locator(".monaco-editor");
const preview = (page: Page) => page.locator(".markdown-preview");
async function expectView(page: Page, name: "Edit" | "Split" | "Preview") {
  await expect(view(page, name)).toHaveAttribute("aria-pressed", "true");
  await expect(sourceEditor(page)).toHaveCount(name === "Preview" ? 0 : 1);
  await expect(preview(page)).toHaveCount(name === "Edit" ? 0 : 1);
}

test("documents open in Preview; Edit or Split holds across files for the page session; reload returns to Preview; viewers stay in Preview", async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext(),
    studentContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await signUp(owner, "View Owner");
    const url = await createWorkspace(owner, "Document views");
    for (const [filename, language, content] of [
      ["guide.md", "markdown", "# Guide\n\nRead **this** first.\n"],
      ["notes.txt", "plaintext", "Plain notes\n"],
      ["extra.md", "markdown", "# Extra\n"],
    ])
      expect((await api(owner, "/documents", "POST", { filename, language, content })).status).toBe(201);

    // Markdown and Plain Text both open in Preview, with Edit and Split available.
    await openFromExplorer(owner, "guide.md");
    await expectView(owner, "Preview");
    await expect(preview(owner).locator("strong")).toHaveText("this");
    await openFromExplorer(owner, "notes.txt");
    await expectView(owner, "Preview");

    // Choosing Split holds when switching to another document, through a code file and back.
    await chooseDocumentView(owner, "Split");
    await expectView(owner, "Split");
    await openFromExplorer(owner, "extra.md");
    await expectView(owner, "Split");
    await openFromExplorer(owner, "main.tf");
    await expect(owner.locator(".markdown-switch")).toHaveCount(0); // code files have no views
    await expect(sourceEditor(owner)).toHaveCount(1);
    await owner.getByRole("tab", { name: "guide.md", exact: true }).click();
    await expectView(owner, "Split");
    // Edit holds too.
    await chooseDocumentView(owner, "Edit");
    await owner.getByRole("tab", { name: "notes.txt", exact: true }).click();
    await expectView(owner, "Edit");
    // Moving to a lesson folder keeps the choice as well.
    expect((await api(owner, "/folders", "POST", { name: "Week 1" })).status).toBe(201);
    await owner.getByRole("button", { name: "Open folder Week 1", exact: true }).click();
    await owner.getByRole("button", { name: "New file", exact: true }).first().click();
    await owner.getByLabel("Filename", { exact: true }).fill("week.md");
    await owner.getByRole("dialog").getByRole("button", { name: "Create file", exact: true }).click();
    await expect(owner.getByRole("tab", { name: "week.md", exact: true })).toHaveAttribute("aria-selected", "true");
    await expectView(owner, "Edit");

    // A reload starts in Preview again.
    await owner.goto(url);
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    await openFromExplorer(owner, "guide.md");
    await expectView(owner, "Preview");

    // Students only ever get Preview, with no view switch.
    const student = await studentContext.newPage();
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await openFromExplorer(student, "guide.md");
    await expect(preview(student).locator("strong")).toHaveText("this");
    await expect(student.locator(".markdown-switch")).toHaveCount(0);
    await expect(sourceEditor(student)).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await studentContext.close();
  }
});

test("the toolbar Close file button closes only the active tab, like the tab X and Alt+W, and never deletes a document", async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext(),
    studentContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await signUp(owner, "Close Owner");
    const url = await createWorkspace(owner, "Closing tabs");
    const ids: Record<string, string> = {};
    for (const [filename, language, content] of [
      ["one.md", "markdown", "# One\n"],
      ["two.txt", "plaintext", "Two\n"],
      ["three.md", "markdown", "# Three\n"],
    ]) {
      const created = await api(owner, "/documents", "POST", { filename, language, content });
      expect(created.status).toBe(201);
      ids[filename] = created.body.id;
    }
    const documents = async () =>
      (await api(owner, "/tree")).body.documents.map((d: { id: string; filename: string }) => d.id + " " + d.filename).sort();
    const before = await documents();
    expect(before.length).toBeGreaterThanOrEqual(4);
    for (const name of ["one.md", "two.txt", "three.md"]) await openFromExplorer(owner, name);
    const tabs = () => owner.getByRole("tab").allTextContents();
    expect((await tabs()).map((t) => t.trim())).toEqual(["main.tf", "one.md", "two.txt", "three.md"]);

    // The student has three.md open too.
    const student = await studentContext.newPage();
    await student.goto(url);
    await openFromExplorer(student, "three.md");

    // Small, labelled, with a tooltip, beside the view switch.
    const close = owner.getByRole("button", { name: "Close current file", exact: true });
    await expect(close).toHaveAttribute("title", "Close file (Alt+W)");
    expect(await close.evaluate((b) => b.previousElementSibling?.classList.contains("markdown-switch"))).toBe(true);
    const box = (await close.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(32);
    expect(box.height).toBeLessThanOrEqual(32);

    // It closes only the active tab; the next tab becomes active.
    await close.click();
    expect((await tabs()).map((t) => t.trim())).toEqual(["main.tf", "one.md", "two.txt"]);
    await expect(owner.getByRole("tab", { name: "two.txt", exact: true })).toHaveAttribute("aria-selected", "true");
    // Nothing is deleted: the file stays in the Explorer and on the server, unchanged,
    // and the student's tab is untouched.
    await expect(owner.locator(".sidebar").getByRole("button", { name: "three.md", exact: true })).toBeVisible();
    const content = await api(owner, `/documents/${ids["three.md"]}/content`);
    expect(content.status).toBe(200);
    expect(JSON.stringify(content.body)).toContain("# Three");
    await expect(student.getByRole("tab", { name: "three.md", exact: true })).toHaveAttribute("aria-selected", "true");

    // Code files have it too.
    await owner.getByRole("tab", { name: "main.tf", exact: true }).click();
    await close.click();
    expect((await tabs()).map((t) => t.trim())).toEqual(["one.md", "two.txt"]);
    // The tab X and Alt+W still work.
    await owner.getByRole("button", { name: "Close one.md", exact: true }).click();
    expect((await tabs()).map((t) => t.trim())).toEqual(["two.txt"]);
    await owner.keyboard.press("Alt+w");
    await expect(owner.getByRole("tab")).toHaveCount(0);
    // No open file, no Close button.
    await expect(close).toHaveCount(0);
    await expect(owner.getByText("No files are open.")).toBeVisible();
    // Every document still exists, with the same IDs.
    expect(await documents()).toEqual(before);

    // Students can close their own tab the same way; the owner's workspace is unaffected.
    await student.getByRole("button", { name: "Close current file", exact: true }).click();
    await expect(student.getByRole("tab", { name: "three.md", exact: true })).toHaveCount(0);
    await expect(owner.locator(".sidebar").getByRole("button", { name: "three.md", exact: true })).toBeVisible();
  } finally {
    await ownerContext.close();
    await studentContext.close();
  }
});
