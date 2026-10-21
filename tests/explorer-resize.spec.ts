import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

const LONG_NAME =
  "module-07-kubernetes-horizontal-pod-autoscaler-troubleshooting-walkthrough.md";

const sidebarWidth = (page: Page) =>
  page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width));
const mainWidth = (page: Page) =>
  page.locator(".editor-main").evaluate((el) => Math.round(el.getBoundingClientRect().width));
const storedWidth = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("devshare.sidebarWidth") ?? "null"));

// Drags the splitter with a real mouse by `dx` pixels.
async function dragBy(page: Page, dx: number) {
  const box = (await page.getByRole("separator", { name: "Resize Explorer" }).boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

// The page itself never scrolls sideways, and the editor always keeps usable room.
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function addFile(page: Page, filename: string) {
  const status = await page.evaluate(async (filename) => {
    const id = location.pathname.split("/")[2];
    const { csrfToken } = await (await fetch("/api/auth/me")).json();
    return (
      await fetch(`/api/rooms/${id}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ filename, language: "markdown", content: "# Autoscaling\n" }),
      })
    ).status;
  }, filename);
  expect(status).toBe(201);
}

test("owner drags, clamps, persists and resets the Explorer width with mouse and keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signUp(page, "Resize Owner");
  await createWorkspace(page, "Resizable explorer");
  await addFile(page, LONG_NAME);

  const handle = page.getByRole("separator", { name: "Resize Explorer" });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(await handle.evaluate((el) => getComputedStyle(el).cursor)).toBe("col-resize");
  expect(await sidebarWidth(page)).toBe(234);
  expect(await storedWidth(page)).toBeNull();

  // Dragging widens the Explorer and the editor gives up exactly that space.
  const total = (await sidebarWidth(page)) + (await mainWidth(page));
  await dragBy(page, 120);
  expect(await sidebarWidth(page)).toBe(354);
  expect((await sidebarWidth(page)) + (await mainWidth(page))).toBe(total);
  expect(await storedWidth(page)).toBe(354);
  await expect(handle).toHaveAttribute("aria-valuenow", "354");
  // Monaco follows the new size (automaticLayout).
  await expect
    .poll(() => page.locator(".monaco-editor").first().evaluate((el) => el.clientWidth))
    .toBeLessThanOrEqual(1280 - 354);
  await expect(page.locator("body")).not.toHaveClass(/resizing-explorer/);

  // Survives a refresh.
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  expect(await sidebarWidth(page)).toBe(354);

  // Clamped to the maximum and minimum.
  await dragBy(page, 600);
  expect(await sidebarWidth(page)).toBe(480);
  await expectNoHorizontalOverflow(page);
  await dragBy(page, -600);
  expect(await sidebarWidth(page)).toBe(180);
  expect(await storedWidth(page)).toBe(180);

  // Long filenames truncate inside the Explorer, keep a tooltip, and still open.
  const row = page.locator(".sidebar").getByRole("button", { name: LONG_NAME, exact: true });
  const label = row.locator("span");
  await expect(label).toHaveAttribute("title", LONG_NAME);
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const narrowLabel = await label.evaluate((el) => el.clientWidth);
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(180 + 1);
  await row.click();
  await expect(page.getByRole("tab", { name: LONG_NAME, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Keyboard: arrows step the width; Enter resets.
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await sidebarWidth(page)).toBe(212);
  await page.keyboard.press("End");
  expect(await sidebarWidth(page)).toBe(480);
  // A wider Explorer reveals more of the name.
  expect(await label.evaluate((el) => el.clientWidth)).toBeGreaterThan(narrowLabel + 250);

  // Double-click restores the default and forgets the saved width.
  await handle.dblclick();
  expect(await sidebarWidth(page)).toBe(234);
  expect(await storedWidth(page)).toBeNull();
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  expect(await sidebarWidth(page)).toBe(234);

  // Hiding and showing the Explorer keeps the chosen width.
  await dragBy(page, 60);
  await page.getByRole("button", { name: "Toggle explorer" }).click();
  await expect(handle).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle explorer" }).click();
  expect(await sidebarWidth(page)).toBe(294);
  await page.screenshot({ path: "test-results/explorer-resized-owner.png" });
  expect(errors).toEqual([]);
});

test("touch drag resizes the Explorer on a tablet", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await signUp(page, "Tablet Owner");
    await createWorkspace(page, "Touch explorer");
    expect(await sidebarWidth(page)).toBe(205); // responsive default at <=1100px
    const box = (await page.getByRole("separator", { name: "Resize Explorer" }).boundingBox())!;
    const x = Math.round(box.x + box.width / 2),
      y = Math.round(box.y + box.height / 2);
    // Real touch input through the browser, which the page receives as pointer events.
    const cdp = await context.newCDPSession(page);
    const touch = (type: string, px: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: px, y }],
      });
    await touch("touchStart", x);
    for (let step = 1; step <= 5; step++) await touch("touchMove", x + step * 20);
    await touch("touchEnd", x + 100);
    expect(await sidebarWidth(page)).toBe(305);
    expect(await storedWidth(page)).toBe(305);
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
  }
});

test("editors, registered viewers and anonymous viewers can all resize the Explorer", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  const [owner, ed, vera, student] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    const edEmail = uniqueEmail("ed"),
      veraEmail = uniqueEmail("vera");
    await signUp(ed, "Ed Editor", edEmail);
    await signUp(vera, "Vera Viewer", veraEmail);
    await signUp(owner, "Olivia Owner");
    const url = await createWorkspace(owner, "Shared resizable explorer");
    await addFile(owner, LONG_NAME);
    const statuses = await owner.evaluate(
      async (shares) => {
        const id = location.pathname.split("/")[2];
        const { csrfToken } = await (await fetch("/api/auth/me")).json();
        const out: number[] = [];
        for (const share of shares)
          out.push(
            (
              await fetch(`/api/rooms/${id}/shares`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
                body: JSON.stringify(share),
              })
            ).status,
          );
        return out;
      },
      [
        { email: edEmail, role: "editor" },
        { email: veraEmail, role: "viewer" },
      ],
    );
    for (const status of statuses) expect(status).toBeLessThan(300);

    for (const [page, access] of [
      [ed, "Editing"],
      [vera, "View Only"],
      [student, "View Only"],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(url);
      await expect(page.getByLabel("Workspace access")).toContainText(access);
      expect(await sidebarWidth(page)).toBe(234);
      await dragBy(page, 80);
      expect(await sidebarWidth(page)).toBe(314);
      await page
        .locator(".sidebar")
        .getByRole("button", { name: LONG_NAME, exact: true })
        .click();
      await expect(page.getByRole("tab", { name: LONG_NAME, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.reload();
      await expect(page.getByLabel("Workspace access")).toContainText(access);
      expect(await sidebarWidth(page)).toBe(314);
    }
    // View-only access is unchanged by the splitter.
    for (const page of [vera, student])
      await expect(page.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    await student.screenshot({ path: "test-results/explorer-resized-student.png" });
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});

test("layout stays responsive across screen sizes", async ({ page }) => {
  await signUp(page, "Responsive Owner");
  await createWorkspace(page, "Responsive explorer");
  await addFile(page, LONG_NAME);
  const handle = page.getByRole("separator", { name: "Resize Explorer" });

  for (const [width, height, fallback] of [
    [1920, 1080, 234],
    [1366, 768, 234],
    [1024, 768, 205],
    [800, 900, 190],
    [640, 900, 190],
  ] as const) {
    await page.setViewportSize({ width, height });
    await handle.dblclick();
    expect(await sidebarWidth(page)).toBe(fallback);
    await dragBy(page, 1000);
    const widest = await sidebarWidth(page);
    expect(widest).toBe(Math.max(180, Math.min(480, width - 340)));
    expect(await mainWidth(page)).toBeGreaterThanOrEqual(Math.min(340, width - 180) - 1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/explorer-${width}.png` });
  }

  // A saved wide width is re-clamped when the window later shrinks.
  await page.setViewportSize({ width: 1600, height: 900 });
  await dragBy(page, 1000);
  expect(await sidebarWidth(page)).toBe(480);
  await page.setViewportSize({ width: 700, height: 900 });
  expect(await sidebarWidth(page)).toBe(360);
  await expectNoHorizontalOverflow(page);

  // Phones keep the fixed-width overlay Explorer and no splitter.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle explorer" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(handle).toBeHidden();
  expect(await sidebarWidth(page)).toBe(210);
  await expectNoHorizontalOverflow(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: LONG_NAME, exact: true })
    .click();
  await expect(page.getByRole("tab", { name: LONG_NAME, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.screenshot({ path: "test-results/explorer-390.png" });
});

test("Connected section's anonymous viewer count matches its section and stays inside the Explorer", async ({
  page,
  browser,
}) => {
  await signUp(page, "Connected Owner");
  const url = await createWorkspace(page, "Connected section");
  const count = page.locator(".sidebar-people .anonymous-viewers");
  await expect(count).toHaveText("0 anonymous viewers");
  // The count still updates live when a student opens the read-only link.
  const context = await browser.newContext();
  try {
    const student = await context.newPage();
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await expect(count).toHaveText("1 anonymous viewer");
    await expect(page.locator(".presence-count")).toHaveAttribute("title", "1 anonymous viewer online");

    for (const [width, height, narrowest] of [
      [1440, 900, true],
      [1024, 768, true],
      [390, 844, false],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (width <= 560) {
        await page.reload();
        await expect(page.locator(".status-bar")).toContainText("Connected");
        await page.getByRole("button", { name: "Toggle explorer" }).click();
      } else if (narrowest) await dragBy(page, -600); // minimum Explorer width
      const layout = await count.evaluate((el) => {
        const person = el.parentElement!.querySelector(".person")!;
        const sidebar = el.closest(".sidebar")!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        return {
          fontSize: getComputedStyle(el).fontSize,
          personFontSize: getComputedStyle(person).fontSize,
          textLeft: text.left,
          personLeft: (person.firstElementChild as HTMLElement).getBoundingClientRect().left,
          inside: text.left >= sidebar.left && text.right <= sidebar.right && box.right <= sidebar.right,
          overflow: el.scrollWidth - el.clientWidth,
        };
      });
      expect(layout.fontSize).toBe(layout.personFontSize);
      expect(Math.abs(layout.textLeft - layout.personLeft)).toBeLessThanOrEqual(1);
      expect(layout.inside).toBe(true);
      expect(layout.overflow).toBeLessThanOrEqual(0);
      await page.locator(".sidebar").screenshot({ path: `test-results/connected-${width}.png` });
    }
  } finally {
    await context.close();
  }
});
