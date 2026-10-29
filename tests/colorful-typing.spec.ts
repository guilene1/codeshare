// Colourful typing: Markdown and Plain Text documents get gentle colours for headings, links,
// numbers, symbols and callout words in the editor, while the stored text never changes and
// source files keep their own highlighting.
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
// Colour and weight of the editor span holding exactly this text, or (for plain prose,
// which Monaco renders as one span per run of words) the span containing it.
const style = (page: Page, text: string) =>
  page.evaluate((text) => {
    const spans = [...document.querySelectorAll(".monaco-editor .view-lines span span")];
    const read = (span: Element) => (span.textContent ?? "").replace(/ /g, " ");
    const span = spans.find((s) => read(s).trim() === text) ?? spans.find((s) => read(s).includes(text));
    if (!span) return null;
    const s = getComputedStyle(span);
    return { color: s.color, bold: Number(s.fontWeight) >= 600, underline: s.textDecorationLine.includes("underline") };
  }, text);
const lines = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll(".monaco-editor .view-line")].map((l) => (l.textContent ?? "").replace(/ /g, " ")));

const lesson = [
  "# Getting started",
  "",
  "Python 3.12 is free. See https://docs.python.org/3/ today.",
  "NOTE: plain words stay plain -> mostly.",
  "",
  "```python",
  "total = 10 + 5",
  "```",
].join("\n");
const notes = ["SETUP STEPS", "Install it from www.python.org in 10 minutes.", "TODO: check x >= 5"].join("\n");

test("documents are colourful in the editor; the text, code files and collaboration are unchanged", async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    studentContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await signUp(owner, "Colour Owner");
    const url = await createWorkspace(owner, "Colourful notes");
    const md = await api(owner, "/documents", "POST", { filename: "lesson.md", language: "markdown", content: lesson });
    const txt = await api(owner, "/documents", "POST", { filename: "notes.txt", language: "plaintext", content: notes });
    expect([md.status, txt.status]).toEqual([201, 201]);

    // Markdown: headings, links, numbers, symbols and callouts each differ from plain prose.
    await openFromExplorer(owner, "lesson.md");
    await chooseDocumentView(owner, "Edit");
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText("Getting started");
    // Monaco colours a line a moment after first drawing it: wait for the heading.
    await expect.poll(async () => (await style(owner, "# Getting started"))?.bold).toBe(true);
    const prose = (await style(owner, " is free. See "))!;
    const heading = (await style(owner, "# Getting started"))!;
    const link = (await style(owner, "https://docs.python.org/3/"))!;
    const number = (await style(owner, "3.12"))!;
    const callout = (await style(owner, "NOTE"))!;
    const arrow = (await style(owner, "->"))!;
    for (const [name, value] of Object.entries({ heading, link, number, callout, arrow }))
      expect(value.color, name + " is coloured").not.toBe(prose.color);
    expect(heading.bold).toBe(true);
    expect(link.underline).toBe(true);
    expect(prose.bold || prose.underline).toBe(false);
    // Code fences keep their own language's colours: a Python number is coloured.
    expect((await style(owner, "10"))!.color).not.toBe(prose.color);
    // The editor shows exactly the stored text, and opening it sends no change.
    expect((await lines(owner)).slice(0, 8)).toEqual(lesson.split("\n"));
    expect((await api(owner, `/documents/${md.body.id}/content`)).body.content).toBe(lesson);

    // Plain Text notes: an ALL-CAPS heading, a link, numbers and a callout are coloured too.
    await openFromExplorer(owner, "notes.txt");
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText("SETUP STEPS");
    const notesProse = (await style(owner, "Install it from "))!;
    for (const text of ["SETUP STEPS", "www.python.org", "10", "TODO", ">="])
      await expect.poll(async () => (await style(owner, text))?.color, text).not.toBe(notesProse.color);
    expect((await api(owner, `/documents/${txt.body.id}/content`)).body.content).toBe(notes);

    // Source files keep their highlighting: an HCL keyword is still coloured.
    await openFromExplorer(owner, "main.tf");
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText("provider");
    await expect.poll(async () => (await style(owner, "provider"))?.color).not.toBe((await style(owner, "{"))?.color ?? "");

    // Typing: a new heading is coloured as you type, saved exactly, and reaches a student live.
    const student = await studentContext.newPage();
    await student.goto(url);
    await openFromExplorer(student, "lesson.md");
    await owner.getByRole("tab", { name: "lesson.md", exact: true }).click();
    await owner.locator(".monaco-editor .view-lines").click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("## Typed 2 headings", { delay: 10 });
    await expect.poll(async () => (await style(owner, "## Typed 2 headings"))?.bold).toBe(true);
    await expect.poll(async () => (await api(owner, `/documents/${md.body.id}/content`)).body.content).toBe(lesson + "\n## Typed 2 headings");
    await expect(student.getByRole("heading", { name: "Typed 2 headings" })).toBeVisible();
  } finally {
    await ownerContext.close();
    await studentContext.close();
  }
});
