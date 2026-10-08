import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

// Simulates a browser that once switched line numbers off in the old settings.
const stalePreference = () =>
  localStorage.setItem(
    "devshare.settings",
    JSON.stringify({ lineNumbers: false, fontSize: 14 }),
  );

async function gutter(page: Page) {
  const editor = page.locator(".monaco-editor").first();
  await expect(editor.locator(".margin .line-numbers").first()).toBeVisible();
  return editor.evaluate((node) => {
    const numbers = [...node.querySelectorAll(".margin .line-numbers")].map(
      (n) => ({ text: (n.textContent ?? "").trim(), top: n.getBoundingClientRect().top }),
    );
    const sample = node.querySelector(".margin .line-numbers") as HTMLElement;
    return {
      numbers: numbers.sort((a, b) => a.top - b.top).map((n) => n.text),
      color: getComputedStyle(sample).color,
      background: getComputedStyle(node.querySelector(".monaco-editor-background")!).backgroundColor,
    };
  });
}
async function createFile(page: Page, filename: string, content = "") {
  return page.evaluate(
    async ({ filename, content }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const ext = filename.split(".").pop();
      const language =
        { txt: "plaintext", md: "markdown", yaml: "yaml", py: "python", tf: "hcl" }[ext!] ?? "plaintext";
      const response = await fetch(`/api/rooms/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ filename, language, content }),
      });
      return response.status;
    },
    { filename, content },
  );
}
async function open(page: Page, filename: string) {
  await page.locator(".sidebar").getByRole("button", { name: filename, exact: true }).click();
  await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("line numbers show in every file type, both themes, while scrolling, and for students", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const instructor = await browser.newContext(),
    student = await browser.newContext();
  await instructor.addInitScript(stalePreference);
  await student.addInitScript(stalePreference);
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Line numbers");
    const files: Array<[string, string]> = [
      ["notes.txt", "First note\nSecond note\nThird note"],
      ["lesson.md", "# Lesson\n\nSome text\n\n```bash\nls\n```"],
      ["config.yaml", "name: demo\nreplicas: 2\nimage: nginx"],
      ["app.py", Array.from({ length: 150 }, (_, i) => `print(${i + 1})`).join("\n")],
    ];
    for (const [name, content] of files) expect(await createFile(owner, name, content)).toBe(201);
    for (const name of ["main.tf", "notes.txt", "lesson.md", "config.yaml", "app.py"]) {
      await open(owner, name);
      if (name.endsWith(".md") || name.endsWith(".txt"))
        await owner.getByRole("button", { name: "Edit", exact: true }).click();
      const { numbers, color, background } = await gutter(owner);
      expect(numbers.slice(0, 3), name).toEqual(["1", "2", "3"]);
      expect(color, name).not.toBe(background);
    }
    await owner.screenshot({ path: "test-results/line-numbers-dark.png" });
    // Light theme.
    await owner.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(owner.locator("html")).toHaveAttribute("data-theme", "light");
    const light = await gutter(owner);
    expect(light.numbers.slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(light.color).not.toBe(light.background);
    await owner.screenshot({ path: "test-results/line-numbers-light.png" });
    // Scrolling keeps each number aligned with its line (app.py line N prints N).
    await owner.locator(".monaco-editor .view-lines").first().hover();
    await owner.mouse.wheel(0, 1800);
    await expect
      .poll(async () => (await gutter(owner)).numbers[0])
      .not.toBe("1");
    const aligned = await owner.locator(".monaco-editor").first().evaluate((node) => {
      const lines = [...node.querySelectorAll(".view-line")].map((line) => ({
        top: Math.round(line.getBoundingClientRect().top),
        text: (line.textContent ?? "").replace(/ /g, " "),
      }));
      return [...node.querySelectorAll(".margin .line-numbers")].every((number) => {
        const top = Math.round(number.getBoundingClientRect().top);
        const line = lines.find((l) => Math.abs(l.top - top) <= 2);
        return !line || line.text === `print(${(number.textContent ?? "").trim()})`;
      });
    });
    expect(aligned).toBe(true);
    // Editing keeps numbering consistent.
    await owner.locator(".monaco-editor .view-lines").first().click();
    await owner.keyboard.press("Control+Home");
    await owner.keyboard.press("Enter");
    await expect.poll(async () => (await gutter(owner)).numbers.slice(0, 3)).toEqual(["1", "2", "3"]);
    // Line 2 now holds print(1): numbering follows the edit.
    const second = await owner.locator(".monaco-editor .view-line").evaluateAll((lines) =>
      lines
        .map((l) => ({ top: l.getBoundingClientRect().top, text: (l.textContent ?? "").replace(/ /g, " ") }))
        .sort((a, b) => a.top - b.top)[1].text,
    );
    expect(second).toBe("print(1)");
    await owner.keyboard.press("Control+z");
    // The line numbers switch is gone from settings.
    await owner.getByRole("button", { name: "Editor settings", exact: true }).click();
    await expect(owner.getByRole("dialog").getByText("Line numbers", { exact: true })).toHaveCount(0);
    await owner.getByRole("button", { name: "Done", exact: true }).click();
    // Three-backtick blocks still work alongside the gutter.
    await open(owner, "notes.txt");
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await owner.locator(".monaco-editor .view-lines").first().click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("```", { delay: 40 });
    await expect(owner.locator(".monaco-editor .doc-block-toolbar")).toHaveCount(1);
    await expect(owner.locator(".monaco-editor .doc-block-toolbar").getByRole("button", { name: "Copy code" })).toBeVisible();
    expect((await gutter(owner)).numbers.slice(0, 6)).toEqual(["1", "2", "3", "4", "5", "6"]);
    // Students' Source view shows line numbers too.
    await viewer.goto(url);
    await open(viewer, "notes.txt");
    await viewer.getByRole("button", { name: "Source", exact: true }).click();
    expect((await gutter(viewer)).numbers.slice(0, 3)).toEqual(["1", "2", "3"]);
    await open(viewer, "main.tf");
    expect((await gutter(viewer)).numbers.slice(0, 3)).toEqual(["1", "2", "3"]);
    await viewer.screenshot({ path: "test-results/line-numbers-student.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});

test("students' read-only Preview shows live line numbers aligned with wrapped text and code blocks", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const instructor = await browser.newContext(),
    student = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  // Line numbers as the student sees them, with each number's text, colour and position.
  const studentLines = () =>
    viewer.locator(".markdown-preview").evaluate((preview) => {
      const background = getComputedStyle(preview).backgroundColor;
      return [...preview.querySelectorAll(".pv-line")].map((line) => {
        const number = getComputedStyle(line, "::before");
        const box = line.getBoundingClientRect();
        return {
          line: Number(line.getAttribute("data-line")),
          // Computed as `"7" / ""` (the number is decorative for screen readers).
          shown: number.content.split("/")[0].replace(/"/g, "").trim(),
          text: (line.textContent ?? "").trim(),
          color: number.color,
          background,
          height: box.height,
          rowHeight: parseFloat(number.lineHeight),
          numberRight: box.right - parseFloat(number.right || "0"),
          visible: number.display !== "none" && number.visibility !== "hidden",
        };
      });
    });
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Numbered preview");
    const longLine =
      "This sentence is deliberately long so that it wraps across several rows in the student's preview, " +
      "yet it is a single source line and must keep exactly one line number beside its first row. ".repeat(3);
    const content = [
      "Welcome to the lab.",
      longLine.trim(),
      "",
      "```bash",
      "echo one",
      "echo two",
      "```",
      "After the block.",
    ].join("\n");
    expect(await createFile(owner, "notes.txt", content)).toBe(201);
    // Student: public link, Preview by default, no Source click, no settings change.
    await viewer.goto(url);
    await open(viewer, "notes.txt");
    await expect(viewer.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true");
    let lines = await studentLines();
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lines.map((l) => l.shown)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    for (const l of lines) {
      expect(l.visible).toBe(true);
      expect(l.color).not.toBe(l.background);
    }
    // One number per source line, even when it wraps over several rows.
    const wrapped = lines[1];
    expect(wrapped.height).toBeGreaterThan(wrapped.rowHeight * 2);
    // Code lines are numbered individually and the block keeps its Copy code button.
    expect(lines.slice(3, 7).map((l) => l.text)).toEqual([
      expect.stringContaining("Bash / Shell"),
      "echo one",
      "echo two",
      "",
    ]);
    await viewer.locator(".inline-block").getByRole("button", { name: "Copy code" }).click();
    expect(
      (await viewer.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
    ).toBe("echo one\necho two");
    await viewer.screenshot({ path: "test-results/preview-line-numbers-dark.png" });
    // Strictly read-only: no editing controls and nothing editable.
    for (const label of ["Edit code block", "Insert Code Block", "Add code block", "Edit"])
      await expect(viewer.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(viewer.locator(".markdown-preview [contenteditable]")).toHaveCount(0);
    // Instructor adds lines; the student's numbers update live without a refresh.
    await open(owner, "notes.txt");
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await owner.locator(".monaco-editor .view-lines").first().click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Live line nine", { delay: 15 });
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Live line ten", { delay: 15 });
    await expect
      .poll(async () => (await studentLines()).map((l) => `${l.shown}:${l.text}`).slice(-2))
      .toEqual(["9:Live line nine", "10:Live line ten"]);
    await owner.keyboard.press("Control+Home");
    await owner.keyboard.press("Enter");
    await expect
      .poll(async () => (await studentLines()).slice(0, 2).map((l) => `${l.shown}:${l.text}`))
      .toEqual(["1:", "2:Welcome to the lab."]);
    lines = await studentLines();
    expect(lines.map((l) => Number(l.shown))).toEqual(lines.map((_, i) => i + 1));
    // All numbers share one column on the left.
    const columns = new Set(lines.map((l) => Math.round(l.numberRight)));
    expect(columns.size).toBeLessThanOrEqual(2);
    // Light theme.
    await viewer.getByRole("button", { name: "Switch to light mode" }).click();
    for (const l of await studentLines()) expect(l.color).not.toBe(l.background);
    await viewer.screenshot({ path: "test-results/preview-line-numbers-light.png" });
    await viewer.getByRole("button", { name: "Switch to dark mode" }).click();
    await viewer.screenshot({ path: "test-results/preview-line-numbers-student.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
