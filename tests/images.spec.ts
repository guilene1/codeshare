import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { createWorkspace, signUp } from "./helpers";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
// Two-frame animated GIF (8x8, red then blue) that loops forever.
function animatedGif() {
  const frame = (color: number) =>
    "21f9040432000000" + "2c000000000800080000" +
    // LZW (min code size 2) for 64 pixels of one colour, written as raw codes.
    lzw64(color) + "00";
  return Buffer.from(
    "474946383961" + "0800" + "0800" + "80" + "00" + "00" + "ff0000" + "0000ff" +
      "21ff0b" + "4e45545343415045322e30" + "03010000" + "00" +
      frame(0) + frame(1) + "3b",
    "hex",
  );
}
// Minimal GIF LZW stream: clear code, then each pixel as a literal (3-bit codes, with a
// clear code every few pixels so the code size never grows), then end-of-information.
function lzw64(index: number) {
  const codes: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (i % 2 === 0) codes.push(4);
    codes.push(index);
  }
  codes.push(5);
  let bits = 0,
    count = 0;
  const bytes: number[] = [];
  for (const code of codes) {
    bits |= code << count;
    count += 3;
    while (count >= 8) {
      bytes.push(bits & 0xff);
      bits >>= 8;
      count -= 8;
    }
  }
  if (count) bytes.push(bits & 0xff);
  const blocks: string[] = ["02"];
  for (let i = 0; i < bytes.length; i += 255) {
    const part = bytes.slice(i, i + 255);
    blocks.push(part.length.toString(16).padStart(2, "0") + Buffer.from(part).toString("hex"));
  }
  return blocks.join("");
}

// A 1536x1024 architecture diagram with small labels, like the reference infographic.
async function diagramPng(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536;
    canvas.height = 1024;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 1536, 1024);
    g.fillStyle = "#0b3d91";
    g.font = "bold 64px sans-serif";
    g.fillText("KUBERNETES ARCHITECTURE", 330, 80);
    const box = (x: number, y: number, w: number, h: number, title: string, lines: string[]) => {
      g.strokeStyle = "#2563eb";
      g.lineWidth = 2;
      g.strokeRect(x, y, w, h);
      g.fillStyle = "#1d4ed8";
      g.font = "bold 18px sans-serif";
      g.fillText(title, x + 12, y + 28);
      g.fillStyle = "#111827";
      g.font = "11px sans-serif";
      lines.forEach((line, i) => g.fillText(line, x + 12, y + 50 + i * 14));
    };
    box(40, 150, 470, 420, "CONTROL PLANE", [
      "API Server: entry point for all requests",
      "etcd: stores all cluster data (configuration, state, secrets)",
      "Scheduler: decides which worker node runs each new pod",
      "Controller Manager: keeps the cluster in the desired state",
    ]);
    for (const [n, x] of [[1, 560], [2, 1040]] as const)
      box(x, 150, 450, 420, `WORKER NODE ${n}`, [
        "Kubelet: communicates with the control plane",
        "Kube Proxy: manages network rules and services",
        "Pods: Pod 1  Pod 2  Pod 3",
        "Container Runtime (containerd / dockerd)",
      ]);
    box(40, 620, 1450, 160, "HOW KUBERNETES WORKS (DEPLOYMENT FLOW)", [
      "1. You submit a request (kubectl apply)   2. API server processes the request   3. Cluster state is stored in etcd",
      "4. Scheduler assigns the pod to a worker node   5. Kubelet pulls the image   6. Controllers keep it healthy",
    ]);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function createDoc(page: Page, filename: string, content: string) {
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
  await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveAttribute("aria-selected", "true");
}
const sourceText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".monaco-editor .view-line")]
      .map((line) => (line.textContent ?? "").replace(/ /g, " "))
      .join("\n"),
  );
const bytesOf = (page: Page, src: string) =>
  page.evaluate(async (url) => {
    const buffer = await (await fetch(url)).arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  }, src).then((list) => Buffer.from(list));

