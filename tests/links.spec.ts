import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const FENCE = "```";
const GITHUB = "https://github.com/guilene1/Quickbite";
const LOCAL = "http://localhost:3000";

async function createDoc(page: Page, filename: string, language: string, content: string) {
  return page.evaluate(
    async ({ filename, language, content }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const response = await fetch(`/api/rooms/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ filename, language, content }),
      });
      return response.status;
    },
    { filename, language, content },
  );
}
// Uploads a small PNG through the real API and returns its document URL.
async function uploadPng(page: Page) {
  return page.evaluate(async () => {
    const id = location.pathname.split("/")[2];
    const { csrfToken } = await (await fetch("/api/auth/me")).json();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#2563eb";
    g.fillRect(0, 0, 320, 200);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const response = await fetch(`/api/rooms/${id}/images`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-csrf-token": csrfToken },
      body: blob,
    });
    return `/api/rooms/${id}/images/${(await response.json()).id}`;
  });
}
async function open(page: Page, filename: string) {
  await page.locator(".sidebar").getByRole("button", { name: filename, exact: true }).click();
  await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveAttribute("aria-selected", "true");
}
// External sites are stubbed so the test checks Kodelumi's behaviour without the internet.
async function stubSites(context: BrowserContext) {
  await context.route(`${GITHUB}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Quickbite on GitHub</title>stub" }),
  );
  // Only the exact link target: the test app itself may be running on this origin.
  await context.route(`${LOCAL}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Local Kodelumi</title>stub" }),
  );
}
// Clicking a rendered link opens exactly that address in a new tab; the document stays.
async function clickOpensTab(page: Page, link: ReturnType<Page["locator"]>, expected: string) {
  const before = page.url();
  const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(expected);
  expect(page.url()).toBe(before);
  await tab.close();
}
const links = (page: Page) =>
  page.locator(".markdown-preview a.doc-link").evaluateAll((list) =>
    (list as HTMLAnchorElement[]).map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
      target: a.target,
      rel: a.rel,
      color: getComputedStyle(a).color,
      underline: getComputedStyle(a).textDecorationLine,
    })),
  );

test("URLs in Markdown and Plain Text documents are clickable links (new tab, blue, underlined), never inside code", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const instructor = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const student = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await stubSites(instructor);
  await stubSites(student);
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Links");
    const image = await uploadPng(owner);
    const markdown = [
      "# Project links",
      "",
      `Repository: ${GITHUB}`,
      `Local app: ${LOCAL}`,
      "Read [the Kubernetes docs](https://kubernetes.io/docs/home/) (or see https://kubernetes.io/docs/concepts/).",
      `**Bold ${GITHUB}/issues**`,
      "Inline `https://example.com/inline-code` stays code.",
      "",
      "- Item with https://github.com/guilene1/Quickbite/pulls",
      "",
      `${FENCE}bash`,
      "curl https://example.com/in-a-code-block",
      FENCE,
      "",
      `![Diagram](${image})`,
    ].join("\n");
    expect(await createDoc(owner, "links.md", "markdown", markdown)).toBe(201);
    const plain = [
      "# Not a heading in plain text",
      `Repo: ${GITHUB}`,
      `App: ${LOCAL}`,
      FENCE,
      "git clone https://github.com/guilene1/Quickbite.git",
      FENCE,
    ].join("\n");
    expect(await createDoc(owner, "notes.txt", "plaintext", plain)).toBe(201);

    // Anonymous read-only viewer, Markdown document.
    await viewer.goto(url);
    await open(viewer, "links.md");
    await expect(viewer.locator(".markdown-preview a.doc-link")).toHaveCount(6);
    const found = await links(viewer);
    expect(found.map((l) => l.href)).toEqual([
      GITHUB,
      `${LOCAL}/`,
      "https://kubernetes.io/docs/home/",
      "https://kubernetes.io/docs/concepts/",
      `${GITHUB}/issues`,
      `${GITHUB}/pulls`,
    ]);
    // The visible text is exactly what was written (trailing ")." is not part of the link).
    expect(found.map((l) => l.text)).toContain(GITHUB);
    expect(found.map((l) => l.text)).toContain(LOCAL);
    expect(found.map((l) => l.text)).toContain("https://kubernetes.io/docs/concepts/");
    for (const link of found) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
      expect(link.underline).toContain("underline");
      expect(link.color).toBe("rgb(88, 166, 255)"); // blue (dark theme)
    }
    // URLs in inline code and code blocks stay plain text.
    await expect(viewer.locator(".markdown-preview code a, .markdown-preview .inline-block a")).toHaveCount(0);
    await expect(viewer.locator(".markdown-preview :not(pre) > code")).toHaveText("https://example.com/inline-code");
    await expect(viewer.locator(".inline-block pre")).toContainText("curl https://example.com/in-a-code-block");
    // Images and code highlighting still work alongside links.
    await expect.poll(() => viewer.locator(".doc-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await expect(viewer.locator(".doc-image a")).toHaveCount(0);
    await expect(viewer.locator(".inline-block .tk-string, .inline-block .code-line").first()).toBeVisible();
    // Both example URLs open in a new tab at exactly that address.
    await clickOpensTab(viewer, viewer.locator(`.markdown-preview a.doc-link[href="${GITHUB}"]`), GITHUB);
    await clickOpensTab(viewer, viewer.locator(`.markdown-preview a.doc-link[href="${LOCAL}/"]`), `${LOCAL}/`);
    await viewer.screenshot({ path: "test-results/links-viewer-dark.png" });
    // Light theme: still blue and underlined.
    await viewer.getByRole("button", { name: "Switch to light mode" }).click();
    const light = await links(viewer);
    expect(light[0].color).toBe("rgb(9, 105, 218)");
    expect(light[0].underline).toContain("underline");
    await viewer.screenshot({ path: "test-results/links-viewer-light.png" });

    // Plain Text document: URLs are links, everything else stays literal.
    await open(viewer, "notes.txt");
    await expect(viewer.locator(".markdown-preview a.doc-link")).toHaveCount(2);
    expect((await links(viewer)).map((l) => l.href)).toEqual([GITHUB, `${LOCAL}/`]);
    await expect(viewer.locator(".markdown-preview h1")).toHaveCount(0);
    await expect(viewer.locator(".inline-block a")).toHaveCount(0);
    await clickOpensTab(viewer, viewer.locator(`.markdown-preview a.doc-link[href="${GITHUB}"]`), GITHUB);

    // Instructor, Split view: links in the live preview work too, and a URL typed in the
    // editor becomes a link for the student without a refresh.
    await open(owner, "notes.txt");
    await owner.getByRole("button", { name: "Split" }).click();
    const split = owner.locator(".editor-surface.split .markdown-preview");
    await expect(split.locator("a.doc-link")).toHaveCount(2);
    await clickOpensTab(owner, split.locator(`a.doc-link[href="${LOCAL}/"]`), `${LOCAL}/`);
    await owner.locator(".monaco-editor .view-lines").click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Enter");
    await owner.keyboard.type("Issues: https://github.com/guilene1/Quickbite/issues", { delay: 10 });
    await expect(viewer.locator(".markdown-preview a.doc-link")).toHaveCount(3);
    await expect(viewer.locator(".markdown-preview a.doc-link").last()).toHaveAttribute(
      "href",
      `${GITHUB}/issues`,
    );
    await owner.screenshot({ path: "test-results/links-instructor-split.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
