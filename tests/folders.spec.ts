import { test, expect } from "@playwright/test";

test("six-month course explorer navigates nested lessons, highlights Terraform/Python/YAML and protects student management", async ({
  browser,
}) => {
  const instructor = await browser.newContext(),
    student = await browser.newContext();
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (error) => errors.push(error.message));
  viewer.on("pageerror", (error) => errors.push(error.message));
  try {
    await owner.goto("/");
    await owner
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await owner.getByLabel("Your name").fill("Instructor");
    await owner.getByLabel("Workspace name").fill("DevOps Class");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    async function folder(name: string) {
      await owner
        .getByRole("button", { name: "Create folder", exact: true })
        .click();
      await owner.getByLabel("Folder name").fill(name);
      await owner
        .getByRole("dialog")
        .getByRole("button", { name: "Create Folder", exact: true })
        .click();
      await expect(
        owner.getByRole("button", { name: "Open folder " + name, exact: true }),
      ).toBeVisible();
    }
    await folder("Week 01 - Linux");
    await folder("Week 04 - Terraform");
    await owner
      .getByRole("button", {
        name: "Open folder Week 04 - Terraform",
        exact: true,
      })
      .click();
    await expect(
      owner.getByText("This folder is empty.", { exact: true }),
    ).toBeVisible();
    async function file(name: string, language: string, code: string) {
      await owner
        .getByRole("button", { name: "New file", exact: true })
        .click();
      await owner.getByLabel("Filename", { exact: true }).fill(name);
      await owner
        .getByRole("dialog")
        .getByLabel("Programming language")
        .selectOption(language);
      await owner
        .getByRole("dialog")
        .getByRole("button", { name: "Create file", exact: true })
        .click();
      await expect(owner.getByRole("tab", { name, exact: true })).toBeVisible();
      await owner.getByRole("tab", { name, exact: true }).click();
      await owner.locator(".monaco-editor textarea").focus();
      await owner.keyboard.type(code, { delay: 25 });
      await expect(owner.locator(".view-lines")).toContainText(
        code.split("\n")[0],
      );
      await expect(
        owner.locator('.view-lines [class^="mtk"]').first(),
      ).toBeVisible();
    }
    await file("main.tf", "hcl", 'provider "aws" {\n  region = "us-east-1"\n}');
    await file("hello.py", "python", 'print("hello students")');
    await file(
      "deployment.yaml",
      "yaml",
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: classroom",
    );
    await owner
      .getByRole("button", { name: "Move file up", exact: true })
      .click();
    await expect(owner.getByRole("tab").nth(1)).toHaveText("deployment.yaml");
    await folder("Examples");
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const studentLink = await owner
      .getByLabel("Student link", { exact: true })
      .inputValue();
    expect(studentLink).toContain("?folder=");
    expect(studentLink).not.toContain("/edit/");
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await viewer.goto(studentLink);
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
    await expect(viewer.getByLabel("Your name")).toHaveCount(0);
    await expect(viewer.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await expect(
      viewer.getByRole("tab", { name: "deployment.yaml", exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("button", { name: "Create folder", exact: true }),
    ).toHaveCount(0);
    await expect(viewer.locator(".folder-menu")).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Move file up", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "New file", exact: true }),
    ).toHaveCount(0);
    await viewer.getByRole("tab", { name: "main.tf", exact: true }).click();
    await owner.getByRole("tab", { name: "main.tf", exact: true }).click();
    await owner.locator(".monaco-editor textarea").focus();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.type("\n# Live lesson edit");
    await expect(viewer.locator(".view-lines")).toContainText(
      "Live lesson edit",
    );
    await viewer
      .getByRole("button", { name: "Open folder Week 01 - Linux", exact: true })
      .click();
    await expect(
      viewer.getByText("Your instructor’s files will appear here.", {
        exact: true,
      }),
    ).toBeVisible();
    await viewer
      .getByRole("button", {
        name: "Open folder Week 04 - Terraform",
        exact: true,
      })
      .click();
    await expect(
      viewer.getByRole("tab", { name: "hello.py", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await owner
      .getByRole("button", { name: "Add Code Block", exact: true })
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("textbox", { name: "Code", exact: true })
      .fill("terraform init");
    await owner
      .getByRole("dialog")
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("shell");
    await owner.getByRole("button", { name: "Add Block", exact: true }).click();
    await viewer
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await expect(
      viewer.getByRole("article", { name: "terraform init", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Open folder Examples", exact: true })
      .click();
    await expect(owner.locator(".snippet-card")).toHaveCount(0);
    await owner
      .getByRole("button", {
        name: "Open folder Week 04 - Terraform",
        exact: true,
      })
      .click();
    await expect(
      owner.getByRole("article", { name: "terraform init", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Editor settings", exact: true })
      .click();
    await expect(
      owner.getByText("Delete workspace permanently", { exact: true }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Done", exact: true }).click();
    await viewer
      .getByRole("button", { name: "Viewing preferences", exact: true })
      .click();
    await expect(
      viewer.getByText("Delete workspace permanently", { exact: true }),
    ).toHaveCount(0);
    await viewer.getByRole("button", { name: "Done", exact: true }).click();
    await owner
      .getByLabel("Manage folder Week 01 - Linux", { exact: true })
      .click();
    await owner
      .locator(".folder-menu[open]")
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    await owner.getByLabel("Folder name").fill("Week 01 - Linux basics");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Rename Folder", exact: true })
      .click();
    await expect(
      viewer.getByRole("button", {
        name: "Open folder Week 01 - Linux basics",
        exact: true,
      }),
    ).toBeVisible();
    await owner
      .getByLabel("Manage folder Week 04 - Terraform", { exact: true })
      .click();
    await owner
      .locator(".folder-menu[open]")
      .getByRole("button", { name: "Move up", exact: true })
      .click();
    await expect(
      viewer.locator(".course-explorer .folder-open").first(),
    ).toHaveText("Week 04 - Terraform");
    await owner.getByLabel("Manage folder Examples", { exact: true }).click();
    await owner
      .locator(".folder-menu[open]")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Delete Folder", exact: true })
      .click();
    await expect(
      viewer.getByRole("button", { name: "Open folder Examples", exact: true }),
    ).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Files & Editor", exact: true })
      .click();
    await owner.screenshot({
      path: "test-results/course-explorer-dark.png",
      fullPage: true,
    });
    await owner
      .getByRole("button", { name: "Switch to light mode", exact: true })
      .click();
    await owner.screenshot({
      path: "test-results/course-explorer-light.png",
      fullPage: true,
    });
    await owner.reload();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    await expect(
      owner.getByRole("tab", { name: "main.tf", exact: true }),
    ).toBeVisible();
    await expect(
      owner.getByRole("button", {
        name: "Open folder Week 01 - Linux basics",
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
