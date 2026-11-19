// A tab opened before a deploy keeps running the old frontend (a single-page app never reloads by
// itself). The update bar tells it when the server serves a newer bundle, or when a lazily loaded
// part of the old version fails to load. It covers nothing (the page makes room for it), stays
// clickable above open dialogs, works on phones, checks rarely and cheaply, and never reloads on
// its own.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const bar = (page: Page) => page.getByRole("status").filter({ hasText: "A new version of Kodelumi is available." });
// What a person does by coming back to the tab (Playwright keeps pages visible and focused, so
// the browser's own events are dispatched here), optionally past the one-minute gap.
async function comeBack(page: Page, skewMs = 0) {
  await page.evaluate((skew) => {
    if (skew) {
      const real = Date.now;
      Date.now = () => real() + skew;
    }
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  }, skewMs);
}
// The server starts serving another version: its index.html names a different entry bundle.
const servedPage = (url: URL) => url.pathname === "/";
async function deploy(page: Page) {
  const html = await (await page.request.get("/")).text();
  await page.route(servedPage, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html.replace(/index-[\w-]+\.js/, "index-NEWVERSION.js") }),
  );
}
const box = async (l: Locator) => (await l.boundingBox())!;
// Nothing important is under the bar: everything listed starts at or below its bottom edge.
async function expectNothingCovered(page: Page, label: string, targets: Locator[]) {
  const b = await box(bar(page));
  expect(b.y, `${label}: bar at the top`).toBeLessThanOrEqual(1);
  for (const target of targets) {
    if (!(await target.isVisible())) continue;
    const t = await box(target);
    expect(t.y, `${label}: ${target} starts below the bar`).toBeGreaterThanOrEqual(b.y + b.height - 0.5);
  }
  // The page makes room instead of growing: no page scroll in the workspace, no sideways scroll.
  const scroll = await page.evaluate(() => ({ v: document.documentElement.scrollHeight - innerHeight, h: document.documentElement.scrollWidth - innerWidth }));
  expect(scroll.v, `${label}: no vertical page scroll`).toBeLessThanOrEqual(1);
  expect(scroll.h, `${label}: no sideways scroll`).toBeLessThanOrEqual(1);
}

for (const device of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test(`${device.name}: an outdated tab gets a small bar that covers nothing, also above popups, and reloads only when asked`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { name, ...options } = device;
    const context = await browser.newContext({ ...options, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await signUp(page, "Update Owner");
      const url = await createWorkspace(page, "Update bar course");
      const id = url.split("/w/")[1];
      await page.evaluate(async (id) => {
        const { csrfToken } = await (await fetch("/api/auth/me")).json();
        await fetch(`/api/rooms/${id}/folders`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ name: "Week 1" }) });
      }, id);
      await page.reload();
      await expect(page.locator(".status-bar")).toContainText("Connected");
      const workspace = page.locator(".workspace");
      const before = await box(workspace);
      // Same version on the server: checking finds nothing, and the layout is untouched.
      const checked = page.waitForRequest((r) => new URL(r.url()).pathname === "/" && r.resourceType() === "fetch");
      await comeBack(page);
      await checked;
      await page.waitForTimeout(400);
      await expect(bar(page)).toHaveCount(0);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--update-bar"))).toBe("");
      // Lightweight: coming back 30 times within the minute asks the server no more; a hidden tab never asks.
      let requests = 0;
      page.on("request", (r) => new URL(r.url()).pathname === "/" && r.resourceType() === "fetch" && requests++);
      for (let i = 0; i < 30; i++) await comeBack(page);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        const real = Date.now;
        Date.now = () => real() + 120_000;
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForTimeout(500);
      expect(requests, "requests while within the minute or hidden").toBe(0);
      await page.evaluate(() => delete (document as { visibilityState?: unknown }).visibilityState);
      // A deploy: the bar appears; nothing reloads by itself.
      await deploy(page);
      await comeBack(page, 61_000);
      await expect(bar(page)).toBeVisible();
      expect(requests).toBe(1);
      await expect(bar(page).getByRole("button", { name: "Reload" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Dismiss update notice" })).toBeVisible();
      const b = await box(bar(page));
      expect(b.height, "small").toBeLessThanOrEqual(name === "phone" ? 64 : 40);
      await expectNothingCovered(page, name, [workspace, page.locator(".workspace-nav"), page.locator(".activity-summary").first(), page.locator(".editor-main"), page.locator(".status-bar")]);
      const after = await box(workspace);
      expect(after.y).toBeCloseTo(b.height, 0);
      expect(after.height + after.y).toBeCloseTo(before.height + before.y, 0); // same bottom edge: it just makes room
      const pageUrl = page.url();
      await page.waitForTimeout(1500);
      expect(page.url()).toBe(pageUrl);
      // With a popup open: the popup sits below the bar, the bar stays on top and clickable, and
      // the popup's own Copy Folder Link confirmation is unchanged.
      if (!(await page.getByLabel("Manage folder Week 1").isVisible())) await page.getByRole("button", { name: "Toggle explorer" }).first().click();
      await page.getByLabel("Manage folder Week 1").click();
      await page.locator(".folder-menu[open]").getByRole("button", { name: "Share folder" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Share folder “Week 1”" })).toBeVisible();
      await expect(bar(page)).toBeVisible();
      await expectNothingCovered(page, `${name} with popup`, [dialog, dialog.getByRole("button", { name: "Close dialog" })]);
      expect(await bar(page).evaluate((n) => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      const copy = dialog.locator('section[aria-label="Folder link"] button.full');
      await copy.click();
      await expect(copy).toHaveText("Copied!");
      await expect(copy).toHaveClass(/\bcopied\b/);
      const link = await dialog.locator('section[aria-label="Folder link"] input').inputValue();
      expect(link.startsWith(`${new URL(url).origin}/w/${id}?folder=`)).toBe(true);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
      await expect(copy).toHaveText("Copy Folder Link", { timeout: 4000 });
      // Dismiss (inside the popup): the bar goes, the popup stays, the page takes its room back.
      await bar(page).getByRole("button", { name: "Dismiss update notice" }).click();
      await expect(bar(page)).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      expect(await box(workspace)).toEqual(before);
      // Reload when asked: the tab runs what the server serves, and the bar is gone.
      await page.reload();
      await expect(page.locator(".status-bar")).toContainText("Connected");
      await comeBack(page, 61_000);
      await expect(bar(page)).toBeVisible();
      await page.unroute(servedPage);
      await Promise.all([page.waitForEvent("load"), bar(page).getByRole("button", { name: "Reload" }).click()]);
      await expect(page.locator(".status-bar")).toContainText("Connected");
      await comeBack(page, 61_000);
      await page.waitForTimeout(800);
      await expect(bar(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("a part of the old version that no longer loads also shows the bar", async ({ page }) => {
  await signUp(page, "Chunk Owner");
  await createWorkspace(page, "Chunk course");
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await page.evaluate(() => window.dispatchEvent(new Event("vite:preloadError")));
  await expect(bar(page)).toBeVisible();
});
