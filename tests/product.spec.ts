import { test, expect } from "@playwright/test";

test("instructor returns to remembered courses, previews safe live notes and creates an exact selected snippet", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const studentContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const owner = await ownerContext.newPage(),
    student = await studentContext.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  student.on("pageerror", (e) => errors.push(e.message));
  try {
    await owner.goto("/workspaces");
    await expect(owner.getByText("Your workspace starts here.")).toBeVisible();
    await owner
      .getByRole("button", { name: "Create Workspace", exact: true })
      .first()
      .click();
    const dialog = owner.getByRole("dialog");
    await dialog.getByLabel("Workspace name").fill("Terraform Class");
    await dialog
      .getByLabel("Description")
      .fill("AWS Infrastructure with Terraform");
    await dialog.getByLabel("Your name").fill("Instructor");
    await dialog.getByRole("radio", { name: /^Terraform/ }).check();
    await dialog
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    const privateUrl = owner.url(),
      publicUrl = privateUrl.split("/edit/")[0];
    await expect(owner.getByRole("tab")).toHaveCount(3);
    for (const name of ["main.tf", "variables.tf", "outputs.tf"])
      await expect(owner.getByRole("tab", { name, exact: true })).toBeVisible();
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
      await owner.getByRole("tab", { name, exact: true }).click();
      await owner.locator(".monaco-editor textarea").focus();
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
    await owner
      .locator(".markdown-code")
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(
      "terraform init",
    );
    await file("commands.sh", "terraform init\nterraform plan");
    // Return to root before creating sibling lesson folders.
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
    // Monaco deliberately enables menu mouse-up actions after 100 ms to prevent
    // the opening right-click from accidentally executing an item.
    await owner
      .getByRole("menuitem", {
        name: "Create Code Block from Selection",
        exact: true,
      })
      .click({ delay: 150 });
    await expect(
      owner
        .getByRole("dialog")
        .getByRole("textbox", { name: "Code", exact: true }),
    ).toHaveValue(snippet);
    await expect(
      owner
        .getByRole("dialog")
        .getByRole("combobox", { name: "Language", exact: true }),
    ).toHaveValue("hcl");
    await owner.getByRole("dialog").getByLabel("Title").fill("S3 Bucket");
    await owner
      .getByRole("button", { name: "Create Block", exact: true })
      .click();
    await expect(
      owner.getByRole("article", { name: "S3 Bucket", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("article", { name: "S3 Bucket", exact: true })
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    expect(
      (await owner.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe(snippet);
    await owner
      .getByRole("button", { name: "My Workspaces", exact: true })
      .click();
    await expect(owner).toHaveURL(/\/workspaces$/);
    const card = owner.getByRole("article", {
      name: "Terraform Class",
      exact: true,
    });
    await expect(card).toContainText("AWS Infrastructure with Terraform");
    await expect(card).toContainText("8 files · 1 code block");
    await expect(
      owner.getByRole("region", { name: "Recent activity" }),
    ).toContainText("S3 Bucket");
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
    await card.getByRole("button", { name: "Open", exact: true }).click();
    await expect(
      owner.getByRole("article", { name: "S3 Bucket", exact: true }),
    ).toBeVisible();
    await owner.reload();
    await expect(
      owner.getByRole("article", { name: "S3 Bucket", exact: true }),
    ).toBeVisible();
    await student.goto(publicUrl);
    await expect(student.getByRole("dialog")).toHaveCount(0);
    await expect(student.getByLabel("Your name")).toHaveCount(0);
    await expect(student.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await student
      .getByRole("button", { name: "Open folder 03 - S3", exact: true })
      .click();
    await student
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await expect(
      student.getByRole("article", { name: "S3 Bucket", exact: true }),
    ).toBeVisible();
    expect(
      await student.evaluate(() =>
        localStorage.getItem("devshare.workspaces.v1"),
      ),
    ).toBeNull();
    await student
      .getByRole("button", { name: "Files & Editor", exact: true })
      .click();
    await student.locator(".view-line").first().click({ button: "right" });
    await expect(
      student.getByText("Create Code Block from Selection", { exact: true }),
    ).toHaveCount(0);
    await student.keyboard.press("Escape");
    await student
      .getByRole("button", {
        name: "Open folder 01 - Introduction",
        exact: true,
      })
      .click();
    await student.getByRole("tab", { name: "notes.md", exact: true }).click();
    await expect(
      student.getByRole("heading", { name: "Introduction", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "Files & Editor", exact: true })
      .click();
    await owner
      .getByRole("button", {
        name: "Open folder 01 - Introduction",
        exact: true,
      })
      .click();
    await owner.getByRole("tab", { name: "notes.md", exact: true }).click();
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
    expect(
      await student
        .locator(".markdown-code .snippet-copy")
        .evaluate(
          (button) => button.getBoundingClientRect().right <= innerWidth,
        ),
    ).toBe(true);
    await student.locator(".markdown-code .snippet-copy").click();
    expect(await student.evaluate(() => navigator.clipboard.readText())).toBe(
      "terraform init",
    );
    await student.screenshot({
      path: "test-results/product-notes-mobile.png",
      fullPage: true,
    });
    await owner
      .getByRole("button", { name: "My Workspaces", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Manage Terraform Class", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Copy Student Link", exact: true })
      .click();
    expect(
      await owner.evaluate(() => navigator.clipboard.readText()),
    ).not.toContain("/edit/");
    await owner
      .getByRole("button", { name: "Manage Terraform Class", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Copy Editor Link", exact: true })
      .click();
    expect(
      await owner.evaluate(() => navigator.clipboard.readText()),
    ).toContain(privateUrl);
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
    await owner.goto("/");
    await expect(
      owner.getByRole("article", { name: "Terraform Course", exact: true }),
    ).toBeVisible();
    await owner
      .getByRole("button", { name: "View all workspaces", exact: false })
      .click();
    await owner
      .getByRole("button", { name: "Manage Terraform Course", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Remove from My Workspaces", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Remove shortcut", exact: true })
      .click();
    await expect(owner.getByText("Your workspace starts here.")).toBeVisible();
    const exists = await owner.request.get(
      publicUrl.replace("/w/", "/api/rooms/"),
    );
    expect(exists.status()).toBe(200);
    await owner.goto(privateUrl);
    await expect(owner.getByLabel("Workspace access")).toContainText("Editing");
    await owner
      .getByRole("button", { name: "My Workspaces", exact: true })
      .click();
    await expect(
      owner.getByRole("article", { name: "Terraform Course", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await studentContext.close();
  }
});
