import { test, expect } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const TITLE = "Kodelumi • Learn, Code, Share";

test("tab title is exactly the branded title on every page", async ({ page, browser }) => {
  expect(TITLE).not.toMatch(/[|–—]/);
  for (const path of ["/", "/signin", "/signup"]) {
    await page.goto(path);
    await expect(page).toHaveTitle(TITLE);
  }
  await signUp(page, "Title Owner");
  await expect(page).toHaveTitle(TITLE); // My Workspaces dashboard
  const url = await createWorkspace(page, "Title workspace");
  await expect(page).toHaveTitle(TITLE);
  await page.reload();
  await expect(page).toHaveTitle(TITLE);
  // The favicon links are unchanged.
  await expect(page.locator('link[rel="icon"][href="/favicon.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
  // Anonymous read-only viewers see the same title.
  const context = await browser.newContext();
  try {
    const student = await context.newPage();
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await expect(student).toHaveTitle(TITLE);
  } finally {
    await context.close();
  }
});
