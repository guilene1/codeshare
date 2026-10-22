// A viewer alone in a quiet workspace must stay connected. y-websocket reconnects a client
// that receives nothing for 30 seconds; the server's echo of the viewer's own presence (renewed
// every 15 s) is what keeps it connected. Without it the page "refreshed" every ~30 s.
import { test, expect } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const COUNT_SOCKETS = () => {
  const w = window as unknown as { __opens: number; __closes: number };
  w.__opens = 0;
  w.__closes = 0;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("open", () => w.__opens++);
      this.addEventListener("close", () => w.__closes++);
    }
  };
};

test("a viewer alone in a quiet workspace stays connected past y-websocket's 30 s timeout", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page, "Quiet Owner");
  const url = await createWorkspace(page, "Quiet workspace");
  await page.close(); // no editor stays connected
  const context = await browser.newContext();
  try {
    const viewer = await context.newPage();
    await viewer.addInitScript(COUNT_SOCKETS);
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await expect(viewer.locator(".status-bar")).toContainText("Live");
    // Watch the whole window for the reconnect banner, not just a final snapshot.
    await viewer.evaluate(() => {
      const w = window as unknown as { __bannerSeen: boolean };
      w.__bannerSeen = false;
      new MutationObserver(() => {
        if (document.querySelector(".connection-warning")) w.__bannerSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    // Longer than the client's 30 s silence timeout (this wait is the behaviour under test).
    await viewer.waitForTimeout(40_000);
    const counts = await viewer.evaluate(() => {
      const w = window as unknown as { __opens: number; __closes: number; __bannerSeen: boolean };
      return { opens: w.__opens, closes: w.__closes, bannerSeen: w.__bannerSeen };
    });
    expect(counts).toEqual({ opens: 1, closes: 0, bannerSeen: false });
    await expect(viewer.locator(".status-bar")).toContainText("Live");
  } finally {
    await context.close();
  }
});
