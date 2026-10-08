import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, openFromExplorer, signUp } from "./helpers";

// Pasting sends one Yjs update; very fast synthetic typing would trip the
// server's per-socket write-rate limit, which real typing never reaches.
async function paste(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+v");
}
const blockTexts = (page: Page) =>
  page.locator(".inline-block pre").evaluateAll((nodes) =>
    // Monaco's colorizer renders spaces as no-break spaces.
    nodes.map((node) =>
      (node.textContent ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/ /g, " ")
        .replace(/\n$/, ""),
    ),
  );

test("lesson documents show inline code blocks with Copy; instructors insert, edit, move and delete them; students stay read-only", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const instructor = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  owner.on("dialog", (d) => void d.accept());
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Terraform Introduction");
    await owner.getByRole("button", { name: "New file", exact: true }).first().click();
    await owner.getByLabel("Filename", { exact: true }).fill("lesson.md");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create file", exact: true })
      .click();
    const editor = owner.locator(".monaco-editor textarea");
    await editor.focus();
    await paste(
      owner,
      "# Terraform Introduction\n\nToday we will initialize our Terraform project.\n",
    );
    async function insert(command: string, after?: string) {
      await owner.getByRole("button", { name: "Insert Code Block", exact: true }).click();
      await owner.getByLabel("Code block language").selectOption("shell");
      await owner.getByLabel("Code block content").fill(command);
      await owner
        .getByRole("dialog")
        .getByRole("button", { name: "Insert Code Block", exact: true })
        .click();
      if (after) {
        await editor.focus();
        await owner.keyboard.press("Control+End");
        await paste(owner, after);
      }
    }
    await insert("terraform init", "\nNext, preview the infrastructure changes.\n");
    await insert("terraform plan", "\nThen apply the configuration.\n");
    await insert("terraform apply");
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(owner.locator(".inline-block")).toHaveCount(3);
    expect(await blockTexts(owner)).toEqual([
      "terraform init",
      "terraform plan",
      "terraform apply",
    ]);
    await expect(owner.locator(".inline-block-label").first()).toHaveText(
      "Bash / Shell",
    );
    // Headings and prose surround the blocks in reading order.
    const order = await owner
      .locator(".markdown-preview > :not(.pv-blank)")
      .evaluateAll((nodes) => nodes.map((n) => n.tagName + ":" + (n.textContent ?? "").slice(0, 25)));
    expect(order.slice(0, 6)).toEqual([
      "H1:Terraform Introduction",
      expect.stringMatching(/^P:Today we will/),
      expect.stringMatching(/^DIV:Bash \/ Shell/),
      expect.stringMatching(/^P:Next, preview/),
      expect.stringMatching(/^DIV:Bash \/ Shell/),
      expect.stringMatching(/^P:Then apply/),
    ]);
    await owner.screenshot({ path: "test-results/lesson-instructor-dark.png" });

    // Students: no account, preview by default, Copy on every block, no editing.
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await openFromExplorer(viewer, "lesson.md");
    await expect(viewer.locator(".inline-block")).toHaveCount(3);
    for (const label of [
      "Edit code block",
      "Move code block up",
      "Move code block down",
      "Delete code block",
      "Insert Code Block",
      "Add code block",
    ])
      await expect(viewer.getByRole("button", { name: label })).toHaveCount(0);
    for (const [index, command] of [
      "terraform init",
      "terraform plan",
      "terraform apply",
    ].entries()) {
      await viewer
        .locator(".inline-block")
        .nth(index)
        .getByRole("button", { name: "Copy code", exact: true })
        .click();
      expect(await viewer.evaluate(() => navigator.clipboard.readText())).toBe(command);
    }
    await viewer.screenshot({ path: "test-results/lesson-student-dark.png" });

    // Edit a block; students see it live.
    await owner.locator(".inline-block").nth(1).getByRole("button", { name: "Edit code block" }).click();
    await owner.getByLabel("Code block content").fill("terraform plan -out=tfplan");
    await owner.getByRole("button", { name: "Save code block", exact: true }).click();
    await expect(viewer.locator(".inline-block").nth(1)).toContainText("terraform plan -out=tfplan");
    // Move the last block up past its paragraph, then past the previous block.
    const last = () => owner.locator(".inline-block").nth(2);
    await last().getByRole("button", { name: "Move code block up" }).click();
    await expect.poll(() => blockTexts(viewer)).toEqual([
      "terraform init",
      "terraform plan -out=tfplan",
      "terraform apply",
    ]);
    await last().getByRole("button", { name: "Move code block up" }).click();
    await expect.poll(() => blockTexts(viewer)).toEqual([
      "terraform init",
      "terraform apply",
      "terraform plan -out=tfplan",
    ]);
    // Delete a block.
    await owner.locator(".inline-block").first().getByRole("button", { name: "Delete code block" }).click();
    await expect.poll(() => blockTexts(viewer)).toEqual([
      "terraform apply",
      "terraform plan -out=tfplan",
    ]);
    // HTML inside a block is shown as code, never executed.
    await owner.getByRole("button", { name: "Add code block", exact: true }).click();
    await owner.getByLabel("Code block language").selectOption("html");
    await owner
      .getByLabel("Code block content")
      .fill("<script>window.blockExecuted = true</script><img src=x onerror=alert(1)>");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Add code block", exact: true })
      .click();
    await expect(viewer.locator(".inline-block")).toHaveCount(3);
    await expect(viewer.locator(".inline-block").last()).toContainText("<script>");
    await expect(viewer.locator(".markdown-preview script, .markdown-preview img")).toHaveCount(0);
    expect(
      await viewer.evaluate(() => (window as unknown as { blockExecuted?: boolean }).blockExecuted),
    ).toBeUndefined();

    // Create a block from a selection inside the Markdown source.
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor).toBeVisible();
    await owner.locator(".monaco-editor .view-lines").click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("kubectl get pods", { delay: 25 });
    await owner.keyboard.press("Shift+Home");
    await expect(owner.locator(".view-lines")).toContainText("kubectl get pods");
    // Open Monaco's context menu from the keyboard so the selection is kept.
    await owner.keyboard.press("Shift+F10");
    await owner
      .getByRole("menuitem", { name: "Create Code Block from Selection", exact: true })
      .click({ delay: 150 });
    await expect(owner.getByLabel("Code block content")).toHaveValue("kubectl get pods");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Insert Code Block", exact: true })
      .click();
    await expect(viewer.locator(".inline-block")).toHaveCount(4);
    await expect(viewer.locator(".inline-block").last()).toContainText("kubectl get pods");

    // Responsive and light-mode rendering for review.
    await viewer.getByRole("button", { name: "Switch to light mode" }).click();
    await viewer.screenshot({ path: "test-results/lesson-student-light.png" });
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await viewer.screenshot({ path: "test-results/lesson-student-mobile.png" });
    expect(
      await viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});

