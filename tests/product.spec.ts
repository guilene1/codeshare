import { test, expect } from "@playwright/test";
import { signIn, signUp } from "./helpers";

test("instructor's account dashboard follows them across devices, previews safe live notes and turns an exact selection into an inline lesson block", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const secondDevice = await browser.newContext();
  const studentContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await ownerContext.newPage(),
    laptop = await secondDevice.newPage(),
    student = await studentContext.newPage();
  const errors: string[] = [];
  for (const page of [owner, laptop, student])
    page.on("pageerror", (e) => errors.push(e.message));
  try {
    const email = await signUp(owner, "Instructor");
    await expect(owner.getByText("Your workspace starts here.")).toBeVisible();
    await owner
      .locator(".workspace-dashboard")
      .getByRole("button", { name: "Create Workspace", exact: true })
      .first()
      .click();
    const dialog = owner.getByRole("dialog");
    await dialog.getByLabel("Workspace name").fill("Terraform Class");
    await dialog
      .getByLabel("Description")
      .fill("AWS Infrastructure with Terraform");
    await expect(dialog.getByLabel("Your name")).toHaveCount(0);
    await dialog.getByRole("radio", { name: /^Terraform/ }).check();
    await dialog
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    const publicUrl = owner.url();
    expect(publicUrl).not.toContain("/edit/");
    // Three template files exist; only the first is opened as a tab.
    for (const name of ["main.tf", "variables.tf", "outputs.tf"])
      await expect(
        owner.locator(".sidebar").getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await expect(owner.getByRole("tab")).toHaveCount(1);
    async function folder(name: string) {
      await owner
        .getByRole("button", { name: "Create folder", exact: true })
        .click();
      await owner.getByLabel("Folder name").fill(name);
      await owner
        .getByRole("dialog")
        .getByRole("button", { name: "Create Folder", exact: true })
        .click();
      await owner
        .getByRole("button", { name: "Open folder " + name, exact: true })
        .click();
      await expect(
        owner.getByText("This folder is empty.", { exact: true }),
      ).toBeVisible();
    }
    async function file(name: string, source: string) {
      await owner
        .getByRole("button", { name: "New file", exact: true })
        .first()
        .click();
      await owner.getByLabel("Filename", { exact: true }).fill(name);
      await owner
        .getByRole("dialog")
        .getByRole("button", { name: "Create file", exact: true })
        .click();
      await expect(owner.getByRole("tab", { name, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await owner.locator(".monaco-editor textarea").first().focus();
      await owner.evaluate(
        (content) => navigator.clipboard.writeText(content),
        source,
      );
      await owner.keyboard.press("Control+v");
    }
    await folder("01 - Introduction");
    const markdown =
      "# Introduction\n\nLearn **Terraform** safely.\n\n- Read the plan\n- Review the resources\n\n```bash\nterraform init\n```\n\n<script>window.notesExecuted = true</script>\n\n[Unsafe](javascript:alert(1))";
    await file("notes.md", markdown);
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(
      owner.getByRole("heading", { name: "Introduction", exact: true }),
    ).toBeVisible();
    await expect(owner.locator(".markdown-preview strong")).toHaveText(
      "Terraform",
    );
    await expect(owner.locator(".markdown-preview script")).toHaveCount(0);
    await expect(
      owner.locator('.markdown-preview a[href^="javascript:"]'),
    ).toHaveCount(0);
    expect(
      await owner.evaluate(
        () => (window as unknown as { notesExecuted?: boolean }).notesExecuted,
      ),
    ).toBeUndefined();
    await expect(owner.locator(".inline-block-label")).toHaveText(
      "Bash / Shell",
    );
    await owner
      .locator(".inline-block")
      .getByRole("button", { name: "Copy code", exact: true })
      .click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(
      "terraform init",
    );
    await file("commands.sh", "terraform init\nterraform plan");
    await owner.getByTitle("Open workspace root").click();
    await folder("02 - AWS Provider");
    await file("provider.tf", 'provider "aws" {\n  region = "us-east-1"\n}');
    await file("variables.tf", 'variable "region" {\n  type = string\n}');
    await owner.getByTitle("Open workspace root").click();
    await folder("03 - S3");
    const snippet =
      'resource "aws_s3_bucket" "example" {\n  bucket = "my-training-bucket"\n}';
    await file(
      "main.tf",
      "# Lesson context\n" + snippet + "\n# Keep this outside the snippet",
    );
    await owner.locator(".monaco-editor textarea").focus();
    await owner.keyboard.press("Control+Home");
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("Home");
    await owner.keyboard.down("Shift");
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("End");
    await owner.keyboard.up("Shift");
    await owner.locator(".view-line").nth(1).click({ button: "right" });
    // Monaco enables menu mouse-up actions after 100 ms.
    await owner
      .getByRole("menuitem", {
        name: "Create Code Block from Selection",
        exact: true,
      })
      .click({ delay: 150 });
    // From a source file, the selection becomes a block inside a lesson document.
    await expect(owner.getByLabel("Code block content")).toHaveValue(snippet);
    await expect(owner.getByLabel("Code block language")).toHaveValue("hcl");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Add to lesson", exact: true })
      .click();
    await expect(
      owner.getByRole("tab", { name: "lesson.md", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await owner.getByRole("button", { name: "Preview", exact: true }).click();
    await owner
      .locator(".inline-block")
      .getByRole("button", { name: "Copy code", exact: true })
      .click();
    expect(
      (await owner.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe(snippet);
    // The source file is unchanged.
    await owner.getByRole("tab", { name: "main.tf", exact: true }).click();
    await expect(owner.locator(".view-lines")).toContainText(
      "Keep this outside the snippet",
    );
    await owner
      .getByRole("button", { name: "My Workspaces", exact: true })
      .click();
    await expect(owner).toHaveURL(/\/workspaces$/);
    const card = owner.getByRole("article", {
      name: "Terraform Class",
      exact: true,
    });
    await expect(card).toContainText("AWS Infrastructure with Terraform");
    await expect(card).toContainText("9 files · 3 folders");
    await expect(
      owner.getByRole("region", { name: "Recent activity" }),
    ).toContainText("lesson.md");
    await owner.getByLabel("Search workspaces").fill("does not exist");
    await expect(card).toHaveCount(0);
    await owner.getByLabel("Search workspaces").fill("Terraform");
    await owner.getByLabel("Sort workspaces").selectOption("name");
    await owner.screenshot({
      path: "test-results/product-dashboard-dark.png",
      fullPage: true,
    });
    await owner.getByRole("button", { name: "Switch to light mode" }).click();
    await owner.screenshot({
      path: "test-results/product-dashboard-light.png",
      fullPage: true,
    });
    // Another device: signing in shows the same workspaces with owner access.
    await signIn(laptop, email);
    await laptop
      .getByRole("article", { name: "Terraform Class", exact: true })
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await expect(laptop.getByLabel("Workspace access")).toContainText("Editing");
    expect(
      await laptop.evaluate(() =>
        Object.values(localStorage).some((value) => /[\w-]{43}/.test(value)),
      ),
    ).toBe(false);
    // Students: no account, no name, view only.
    await student.goto(publicUrl);
    await expect(student.getByRole("dialog")).toHaveCount(0);
    await expect(student.getByLabel("Your name")).toHaveCount(0);
    await expect(student.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await student
      .getByRole("button", { name: "Open folder 03 - S3", exact: true })
      .click();
    await expect(
      student.getByRole("tab", { name: "main.tf", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await student.locator(".view-line").first().click({ button: "right" });
    await expect(
      student.getByText("Create Code Block from Selection", { exact: true }),
    ).toHaveCount(0);
    await student.keyboard.press("Escape");
    await student
      .locator(".sidebar")
      .getByRole("button", { name: "lesson.md", exact: true })
      .click();
    await expect(student.locator(".inline-block")).toContainText("aws_s3_bucket");
    await expect(
      student.getByRole("button", { name: "Edit code block" }),
    ).toHaveCount(0);
    expect(
      await student.evaluate(() =>
        localStorage.getItem("devshare.workspaces.v1"),
      ),
    ).toBeNull();
    await student
      .getByRole("button", {
        name: "Open folder 01 - Introduction",
        exact: true,
      })
      .click();
    await expect(
      student.getByRole("heading", { name: "Introduction", exact: true }),
    ).toBeVisible();
    await owner.goto(publicUrl);
    await owner
      .getByRole("button", {
        name: "Open folder 01 - Introduction",
        exact: true,
      })
      .click();
    await owner.getByRole("tab", { name: "notes.md", exact: true }).click();
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await owner.locator(".monaco-editor textarea").focus();
    await owner.keyboard.press("Control+End");
    await owner.keyboard.insertText("\n\n## Live notes\nUpdated together.");
    await expect(
      student.getByRole("heading", { name: "Live notes", exact: true }),
    ).toBeVisible();
    await student.setViewportSize({ width: 390, height: 844 });
    await student
      .getByRole("button", { name: "Toggle explorer", exact: true })
      .click();
    const copyButton = student.locator(".inline-block .snippet-copy");
    expect(
      await copyButton.evaluate(
        (button) => button.getBoundingClientRect().right <= innerWidth,
      ),
    ).toBe(true);
    await copyButton.click();
    expect(await student.evaluate(() => navigator.clipboard.readText())).toBe(
      "terraform init",
    );
    await student.screenshot({
      path: "test-results/product-notes-mobile.png",
      fullPage: true,
    });
    // Dashboard management: student link, rename and confirmed deletion.
    await owner
      .getByRole("button", { name: "My Workspaces", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Manage Terraform Class", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Copy Student Link", exact: true })
      .click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(
      publicUrl,
    );
    await owner
      .getByRole("button", { name: "Manage Terraform Class", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Rename workspace", exact: true })
      .click();
    await owner.getByLabel("Workspace name").fill("Terraform Course");
    await owner.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(
      owner.getByRole("article", { name: "Terraform Course", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Manage Terraform Course", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Delete workspace", exact: true })
      .click();
    const remove = owner
      .getByRole("dialog")
      .getByRole("button", { name: "Delete workspace", exact: true });
    await expect(remove).toBeDisabled();
    await owner
      .getByLabel("Type the workspace name to confirm")
      .fill("Terraform Course");
    await remove.click();
    await expect(owner.getByText("Your workspace starts here.")).toBeVisible();
    const gone = await owner.request.get(publicUrl.replace("/w/", "/api/rooms/"));
    expect(gone.status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await secondDevice.close();
    await studentContext.close();
  }
});
