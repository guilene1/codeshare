// Content locks in the browser: the owner locks, schedules and hides content from the padlock
// menu; a student sees padlocks and release dates, can't open locked content, never sees hidden
// content, and sees a release without refreshing. Desktop and phone.
import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

async function seed(page: Page) {
  const url = await createWorkspace(page, "March 2027 DevOps Class", { studentLink: true });
  const id = url.split("/w/")[1];
  const call = (path: string, method: string, body?: unknown) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const { csrfToken } = await (await fetch("/api/auth/me")).json();
        const r = await fetch("/api" + path, { method, headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(body) });
        return r.json();
      },
      { path, method, body },
    );
  const week1 = (await call(`/rooms/${id}/folders`, "POST", { name: "Week 01 - Linux" })).id as string;
  const week2 = (await call(`/rooms/${id}/folders`, "POST", { name: "Week 02 - Networking" })).id as string;
  const week3 = (await call(`/rooms/${id}/folders`, "POST", { name: "Week 03 - Git" })).id as string;
  await call(`/rooms/${id}/documents?folder=${week1}`, "POST", { filename: "Introduction.md", language: "markdown", content: "# Week 01\nWelcome." });
  await call(`/rooms/${id}/documents?folder=${week1}`, "POST", { filename: "Lab-solutions.sh", language: "shell", content: "echo ANSWER-KEY-42\n" });
  await call(`/rooms/${id}/documents?folder=${week2}`, "POST", { filename: "Networking.md", language: "markdown", content: "# Networking" });
  await page.goto(`${url}?folder=${week1}`);
  await expect(page.locator(".status-bar")).toContainText("Connected");
  return { url, id, week1, week2, week3 };
}
const row = (page: Page, name: string) =>
  page.locator(".course-explorer .folder-row, .course-explorer .tree-file-row").filter({ hasText: name }).first();