test("legacy standalone snippets move into a lesson document only when the instructor chooses", async ({
  browser,
}) => {
  const instructor = await browser.newContext(),
    student = await browser.newContext();
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Legacy course");
    // Seed v1-style standalone snippets through the still-supported blocks API.
    await owner.evaluate(async (id) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      for (const [title, language, content] of [
        ["Initialize", "shell", "terraform init"],
        ["Provider", "hcl", 'provider "aws" {}'],
      ])
        await fetch(`/api/rooms/${id}/blocks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ title, language, content }),
        });
    }, url.split("/").pop());
    await owner.reload();
    const legacy = (page: Page) =>
      page.getByRole("button", { name: /Legacy snippets/ });
    await expect(legacy(owner)).toContainText("2");
    await viewer.goto(url);
    await legacy(viewer).click();
    await expect(viewer.locator(".migrate-banner")).toContainText(
      "Your instructor can move these snippets",
    );
    await expect(
      viewer.getByRole("button", { name: /Move snippets/ }),
    ).toHaveCount(0);
    await legacy(owner).click();
    await owner.getByRole("button", { name: /Move snippets into a lesson document/ }).click();
    await expect(
      owner.getByRole("tab", { name: "code-blocks.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(legacy(owner)).toHaveCount(0);
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(owner.getByRole("heading", { name: "Initialize" })).toBeVisible();
    expect(await blockTexts(owner)).toEqual(["terraform init", 'provider "aws" {}']);
    await viewer.reload();
    await expect(legacy(viewer)).toHaveCount(0);
    await openFromExplorer(viewer, "code-blocks.md");
    await expect(viewer.locator(".inline-block")).toHaveCount(2);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});

test("file tabs close and reopen like an editor without changing shared files", async ({
  browser,
}) => {
  const instructor = await browser.newContext(),
    student = await browser.newContext();
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Tabs course");
    const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
    await openFromExplorer(owner, "variables.tf");
    await openFromExplorer(owner, "outputs.tf");
    await expect(owner.getByRole("tab")).toHaveCount(3);
    // Closing the active tab activates its neighbour.
    await owner.getByRole("button", { name: "Close outputs.tf" }).click();
    await expect(tab(owner, "outputs.tf")).toHaveCount(0);
    await expect(tab(owner, "variables.tf")).toHaveAttribute("aria-selected", "true");
    // Middle-click closes too.
    await tab(owner, "main.tf").click({ button: "middle" });
    await expect(tab(owner, "main.tf")).toHaveCount(0);
    // Unsaved edits survive closing the tab.
    await owner.locator(".monaco-editor textarea").focus();
    await owner.keyboard.press("Control+Home");
    await owner.keyboard.insertText("# edited before closing\n");
    await owner.keyboard.press("Alt+w");
    await expect(owner.getByRole("tab")).toHaveCount(0);
    await expect(owner.getByText("No files are open.")).toBeVisible();
    await owner.screenshot({ path: "test-results/tabs-empty.png" });
    // Closing never deletes: everyone still sees every file.
    await viewer.goto(url);
    for (const name of ["main.tf", "variables.tf", "outputs.tf"])
      await expect(
        viewer.locator(".sidebar").getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await openFromExplorer(viewer, "variables.tf");
    await expect(viewer.locator(".view-lines")).toContainText("edited before closing");
    // Reopen from the Explorer.
    await openFromExplorer(owner, "variables.tf");
    await expect(owner.locator(".view-lines")).toContainText("edited before closing");
    await openFromExplorer(owner, "main.tf");
    await expect(owner.getByRole("tab")).toHaveCount(2);
    // A viewer can close personal tabs without affecting anyone else.
    await viewer.getByRole("button", { name: "Close variables.tf" }).click();
    await expect(tab(viewer, "variables.tf")).toHaveCount(0);
    await expect(owner.getByRole("tab")).toHaveCount(2);
    // Tabs are remembered per browser.
    await owner.reload();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    await expect(owner.getByRole("tab")).toHaveCount(2);
    await expect(tab(owner, "main.tf")).toHaveAttribute("aria-selected", "true");
    await owner.screenshot({ path: "test-results/tabs-open.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});

test("typing ``` in a Markdown lesson creates a ChatGPT-style code block with its own Copy code button", async ({
  browser,
}) => {
  const instructor = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Backtick lesson");
    await owner.getByRole("button", { name: "New file", exact: true }).first().click();
    await owner.getByLabel("Filename", { exact: true }).fill("lesson.md");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create file", exact: true })
      .click();
    // Split view: Markdown source on the left, rendered lesson on the right.
    await expect(owner.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
    await owner.locator(".monaco-editor .view-lines").click();
    await owner.keyboard.type("Run this to check your shell:", { delay: 15 });
    await owner.keyboard.press("Enter");
    await owner.keyboard.press("Enter");
    // Typing ``` plus a language and pressing Enter opens a block and closes it for you.
    await owner.keyboard.type("```bash", { delay: 15 });
    await owner.keyboard.press("Enter");
    await owner.keyboard.type('echo "hello class"', { delay: 15 });
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText('echo "hello class"');
    // Leave the block (onto the closing fence) and keep writing the lesson.
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("You should see the greeting.", { delay: 15 });
    const source = await owner.evaluate(() =>
      [...document.querySelectorAll(".monaco-editor .view-line")]
        .map((line) => (line.textContent ?? "").replace(/ /g, " "))
        .join("\n"),
    );
    expect(source).toBe(
      'Run this to check your shell:\n\n```bash\necho "hello class"\n```\n\nYou should see the greeting.',
    );
    const preview = owner.locator(".markdown-preview");
    await expect(preview.locator(".inline-block")).toHaveCount(1);
    await expect(preview.locator(".inline-block-label")).toHaveText("Bash / Shell");
    await expect(preview.locator("p").first()).toHaveText("Run this to check your shell:");
    await expect(preview.locator("p").last()).toHaveText("You should see the greeting.");
    // Copy code copies only this block, never the whole document.
    const copy = preview.locator(".inline-block").getByRole("button", { name: "Copy code" });
    await copy.click();
    await expect(preview.locator(".inline-block").getByRole("button", { name: "Copied!" })).toBeVisible();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe('echo "hello class"');
    // The block can be edited in place while writing.
    await preview.getByRole("button", { name: "Edit code block" }).click();
    await owner.getByLabel("Code block content").fill('echo "hello class"\nwhoami');
    await owner.getByRole("button", { name: "Save code block", exact: true }).click();
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText("whoami");
    // Editing keeps the author's ```bash spelling.
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText("```bash");
    await owner.screenshot({ path: "test-results/backtick-lesson-split.png" });
    // No separate Code Blocks section exists.
    await expect(owner.getByRole("button", { name: /Code Blocks|Legacy snippets/ })).toHaveCount(0);
    // Students: rendered read-only lesson with the same Copy code button.
    await viewer.goto(url);
    await viewer.locator(".sidebar").getByRole("button", { name: "lesson.md", exact: true }).click();
    await expect(viewer.locator(".inline-block")).toContainText("whoami");
    await expect(viewer.getByRole("button", { name: "Edit code block" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Insert Code Block" })).toHaveCount(0);
    await viewer.locator(".inline-block").getByRole("button", { name: "Copy code" }).click();
    // The Windows clipboard stores line breaks as CRLF.
    expect(
      (await viewer.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
    ).toBe('echo "hello class"\nwhoami');
    await viewer.screenshot({ path: "test-results/backtick-lesson-student.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});

test("Plain Text documents: typing ``` creates interactive code blocks with Copy code; source files are untouched", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const instructor = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  const clipboard = async (page: Page) =>
    (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  const editorLines = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".monaco-editor .view-line")]
        .map((line) => (line.textContent ?? "").replace(/ /g, " "))
        .join("\n"),
    );
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Plain text notes");
    // 1. A Plain Text document (no Markdown, no .md extension).
    await owner.getByRole("button", { name: "New file", exact: true }).first().click();
    await owner.getByLabel("Filename", { exact: true }).fill("notes.txt");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create file", exact: true })
      .click();
    await expect(owner.getByRole("dialog")).toHaveCount(0);
    await expect(owner.getByRole("banner").getByLabel("Programming language")).toHaveValue("plaintext");
    const editor = owner.locator(".monaco-editor").first();
    await editor.locator(".view-lines").click();
    await owner.keyboard.type("# Steps, kept as plain text", { delay: 10 });
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Check your Terraform version:", { delay: 10 });
    await owner.keyboard.press("Enter");
    // 2-3. Typing three backticks creates a code block right away.
    await owner.keyboard.type("```", { delay: 40 });
    await expect(editor.locator(".doc-block-toolbar")).toHaveCount(1);
    await expect(editor.getByRole("button", { name: "Copy code" })).toBeVisible();
    // 4. Paste code straight into the block.
    // insertText delivers the text as one input, like a paste (the headless clipboard
    // is shared across test contexts, which makes real Ctrl+V flaky here).
    await owner.keyboard.insertText("terraform version");
    // 7. Continue writing normal text below the block.
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Then initialise the project:", { delay: 10 });
    await owner.keyboard.press("Enter");
    // 8. A second, independent block; typing a language name first sets its language.
    await owner.keyboard.type("```", { delay: 40 });
    await expect(editor.locator(".doc-block-toolbar")).toHaveCount(2);
    await owner.keyboard.type("bash", { delay: 20 });
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("terraform init", { delay: 10 });
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Done.", { delay: 10 });
    expect(await editorLines(owner)).toBe(
      [
        "# Steps, kept as plain text",
        "Check your Terraform version:",
        "```",
        "terraform version",
        "```",
        "Then initialise the project:",
        "```bash",
        "terraform init",
        "```",
        "Done.",
      ].join("\n"),
    );
    // 5-6. Each block's own Copy code button copies only that block.
    const toolbars = editor.locator(".doc-block-toolbar");
    await expect(toolbars.nth(1).getByLabel("Language of this code block")).toHaveValue("shell");
    await toolbars.nth(0).getByRole("button", { name: "Copy code" }).click();
    await expect(toolbars.nth(0).getByRole("button", { name: "Copied!" })).toBeVisible();
    expect(await clipboard(owner)).toBe("terraform version");
    await toolbars.nth(1).getByRole("button", { name: "Copy code" }).click();
    expect(await clipboard(owner)).toBe("terraform init");
    // The language picker in the block header rewrites only that block's fence.
    await toolbars.nth(0).getByLabel("Language of this code block").selectOption("hcl");
    await expect.poll(() => editorLines(owner)).toContain("```hcl\nterraform version");
    // The rendered side of Split view shows the same interactive blocks.
    const preview = owner.locator(".markdown-preview");
    await expect(preview.locator(".inline-block")).toHaveCount(2);
    await expect(preview.locator(".inline-block-label")).toHaveText(["Terraform / HCL", "Bash / Shell"]);
    await expect(preview.locator("h1")).toHaveCount(0);
    await expect(preview.locator("p").first().locator(".pv-line")).toHaveText([
      "# Steps, kept as plain text",
      "Check your Terraform version:",
    ]);
    await owner.screenshot({ path: "test-results/plain-text-blocks.png" });

    // Source files are untouched: backticks in main.tf stay ordinary text.
    await owner.getByRole("tab", { name: "main.tf", exact: true }).click();
    await expect(owner.getByRole("button", { name: "Insert Code Block" })).toHaveCount(0);
    const source = owner.locator(".monaco-editor").first();
    await source.locator(".view-lines").click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("```", { delay: 40 });
    await owner.keyboard.press("Enter");
    await expect(source.locator(".doc-block-toolbar")).toHaveCount(0);
    const lines = (await editorLines(owner)).split("\n");
    expect(lines.filter((line) => line.trim() === "```")).toHaveLength(1);
    await owner.keyboard.press("Control+z");
    await owner.keyboard.press("Control+z");

    // 9. Students see formatted blocks, can copy them, and cannot edit them.
    await viewer.goto(url);
    await viewer.locator(".sidebar").getByRole("button", { name: "notes.txt", exact: true }).click();
    await expect(viewer.locator(".inline-block")).toHaveCount(2);
    await viewer.locator(".inline-block").nth(1).getByRole("button", { name: "Copy code" }).click();
    expect(await clipboard(viewer)).toBe("terraform init");
    for (const label of ["Edit code block", "Delete code block", "Insert Code Block", "Add code block"])
      await expect(viewer.getByRole("button", { name: label })).toHaveCount(0);
    await viewer.screenshot({ path: "test-results/plain-text-student.png" });
    // Read-only Source view still renders blocks with Copy code, but no language picker.
    await viewer.getByRole("button", { name: "Source", exact: true }).click();
    const readOnly = viewer.locator(".monaco-editor").first();
    await expect(readOnly.locator(".doc-block-toolbar")).toHaveCount(2);
    await expect(readOnly.locator("select")).toHaveCount(0);
    await readOnly.locator(".doc-block-toolbar").first().getByRole("button", { name: "Copy code" }).click();
    expect(await clipboard(viewer)).toBe("terraform version");
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
