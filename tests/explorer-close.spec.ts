// The Explorer's close X: only on files open as tabs, shown on hover or keyboard focus (always
// on touch screens), closes just that tab, never opens, selects, moves or changes the file.
import { test, expect, devices, type Page } from "@playwright/test";
import { createWorkspace, openFromExplorer, signUp } from "./helpers";

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
const row = (page: Page, name: string) => page.locator(".sidebar .tree-file-row").filter({ has: page.getByRole("button", { name, exact: true }) });
const closeX = (page: Page, name: string) => page.locator(".sidebar").getByRole("button", { name: "Close tab " + name, exact: true });
const tabs = async (page: Page) => (await page.getByRole("tab").allTextContents()).map((t) => t.trim());
const opacity = (page: Page, name: string) => closeX(page, name).evaluate((el) => getComputedStyle(el).opacity);
// Everything that must stay the same: each file's ID, name, folder, position and content.
const snapshot = async (page: Page) => {
  const tree = (await api(page, "/tree")).body.documents as { id: string }[];
  const contents = await Promise.all(tree.map(async (d) => JSON.stringify((await api(page, `/documents/${d.id}/content`)).body)));
  return JSON.stringify(tree) + contents.join("|");
};

test("Explorer X: only open files, hover and keyboard, closes just that tab without opening, selecting or changing anything", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signUp(page, "Explorer Close");
  await createWorkspace(page, "Explorer close");
  for (const [filename, language] of [["lesson-1.md", "markdown"], ["lesson-2.md", "markdown"], ["notes.txt", "plaintext"]])
    expect((await api(page, "/documents", "POST", { filename, language, content: "# " + filename + "\n" })).status).toBe(201);
  for (const name of ["lesson-1.md", "lesson-2.md", "notes.txt"]) await openFromExplorer(page, name);
  expect(await tabs(page)).toEqual(["main.tf", "lesson-1.md", "lesson-2.md", "notes.txt"]);
  const before = await snapshot(page);

  // Only files with open tabs get an X; closed files (variables.tf, outputs.tf) don't.
  for (const name of ["main.tf", "lesson-1.md", "lesson-2.md", "notes.txt"]) await expect(closeX(page, name)).toHaveCount(1);
  for (const name of ["variables.tf", "outputs.tf"]) await expect(closeX(page, name)).toHaveCount(0);
  // Hidden until the row is hovered; small, with a tooltip.
  await page.mouse.move(900, 400);
  expect(await opacity(page, "lesson-1.md")).toBe("0");
  await row(page, "lesson-1.md").hover();
  await expect.poll(() => opacity(page, "lesson-1.md")).toBe("1");
  await expect(closeX(page, "lesson-1.md")).toHaveAttribute("title", "Close tab");
  const box = (await closeX(page, "lesson-1.md").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(24);
  // The X sits inside the row's right edge, not over the file name.
  const rowBox = (await row(page, "lesson-1.md").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  expect(box.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);

  // Closing a file that is not active closes its tab only: notes.txt stays active and
  // lesson-1.md is neither opened nor selected.
  await expect(page.getByRole("tab", { name: "notes.txt", exact: true })).toHaveAttribute("aria-selected", "true");
  await closeX(page, "lesson-1.md").click();
  expect(await tabs(page)).toEqual(["main.tf", "lesson-2.md", "notes.txt"]);
  await expect(page.getByRole("tab", { name: "notes.txt", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "lesson-1.md").locator(".tree-file")).not.toHaveClass(/active/);
  await expect(closeX(page, "lesson-1.md")).toHaveCount(0);
  await expect(page.locator(".sidebar").getByRole("button", { name: "lesson-1.md", exact: true })).toBeVisible();

  // Keyboard: Tab from the file moves to its X, which appears on focus; Enter closes the tab.
  await page.locator(".sidebar").getByRole("button", { name: "lesson-2.md", exact: true }).focus();
  await page.mouse.move(900, 400);
  await page.keyboard.press("Tab");
  await expect(closeX(page, "lesson-2.md")).toBeFocused();
  await expect.poll(() => opacity(page, "lesson-2.md")).toBe("1");
  await page.keyboard.press("Enter");
  expect(await tabs(page)).toEqual(["main.tf", "notes.txt"]);
  await expect(page.getByRole("tab", { name: "notes.txt", exact: true })).toHaveAttribute("aria-selected", "true");

  // Closing the active file works like the tab X: the neighbouring tab becomes active.
  await row(page, "notes.txt").hover();
  await closeX(page, "notes.txt").click();
  expect(await tabs(page)).toEqual(["main.tf"]);
  await expect(page.getByRole("tab", { name: "main.tf", exact: true })).toHaveAttribute("aria-selected", "true");
  // The tab X and Alt+W still work, and the Explorer X disappears with the tab.
  await openFromExplorer(page, "lesson-2.md");
  await page.getByRole("button", { name: "Close lesson-2.md", exact: true }).click();
  await expect(closeX(page, "lesson-2.md")).toHaveCount(0);
  await page.keyboard.press("Alt+w");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".sidebar .tree-file-close")).toHaveCount(0);

  // Nothing was deleted, moved or modified, and a reload restores exactly the open tabs.
  expect(await snapshot(page)).toBe(before);
  await openFromExplorer(page, "notes.txt");
  await page.reload();
  await expect(page.locator(".status-bar")).toContainText("Connected");
  expect(await tabs(page)).toEqual(["notes.txt"]);
  await expect(closeX(page, "notes.txt")).toHaveCount(1);
});

test("Explorer X on a phone and for read-only students", async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  try {
    const owner = await ownerContext.newPage();
    await signUp(owner, "Phone Owner");
    const url = await createWorkspace(owner, "Phone close");
    expect((await api(owner, "/documents", "POST", { filename: "guide.md", language: "markdown", content: "# Guide\n" })).status).toBe(201);
    const before = await snapshot(owner);

    // A student on a touch phone: the X is always visible (no hover) and fits the overlay.
    const student = await phone.newPage();
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await student.getByRole("button", { name: "Toggle explorer" }).click();
    await student.locator(".sidebar").getByRole("button", { name: "guide.md", exact: true }).click();
    await expect(student.getByRole("tab", { name: "guide.md", exact: true })).toHaveAttribute("aria-selected", "true");
    if (!(await student.locator(".sidebar").isVisible())) await student.getByRole("button", { name: "Toggle explorer" }).click();
    await expect(closeX(student, "guide.md")).toBeVisible();
    expect(await opacity(student, "guide.md")).toBe("1");
    const box = (await closeX(student, "guide.md").boundingBox())!;
    const sidebar = (await student.locator(".sidebar").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    expect(await student.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await closeX(student, "guide.md").tap();
    await expect(student.getByRole("tab", { name: "guide.md", exact: true })).toHaveCount(0);
    await expect(closeX(student, "guide.md")).toHaveCount(0);
    // The owner's files and tabs are unaffected.
    expect(await snapshot(owner)).toBe(before);
    await expect(owner.getByRole("tab", { name: "main.tf", exact: true })).toBeVisible();
  } finally {
    await ownerContext.close();
    await phone.close();
  }
});
