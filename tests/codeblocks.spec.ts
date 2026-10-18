import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const FENCE = "```";
const manifest = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: web",
  "  labels:",
  "    app: web # used by the Service selector",
  "spec:",
  "  replicas: 3",
  "  selector:",
  "    matchLabels:",
  "      app: web",
  "  template:",
  "    metadata:",
  "      labels:",
  "        app: web",
  "    spec:",
  "      containers:",
  "        - name: nginx",
  '          image: "nginx:1.27"',
  "          ports:",
  "            - containerPort: 80",
  "          env:",
  "            - name: GREETING",
  "              value: 'hello'",
].join("\n");
const service = [
  "apiVersion: v1",
  "kind: Service",
  "metadata:",
  "  name: web",
  "spec:",
  "  ports:",
  "    - port: 80",
].join("\n");
const longCommand =
  "kubectl create secret generic app-credentials --namespace production " +
  "--from-literal=username=admin --from-literal=password=correct-horse-battery-staple " +
  "--from-literal=api-key=0123456789abcdef0123456789abcdef --dry-run=client -o yaml";
const lesson = [
  "# Deploying nginx",
  "",
  "Apply this manifest:",
  "",
  FENCE + "yaml",
  manifest,
  FENCE,
  "",
  "The Service has no language set:",
  "",
  FENCE,
  service,
  FENCE,
  "",
  FENCE + "bash",
  longCommand,
  FENCE,
  "",
  FENCE + "json",
  '{ "replicas": 3, "ready": true }',
  FENCE,
].join("\n");

