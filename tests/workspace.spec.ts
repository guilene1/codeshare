import { test, expect } from "@playwright/test";
test("two isolated browsers collaborate with real Monaco, cursor presence, files and persistent preferences", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const first = await a.newPage(),
    second = await b.newPage();
  const errors: string[] = [];
  first.on("pageerror", (e) => errors.push(e.message));
  second.on("pageerror", (e) => errors.push(e.message));
  try {
    await first.goto("/");
    await expect(
      first.getByRole("heading", { name: "Code together. Learn together." }),
    ).toBeVisible();
    await first.screenshot({
      path: "test-results/landing-dark.png",
      fullPage: true,
    });
    await first
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await first.getByLabel("Your name").fill("Alex");
    await first.getByLabel("Workspace name").fill("Terraform workshop");
    await first
      .getByRole("dialog")
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await expect(first).toHaveURL(/\/w\/[\w-]{16}\/edit\/[\w-]{43}$/);
    await expect(first.locator(".status-bar")).toContainText("Connected");
    await expect(first.locator(".monaco-editor textarea")).toBeVisible();
    await second.goto(first.url());
    await second.getByLabel("Your name").fill("Sam");
    await second
      .getByRole("button", { name: "Open Workspace", exact: true })
      .click();
    await expect(second.locator(".status-bar")).toContainText("Connected");
    await expect(first.locator(".sidebar-people")).toContainText("Sam");
    const firstInput = first.locator(".monaco-editor textarea");
    const secondInput = second.locator(".monaco-editor textarea");
    await firstInput.focus();
    await first.keyboard.press("Control+Home");
    await first.keyboard.type("# Shared lesson\n");
    await expect(second.locator(".view-lines")).toContainText("Shared lesson");
    await secondInput.focus();
    await second.keyboard.press("Control+End");
    await second.keyboard.type("\n# Sam is here");
    await expect(first.locator(".view-lines")).toContainText("Sam is here");
    await expect(
      first.locator('[class*="yRemoteSelectionHead-"]').first(),
    ).toBeVisible();
    await first.screenshot({ path: "test-results/workspace-dark.png" });
    await a.grantPermissions(["clipboard-read", "clipboard-write"]);
    await first.getByRole("button", { name: "Copy code", exact: true }).click();
    const copied = await first.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("# Shared lesson");
    expect(copied).toContain("# Sam is here");
    await first.evaluate(() =>
      navigator.clipboard.writeText("\n# Clipboard snippet"),
    );
    await firstInput.focus();
    await first.keyboard.press("Control+End");
    await first
      .getByRole("button", { name: "Paste code", exact: true })
      .click();
    await expect(second.locator(".view-lines")).toContainText(
      "Clipboard snippet",
    );
    await first.keyboard.press("Control+z");
    await expect(second.locator(".view-lines")).not.toContainText(
      "Clipboard snippet",
    );
    await first.keyboard.press("Control+Shift+z");
    await expect(second.locator(".view-lines")).toContainText(
      "Clipboard snippet",
    );
    await first.getByLabel("Programming language").selectOption("python");
    await expect(second.getByLabel("Programming language")).toHaveValue(
      "python",
    );
    await expect(second.locator(".view-lines")).toContainText("Shared lesson");
    await first.getByLabel("Programming language").selectOption("hcl");
    for (const filename of [
      "lesson-variables.tf",
      "lesson-outputs.tf",
      "notes.md",
    ]) {
      await first
        .getByRole("button", { name: "Add file tab", exact: true })
        .click();
      await first.getByLabel("Filename", { exact: true }).fill(filename);
      await first
        .getByRole("button", { name: "Create file", exact: true })
        .click();
      await expect(
        first.getByRole("tab", { name: filename, exact: true }),
      ).toBeVisible();
    }
    await expect(
      second.getByRole("tab", { name: "lesson-outputs.tf", exact: true }),
    ).toBeVisible();
    await expect(first.getByLabel("Programming language")).toHaveValue(
      "markdown",
    );
    await first
      .getByRole("button", { name: "Rename file", exact: true })
      .click();
    await first.getByLabel("Filename", { exact: true }).fill("lesson.md");
    await first.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(
      second.getByRole("tab", { name: "lesson.md", exact: true }),
    ).toBeVisible();
    await first
      .getByRole("button", { name: "Delete file", exact: true })
      .click();
    await first
      .getByRole("dialog")
      .getByRole("button", { name: "Delete file", exact: true })
      .click();
    await expect(
      second.getByRole("tab", { name: "lesson.md", exact: true }),
    ).toHaveCount(0);
    await first.getByRole("tab", { name: "main.tf", exact: true }).click();
    await first.keyboard.press("Control+s");
    await first.reload();
    await expect(first.locator(".view-lines")).toContainText("Shared lesson");
    await first.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(first.locator("html")).toHaveAttribute("data-theme", "light");
    await first
      .getByRole("button", { name: "Editor settings", exact: true })
      .click();
    await first.getByLabel("Font size").selectOption("18");
    await first.getByLabel("Word wrap").check();
    await first.getByRole("button", { name: "Done", exact: true }).click();
    await first.reload();
    await expect(first.locator("html")).toHaveAttribute("data-theme", "light");
    await first
      .getByRole("button", { name: "Editor settings", exact: true })
      .click();
    await expect(first.getByLabel("Font size")).toHaveValue("18");
    await expect(first.getByLabel("Word wrap")).toBeChecked();
    await first.getByRole("button", { name: "Done", exact: true }).click();
    await first.screenshot({ path: "test-results/workspace-light.png" });
    await a.grantPermissions(["clipboard-read", "clipboard-write"]);
    await first.getByRole("button", { name: "Share", exact: true }).click();
    await first
      .getByRole("dialog")
      .getByRole("button", { name: "Copy Student Link", exact: true })
      .click();
    await expect(first.getByRole("status")).toContainText(
      "Student link copied",
    );
    await expect
      .poll(() => first.evaluate(() => navigator.clipboard.readText()))
      .toBe(first.url().split("/edit/")[0]);
    await first.getByRole("button", { name: "Close dialog" }).click();
    await second.close();
    await expect(first.locator(".sidebar-people")).not.toContainText("Sam");
    await first.setViewportSize({ width: 390, height: 844 });
    await first.getByRole("button", { name: "Toggle explorer" }).click();
    await first.screenshot({ path: "test-results/workspace-mobile.png" });
    expect(
      await first.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});
