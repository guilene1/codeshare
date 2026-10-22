// Workspace header: branding and workspace navigation stay on the left exactly as before; the
// connection indicator, access badge, settings and theme toggle sit together at the far right.
import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
async function checkHeader(page: Page, role: "viewer" | "owner", width: number) {
  const header = page.locator(".workspace-nav");
  const right = header.locator(".nav-right");
  // Far right, in order: connection, access badge, (editor tools), settings, theme.
  const connection = right.getByLabel("Connection status");
  const access = right.getByLabel("Workspace access");
  const settings = right.getByRole("button", { name: role === "owner" ? "Editor settings" : "Viewing preferences" });
  const theme = right.getByRole("button", { name: /Switch to (light|dark) mode/ });
  for (const item of [connection, access, settings, theme]) await expect(item).toBeVisible();
  const [c, a, s, t] = await Promise.all([connection, access, settings, theme].map(async (l) => (await l.boundingBox())!));
  expect(c.x).toBeLessThan(a.x);
  expect(a.x).toBeLessThan(s.x);
  expect(s.x).toBeLessThan(t.x);
  // Pinned to the right edge (within the header's own padding).
  expect(width - (t.x + t.width)).toBeLessThanOrEqual(24);
  await expect(connection).toContainText(role === "owner" ? "Connected" : "Live");
  await expect(access).toContainText(role === "owner" ? "Editing" : "View Only");

  // Left side unchanged: back link, then logo + "Kodelumi" together, then the workspace name.
  const name = await box(page, ".room-title");
  expect(name.x + name.width).toBeLessThanOrEqual(c.x);
  const brand = header.locator(".workspace-brand");
  if (await brand.isVisible()) {
    const b = (await brand.boundingBox())!;
    expect(b.x).toBeLessThan(name.x);
    const logo = brand.locator(".logo-mark");
    await expect(logo).toBeVisible();
    const l = (await logo.boundingBox())!;
    expect(Math.round(l.height)).toBe(34); // the existing <Logo /> size
    if (width > 800) {
      // Logo and brand name stay together: side by side and vertically aligned.
      const brandName = brand.locator(".brand-name");
      await expect(brandName).toHaveText("Kodelumi");
      const n = (await brandName.boundingBox())!;
      expect(n.x - (l.x + l.width)).toBeGreaterThanOrEqual(0);
      expect(n.x - (l.x + l.width)).toBeLessThan(16);
      expect(Math.abs(n.y + n.height / 2 - (l.y + l.height / 2))).toBeLessThan(4);
    }
    const back = header.locator(".workspace-back");
    if ((await back.count()) && (await back.isVisible())) expect((await back.boundingBox())!.x).toBeLessThan(b.x);
  }
  expect(Math.round((await header.boundingBox())!.height)).toBe(width > 800 ? 70 : 62);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("header: branding left, connection/access/settings/theme far right, for viewers and owners at every width", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await signUp(page, "Header Owner");
  const url = await createWorkspace(page, "Header layout");
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    for (const width of [1440, 1024, 768, 390]) {
      for (const [p, role] of [
        [viewer, "viewer"],
        [page, "owner"],
      ] as const) {
        await p.setViewportSize({ width, height: 900 });
        await expect(p.getByLabel("Connection status")).toContainText(role === "owner" ? "Connected" : "Live");
        // Owners keep connection and access in the status bar; viewers see them only in the header.
        const status = p.locator(".status-bar");
        if (role === "owner") {
          await expect(status).toContainText("Connected");
          await expect(status).toContainText("Editing");
        } else
          for (const duplicate of ["Live", "View Only", "Reconnecting"]) await expect(status).not.toContainText(duplicate);
        await expect(status.locator(".status-language")).toHaveText("Terraform / HCL");
        await expect(status.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
        await checkHeader(p, role, width);
        await p.screenshot({ path: `test-results/header-${role}-${width}.png`, clip: { x: 0, y: 0, width, height: 80 } });
      }
    }
    // Editors keep their language selector and Share; viewers have neither.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByLabel("Programming language")).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    await expect(viewer.getByLabel("Programming language")).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

    // The moved controls still work.
    await viewer.setViewportSize({ width: 1440, height: 900 });
    await viewer.getByRole("button", { name: "Viewing preferences" }).click();
    await expect(viewer.getByRole("dialog")).toBeVisible();
    await viewer.keyboard.press("Escape");
    const before = await viewer.evaluate(() => document.documentElement.dataset.theme ?? "");
    await viewer.getByRole("button", { name: /Switch to (light|dark) mode/ }).click();
    await expect.poll(() => viewer.evaluate(() => document.documentElement.dataset.theme ?? "")).not.toBe(before);
  } finally {
    await context.close();
  }
});

test("a viewer's header indicator shows the real state: Live, Reconnecting, then Live again", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page, "State Owner");
  const url = await createWorkspace(page, "Connection state");
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    // Lets the test cut the socket and hold reconnects, like a server restart or network drop.
    await viewer.addInitScript(() => {
      const Native = window.WebSocket;
      const w = window as unknown as { __blockSockets: boolean; __sockets: WebSocket[] };
      w.__blockSockets = false;
      w.__sockets = [];
      window.WebSocket = class extends Native {
        constructor(target: string | URL, protocols?: string | string[]) {
          super(w.__blockSockets ? "ws://127.0.0.1:9/blocked" : target, protocols);
          w.__sockets.push(this);
        }
      };
    });
    await viewer.goto(url);
    const indicator = viewer.getByLabel("Connection status");
    await expect(indicator).toContainText("Live");
    await expect(indicator).not.toHaveClass(/offline/);
    await viewer.evaluate(() => {
      const w = window as unknown as { __blockSockets: boolean; __sockets: WebSocket[] };
      w.__blockSockets = true;
      for (const socket of w.__sockets) socket.close();
    });
    await expect(indicator).toContainText("Reconnecting");
    await expect(indicator).toHaveClass(/offline/);
    await expect(viewer.locator(".status-bar")).not.toContainText("Reconnecting");
    await viewer.evaluate(() => ((window as unknown as { __blockSockets: boolean }).__blockSockets = false));
    await expect(indicator).toContainText("Live", { timeout: 15_000 });
    await expect(indicator).not.toHaveClass(/offline/);
  } finally {
    await context.close();
  }
});