const padlock = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^Manage access to ${name.replace(/[.]/g, "\\.")}`) });

for (const device of [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test(`${device.name}: lock, schedule and hide from the padlock; students see padlocks and dates, never locked or hidden content`, async ({ browser }) => {
    test.setTimeout(180_000);
    const { name, ...options } = device;
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const owner = await ownerContext.newPage();
    const studentContext = await browser.newContext(options);
    const student = await studentContext.newPage();
    const errors: string[] = [];
    for (const p of [owner, student]) p.on("pageerror", (e) => errors.push(e.message));
    try {
      await signUp(owner, "Course Owner");
      const s = await seed(owner);
      // Every item starts available, with a green open padlock.
      await expect(owner.locator(".course-explorer .lock-toggle.available").first()).toBeVisible();
      await expect(owner.locator(".course-explorer .lock-toggle.locked")).toHaveCount(0);
      // Lock the solutions: amber "Locked", after the server confirms (toast).
      await padlock(owner, "Lab-solutions.sh").click();
      await owner.getByRole("menuitem", { name: "Lock now" }).click();
      await expect(row(owner, "Lab-solutions.sh").locator(".lock-status")).toContainText("Locked");
      await expect(owner.locator(".toast")).toContainText("Locked");
      // Schedule Week 02 (a far date, so it stays locked through the test).
      await padlock(owner, "Week 02 - Networking").click();
      await owner.getByRole("menuitem", { name: "Schedule unlock" }).click();
      const dialog = owner.getByRole("dialog");
      await dialog.getByLabel("Date", { exact: true }).fill("2099-03-15");
      await dialog.getByLabel("Time", { exact: true }).fill("08:00");
      await dialog.getByLabel("Time zone").selectOption("America/New_York");
      await dialog.getByRole("button", { name: "Schedule Unlock" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row(owner, "Week 02 - Networking")).toContainText("Available from Mar 15");
      // Hide Week 03 until released.
      await padlock(owner, "Week 03 - Git").click();
      await owner.getByRole("menuitem", { name: "Lock now" }).click();
      await expect(row(owner, "Week 03 - Git").locator(".lock-status")).toContainText("Locked");
      await padlock(owner, "Week 03 - Git").click();
      await owner.getByRole("menuitem", { name: "Hide from students until released" }).click();
      await expect(row(owner, "Week 03 - Git").locator(".lock-status")).toContainText("Hidden");
      // The student.
      await student.goto(`${s.url}?folder=${s.week1}`);
      await expect(student.getByLabel("Connection status")).toContainText(/Live|Reconnecting|Syncing/);
      await expect(student.locator(".connection-state:not(.offline)")).toBeVisible();
      if (!(await student.locator(".course-explorer").isVisible())) await student.getByRole("button", { name: "Toggle explorer" }).first().click();
      await expect(row(student, "Lab-solutions.sh").locator(".lock-toggle.locked")).toBeVisible();
      await expect(row(student, "Week 02 - Networking")).toContainText("Available from Mar 15");
      await expect(student.getByText("Week 03 - Git")).toHaveCount(0);
      await expect(student.locator("button.lock-toggle")).toHaveCount(0);
      await row(student, "Lab-solutions.sh").getByRole("button", { name: "Lab-solutions.sh" }).click();
      await expect(student.locator(".locked-notice")).toContainText("Lab-solutions.sh is locked");
      expect(await student.content()).not.toContain("ANSWER-KEY-42");
      // Released by the owner: the student's Explorer updates, the file opens, no refresh.
      await padlock(owner, "Lab-solutions.sh").click();
      await owner.getByRole("menuitem", { name: "Unlock now" }).click();
      await expect(row(student, "Lab-solutions.sh").locator(".lock-toggle.available")).toBeVisible({ timeout: 15_000 });
      await row(student, "Lab-solutions.sh").getByRole("button", { name: "Lab-solutions.sh" }).click();
      await expect(student.locator(".monaco-editor").first()).toContainText("ANSWER-KEY-42", { timeout: 15_000 });
      // The page fits the screen.
      expect(await student.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await ownerContext.close();
      await studentContext.close();
    }
  });
}

test("an inherited lock reads \"Locked\" on one line; where it comes from is in the tooltip only", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Inherit Owner");
  await seed(page);
  await padlock(page, "Week 01 - Linux").click();
  await page.getByRole("menuitem", { name: "Lock now" }).click();
  await expect(row(page, "Week 01 - Linux").locator(".lock-status")).toHaveText("Locked");
  // A file inside the locked folder: the same single-line "Locked", muted, with the reason as a tooltip.
  const status = row(page, "Introduction.md").locator(".lock-status.inherited");
  await expect(status).toHaveText("Locked");
  await expect(page.locator(".course-explorer")).not.toContainText("by parent");
  const box = await status.boundingBox();
  const lineHeight = await status.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(box!.height).toBeLessThan(lineHeight * 1.5);
  await expect(status).toHaveAttribute("title", "Introduction.md: locked because a parent folder or the workspace is locked");
  await expect(padlock(page, "Introduction.md")).toHaveAttribute("title", /^Introduction\.md: locked because a parent folder or the workspace is locked/);
  // Its menu shows "Locked" too, with the same explanation on hover.
  await padlock(page, "Introduction.md").click();
  const state = page.locator(".lock-menu-state span");
  await expect(state).toHaveText("Locked");
  await expect(state).toHaveAttribute("title", "Locked because a parent folder or the workspace is locked");
});

test("bulk lock with confirmation, and the lock history records each change", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, "Bulk Owner");
  await seed(page);
  await padlock(page, "Week 02 - Networking").click();
  await page.getByRole("menuitem", { name: "Select several items…" }).click();
  await page.getByRole("checkbox", { name: "Select Week 03 - Git" }).check();
  await page.getByRole("region", { name: "Lock several items" }).getByRole("button", { name: "Lock", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("Lock 2 items?");
  await confirm.getByRole("button", { name: "Lock 2 Items" }).click();
  await expect(row(page, "Week 02 - Networking").locator(".lock-status")).toContainText("Locked");
  await expect(row(page, "Week 03 - Git").locator(".lock-status")).toContainText("Locked");
  await expect(page.getByRole("region", { name: "Lock several items" })).toHaveCount(0);
  await padlock(page, "Week 03 - Git").click();
  await page.getByRole("menuitem", { name: "View lock history" }).click();
  await expect(page.getByRole("dialog")).toContainText("Locked");
  await expect(page.getByRole("dialog")).toContainText("Bulk Owner");
});
