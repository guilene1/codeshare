// Live Coding sessions in the browser: create from the dashboard, go live, viewers watch typing
// in real time and copy files (green Copied!), pause and resume, save into a workspace folder.
import { test, expect } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

test("an instructor runs a live session; a student watches through the link, read-only", async ({ browser }) => {
  test.setTimeout(180_000);
  const teacher = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const student = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
  const errors: string[] = [];
  try {
    const page = await teacher.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await signUp(page, "Live Teacher");
    await createWorkspace(page, "Ansible course");
    await page.goto("/workspaces?view=live");
    await page.getByRole("button", { name: "Create Session" }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("Session name").fill("Week 06 – Ansible Live Coding");
    await create.getByRole("button", { name: "Create Session" }).click();
    await expect(page).toHaveURL(/\/live-sessions\/[\w-]{16}$/);
    await expect(page.locator(".live-pill")).toContainText("DRAFT");
    await page.getByRole("button", { name: "Go Live" }).click();
    await expect(page.locator(".live-pill")).toContainText("LIVE");
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Filename").fill("playbook.yaml");
    await page.getByRole("dialog").getByRole("button", { name: "Create File" }).click();
    await expect(page.getByRole("tab", { name: "playbook.yaml" })).toHaveCount(1);
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("- name: Install Nginx\n", { delay: 25 });
    // Copy Session Link: green, "Copied!", exact link.
    await page.getByRole("button", { name: "Copy Session Link" }).click();
    await expect(page.locator(".live-copy-link")).toHaveClass(/copied/);
    await expect(page.locator(".live-copy-link")).toContainText("Copied!");
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/live\/[\w-]{43}$/);
    // The student (anonymous, phone) opens the link.
    const viewer = await student.newPage();
    viewer.on("pageerror", (e) => errors.push(e.message));
    await viewer.goto(link);
    await expect(viewer.locator(".live-pill")).toContainText("LIVE");
    await expect(viewer.locator(".monaco-editor").first()).toContainText("Install", { timeout: 15_000 });
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("  hosts: webservers\n", { delay: 25 });
    await expect(viewer.locator(".monaco-editor").first()).toContainText("webservers", { timeout: 15_000 });
    await expect(page.locator(".live-pill")).toContainText("1 viewer");
    // Read-only: no file controls, and the editor refuses typing.
    await expect(viewer.getByRole("button", { name: "New file", exact: true })).toHaveCount(0);
    await viewer.locator(".monaco-editor .view-lines").first().click();
    await viewer.keyboard.type("STUDENT");
    await page.waitForTimeout(500);
    await expect(page.locator(".monaco-editor").first()).not.toContainText("STUDENT");
    // Copy file.
    await viewer.getByRole("button", { name: "Copy file" }).click();
    await expect(viewer.locator(".live-copy-file")).toContainText("Copied!");
    expect(await viewer.evaluate(() => navigator.clipboard.readText())).toContain("webservers");
    // Pause, then resume: the student catches up.
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(viewer.locator(".live-banner")).toContainText("paused");
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("  become: true\n", { delay: 25 });
    await page.waitForTimeout(700);
    await expect(viewer.locator(".monaco-editor").first()).not.toContainText("become");
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(viewer.locator(".monaco-editor").first()).toContainText("become", { timeout: 15_000 });
    // Save to the workspace.
    await page.getByRole("button", { name: "Save to Workspace" }).click();
    const save = page.getByRole("dialog");
    await save.getByLabel(/^Workspace/).selectOption({ label: "Ansible course" });
    await save.getByRole("button", { name: "Save to Workspace" }).click();
    await expect(save).toContainText("Saved playbook.yaml");
    await save.getByRole("button", { name: "Done" }).click();
    // End: the student is told.
    await page.getByRole("button", { name: "End Session" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "End Session" }).click();
    await expect(page.locator(".live-pill")).toContainText("ENDED");
    await expect(viewer.getByRole("heading", { name: /Session closed|ended/ })).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
  } finally {
    await teacher.close();
    await student.close();
  }
});