async function createLesson(page: Page, filename: string, content: string) {
  return page.evaluate(
    async ({ filename, content }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const response = await fetch(`/api/rooms/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ filename, language: "markdown", content }),
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
const clipboard = async (page: Page) =>
  (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");

test("code blocks: highlighted Kubernetes YAML, exact indentation and copy, full width, read-only viewer", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const instructor = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Kubernetes basics");
    expect(await createLesson(owner, "deploy.md", lesson)).toBe(201);

    // Viewer: opens straight into the formatted Preview, with no view toggle.
    await viewer.goto(url);
    await open(viewer, "deploy.md");
    const preview = viewer.locator(".markdown-preview");
    const blocks = preview.locator(".inline-block");
    await expect(blocks).toHaveCount(4);
    await expect(viewer.locator(".markdown-switch")).toHaveCount(0);
    await expect(viewer.locator(".monaco-editor")).toHaveCount(0);
    await expect(preview.locator(".inline-block-label")).toHaveText([
      "YAML",
      "YAML",
      "Bash / Shell",
      "JSON",
    ]);
    // The unlabeled block is detected as YAML for colours only; the viewer can't change it.
    await expect(blocks.nth(1).locator(".inline-block-detected")).toHaveText("auto");
    await expect(blocks.nth(1).getByRole("button", { name: /Set as/ })).toHaveCount(0);

    // Syntax colours: keys, strings, numbers and comments each get their own colour.
    const yaml = blocks.first();
    await expect(yaml.locator(".tk-key").first()).toHaveText("apiVersion");
    await expect(yaml.locator(".tk-comment")).toContainText("# used by the Service selector");
    await expect(yaml.locator(".tk-number").filter({ hasText: "3" }).first()).toBeVisible();
    await expect(yaml.locator(".tk-string").filter({ hasText: '"nginx:1.27"' })).toHaveCount(1);
    const colors = await yaml.evaluate((block) =>
      ["tk-key", "tk-string", "tk-number", "tk-comment"].map(
        (name) => getComputedStyle(block.querySelector("." + name)!).color,
      ),
    );
    expect(new Set(colors).size).toBe(4);
    await expect(blocks.nth(1).locator(".tk-key").first()).toHaveText("apiVersion");
    await expect(blocks.nth(3).locator(".tk-key").first()).toHaveText('"replicas"');

    // Indentation is preserved character for character (real spaces, no NBSP) and
    // nested levels get guides.
    expect(await yaml.locator("pre").evaluate((pre) => pre.textContent)).toBe(manifest + "\n");
    expect(await yaml.locator(".indent-guide").count()).toBeGreaterThan(20);
    const deepest = await yaml.locator(".code-line").nth(23).locator(".indent-guide").count();
    expect(deepest).toBe(7); // "              value:" = 14 spaces = 7 levels of 2

    // Every code line keeps its own source line number (opening fence is line 5).
    const numbers = await yaml
      .locator(".code-gutter .pv-line")
      .evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-line"))));
    expect(numbers).toEqual(manifest.split("\n").map((_, i) => 6 + i));

    // Copy code copies exactly the block; selecting the code and copying does too.
    await yaml.getByRole("button", { name: "Copy code" }).click();
    expect(await clipboard(viewer)).toBe(manifest);
    await yaml.locator("pre").evaluate((pre) => {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await viewer.keyboard.press("Control+c");
    expect((await clipboard(viewer)).replace(/\n$/, "")).toBe(manifest);
    await blocks.nth(2).getByRole("button", { name: "Copy code" }).click();
    expect(await clipboard(viewer)).toBe(longCommand);

    // Width: code fills the preview (wider than the 900px prose measure); long lines
    // scroll inside the block, never the page.
    const layout = await preview.evaluate((node) => {
      const style = getComputedStyle(node);
      const content =
        node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const blocks = [...node.querySelectorAll(".inline-block")];
      const longPre = blocks[2].querySelector("pre")!;
      return {
        content,
        widths: blocks.map((b) => b.getBoundingClientRect().width),
        longScrolls: longPre.scrollWidth > longPre.clientWidth,
        overflowX: getComputedStyle(longPre).overflowX,
        pageOverflow: node.scrollWidth > node.clientWidth,
      };
    });
    for (const width of layout.widths) expect(Math.abs(width - layout.content)).toBeLessThanOrEqual(2);
    expect(layout.content).toBeGreaterThan(900);
    expect(layout.longScrolls).toBe(true);
    expect(layout.overflowX).toBe("auto");
    expect(layout.pageOverflow).toBe(false);
    await viewer.screenshot({ path: "test-results/codeblocks-viewer-dark.png", fullPage: true });
    await viewer.getByRole("button", { name: "Switch to light mode" }).click();
    await viewer.screenshot({ path: "test-results/codeblocks-viewer-light.png" });

    // Strictly read-only for viewers.
    for (const label of ["Edit code block", "Delete code block", "Add code block", "Insert Code Block", "Edit"])
      await expect(viewer.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(viewer.locator(".markdown-preview [contenteditable], .markdown-preview select")).toHaveCount(0);

    // Instructor: Split view shows the same full-width blocks beside the source; the
    // detected language can be saved with one click and reaches the viewer live.
    await open(owner, "deploy.md");
    await owner.getByRole("button", { name: "Split" }).click();
    const ownerPreview = owner.locator(".markdown-preview");
    await expect(ownerPreview.locator(".inline-block")).toHaveCount(4);
    await owner.screenshot({ path: "test-results/codeblocks-instructor-split.png" });
    await ownerPreview.locator(".inline-block").nth(1).getByRole("button", { name: "Set as YAML" }).click();
    await expect(owner.locator(".monaco-editor .view-lines")).toContainText(FENCE + "yaml");
    await expect(blocks.nth(1).locator(".inline-block-detected")).toHaveCount(0);
    await expect(blocks.nth(1).locator(".inline-block-label")).toHaveText("YAML");
    // The code itself was not reformatted.
    expect(await blocks.nth(1).locator("pre").evaluate((pre) => pre.textContent)).toBe(service + "\n");
    // Edit mode: the Markdown source is highlighted inside fences too.
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(owner.locator(".markdown-preview")).toHaveCount(0);
    await owner.screenshot({ path: "test-results/codeblocks-instructor-edit.png" });
    // Live edit: the viewer's highlighted block updates without a refresh.
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    await ownerPreview.locator(".inline-block").nth(3).getByRole("button", { name: "Edit code block" }).click();
    await owner.getByLabel("Code block content").fill('{\n  "replicas": 5,\n  "ready": false\n}');
    await owner.getByRole("button", { name: "Save code block", exact: true }).click();
    await expect(blocks.nth(3).locator(".tk-number")).toHaveText("5");
    await expect(blocks.nth(3).locator(".indent-guide")).toHaveCount(2);

    // Mobile: blocks fit the screen and scroll sideways inside themselves.
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.getByRole("button", { name: "Switch to dark mode" }).click();
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(blocks.first()).toBeVisible();
    const mobile = await viewer.evaluate(() => {
      const pre = document.querySelectorAll(".inline-block pre")[2] as HTMLElement;
      const block = pre.closest(".inline-block")!.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth,
        inside: block.right <= window.innerWidth,
        scrolls: pre.scrollWidth > pre.clientWidth,
      };
    });
    expect(mobile).toEqual({ page: true, inside: true, scrolls: true });
    await viewer.screenshot({ path: "test-results/codeblocks-viewer-mobile.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