test("images: paste diagrams with Ctrl+V, full-width original resolution, zoom viewer, anonymous viewers, mobile", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const instructor = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const url = await createWorkspace(owner, "Kubernetes images");
    const lesson = [
      "# Kubernetes architecture",
      "",
      "The control plane manages the cluster:",
      "",
      "```yaml",
      "apiVersion: v1",
      "kind: Pod",
      "```",
      "",
      "Diagram:",
    ].join("\n");
    expect(await createDoc(owner, "architecture.md", lesson)).toBe(201);
    await open(owner, "architecture.md");
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    const diagram = await diagramPng(owner);

    // 1. Real Ctrl+V: the diagram is on the system clipboard as an image, as after
    //    "Copy image" in a browser, a PDF viewer or a screenshot tool.
    await owner.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
    }, diagram.toString("base64"));
    await owner.locator(".monaco-editor .view-lines").click();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.press("Control+v");
    await expect.poll(() => sourceText(owner)).toMatch(/!\[Pasted image\]\(\/api\/rooms\/[\w-]{16}\/images\/[\w-]{22}\)/);

    // 2. Several images in one paste (an animated GIF and the diagram again), in order.
    const gif = animatedGif();
    await owner.keyboard.press("Control+End");
    await owner.locator(".monaco-editor textarea").evaluate(
      (target, { gif, png }) => {
        const file = (b64: string, name: string, type: string) =>
          new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type });
        const data = new DataTransfer();
        data.items.add(file(gif, "rolling-update.gif", "image/gif"));
        data.items.add(file(png, "cluster-overview.png", "image/png"));
        target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      { gif: gif.toString("base64"), png: diagram.toString("base64") },
    );
    await expect.poll(async () => ((await sourceText(owner)).match(/!\[/g) ?? []).length).toBe(3);
    const source = await sourceText(owner);
    // Existing Markdown and the code block are untouched; images are separate paragraphs.
    expect(source.startsWith(lesson)).toBe(true);
    expect(source).toMatch(/!\[rolling update\]\([^)]+\)\n\n!\[cluster overview\]\([^)]+\)/);

    // 3. Insert Image toolbar dialog (file chooser), at the cursor.
    await owner.locator(".monaco-editor textarea").focus();
    await owner.keyboard.press("Control+End");
    await owner.getByRole("button", { name: "Insert Image" }).click();
    await owner.getByLabel(/Image files/).setInputFiles({ name: "network-flow.png", mimeType: "image/png", buffer: diagram });
    await owner.getByRole("dialog").getByRole("button", { name: "Insert image" }).click();
    await expect.poll(async () => ((await sourceText(owner)).match(/!\[/g) ?? []).length).toBe(4);

    // 4. Anonymous read-only viewer: images render at original resolution, full width.
    await viewer.goto(url);
    await open(viewer, "architecture.md");
    const images = viewer.locator(".markdown-preview .doc-image img");
    await expect(images).toHaveCount(4);
    await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1536);
    const layout = await viewer.locator(".markdown-preview").evaluate((preview) => {
      const style = getComputedStyle(preview);
      const available = preview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const img = preview.querySelector(".doc-image img") as HTMLImageElement;
      const box = img.getBoundingClientRect();
      return { available, width: box.width, ratio: box.height / box.width, natural: img.naturalWidth / img.naturalHeight };
    });
    // Large diagrams use the full available width (the 1536 px image is wider than it).
    expect(Math.abs(layout.width - Math.min(1536, layout.available - 2))).toBeLessThanOrEqual(3);
    expect(layout.width).toBeGreaterThan(900);
    expect(Math.abs(layout.ratio - 1024 / 1536)).toBeLessThan(0.01);
    // Files are stored byte for byte (GIF frames included). The system clipboard itself
    // re-encodes copied images as PNG, so for the Ctrl+V image the pixel size is checked.
    const srcs = await images.evaluateAll((list) => list.map((img) => img.getAttribute("src")!));
    expect(sha(await bytesOf(viewer, srcs[1]))).toBe(sha(gif));
    expect(sha(await bytesOf(viewer, srcs[2]))).toBe(sha(diagram));
    expect(sha(await bytesOf(viewer, srcs[3]))).toBe(sha(diagram));
    expect(
      await images.evaluateAll((list) =>
        (list as HTMLImageElement[]).map((img) => `${img.naturalWidth}x${img.naturalHeight}`),
      ),
    ).toEqual(["1536x1024", "8x8", "1536x1024", "1536x1024"]);
    await expect(images.nth(1)).toHaveAttribute("alt", "rolling update");
    // Viewers cannot upload, resize or insert.
    await expect(viewer.getByRole("button", { name: "Insert Image" })).toHaveCount(0);
    await expect(viewer.locator(".doc-image-resize")).toHaveCount(0);
    expect(
      await viewer.evaluate(async (id) => {
        const response = await fetch(`/api/rooms/${id}/images`, {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        });
        return response.status;
      }, url.split("/").pop()),
    ).toBe(403);
    // Code blocks still highlight next to images.
    await expect(viewer.locator(".inline-block .tk-key").first()).toHaveText("apiVersion");
    await viewer.screenshot({ path: "test-results/images-viewer-desktop.png" });

    // 5. Full-screen viewer: opens fitted, zooms to make small labels readable, pans, closes.
    await viewer.locator(".doc-image-open").first().click();
    const dialog = viewer.getByRole("dialog", { name: /Image/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1,536 × 1,024 px");
    const zoom = () => dialog.getByLabel("Zoom level").textContent().then((t) => parseInt(t ?? "0"));
    const fitted = await zoom();
    expect(fitted).toBeLessThanOrEqual(100);
    await viewer.screenshot({ path: "test-results/images-viewer-fit.png" });
    await dialog.getByRole("button", { name: "1:1" }).click();
    await expect.poll(zoom).toBe(100);
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(zoom).toBe(195);
    // At this zoom each image pixel covers ~2 screen pixels: 11 px labels render ~21 px tall.
    const rendered = await dialog.locator("img").evaluate((img) => img.getBoundingClientRect().width);
    expect(Math.round(rendered)).toBe(Math.round(1536 * 1.953125));
    // Drag to pan.
    const before = await dialog.locator("img").evaluate((img) => img.getBoundingClientRect().left);
    const stage = dialog.locator(".image-viewer-stage");
    const box = (await stage.boundingBox())!;
    await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width / 2 + 300, box.y + box.height / 2 + 100, { steps: 5 });
    await viewer.mouse.up();
    const after = await dialog.locator("img").evaluate((img) => img.getBoundingClientRect().left);
    expect(Math.round(after - before)).toBe(300);
    await viewer.screenshot({ path: "test-results/images-viewer-zoomed.png" });
    // Wheel zoom works too.
    await viewer.mouse.wheel(0, -400);
    await expect.poll(zoom).toBeGreaterThan(195);
    // Esc closes and returns focus to the image.
    await viewer.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(viewer.locator(".doc-image-open").first()).toBeFocused();
    // The close button and a click on the backdrop close it as well.
    await viewer.locator(".doc-image-open").first().click();
    await dialog.getByRole("button", { name: "Close image viewer" }).click();
    await expect(dialog).toHaveCount(0);
    await viewer.locator(".doc-image-open").first().click();
    await stage.click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);

    // 6. Resizing (instructor, Preview): the width is saved and reaches viewers live.
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    const ownerFigure = owner.locator(".doc-image").first();
    // The grip sits at the image's bottom-right corner; bring it on screen first.
    await ownerFigure.locator(".doc-image-resize").scrollIntoViewIfNeeded();
    await ownerFigure.hover();
    const grip = (await ownerFigure.locator(".doc-image-resize").boundingBox())!;
    await owner.mouse.move(grip.x + 8, grip.y + 8);
    await owner.mouse.down();
    await owner.mouse.move(grip.x - 500, grip.y + 8, { steps: 8 });
    await owner.mouse.up();
    await expect.poll(async () => Math.round(await images.first().evaluate((img) => img.getBoundingClientRect().width))).toBeLessThan(layout.width - 400);
    const resized = await images.first().evaluate((img) => {
      const box = img.getBoundingClientRect();
      return box.height / box.width;
    });
    expect(Math.abs(resized - 1024 / 1536)).toBeLessThan(0.01);
    // Double-click the grip: back to the original (full-width) size.
    await ownerFigure.locator(".doc-image-resize").scrollIntoViewIfNeeded();
    await ownerFigure.hover();
    await ownerFigure.locator(".doc-image-resize").dblclick();
    await expect.poll(async () => Math.round(await images.first().evaluate((img) => img.getBoundingClientRect().width))).toBe(Math.round(layout.width));

    // 7. Persistence: a refresh shows the same images.
    await viewer.reload();
    await open(viewer, "architecture.md");
    await expect(images).toHaveCount(4);
    await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1536);

    // 8. Mobile: images fit the screen with their aspect ratio; the viewer still zooms.
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(images.first()).toBeVisible();
    const mobile = await viewer.evaluate(() => {
      const img = document.querySelector(".doc-image img")!.getBoundingClientRect();
      return {
        fits: img.right <= window.innerWidth,
        page: document.documentElement.scrollWidth <= window.innerWidth,
        ratio: img.height / img.width,
      };
    });
    expect(mobile.fits && mobile.page).toBe(true);
    expect(Math.abs(mobile.ratio - 1024 / 1536)).toBeLessThan(0.01);
    await viewer.screenshot({ path: "test-results/images-viewer-mobile.png" });
    await viewer.locator(".doc-image-open").first().click();
    await expect(dialog).toBeVisible();
    await viewer.screenshot({ path: "test-results/images-viewer-mobile-zoom.png" });
    await dialog.getByRole("button", { name: "Close image viewer" }).click();
    await owner.screenshot({ path: "test-results/images-instructor-preview.png" });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
