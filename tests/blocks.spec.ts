import { test, expect } from "@playwright/test";

test("instructor manages independent highlighted blocks; students copy each snippet and command read-only", async ({
  browser,
}) => {
  const instructor = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const student = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
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
    await owner
      .getByLabel("Workspace name")
      .fill("Terraform teaching snippets");
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Create Workspace", exact: true })
      .click();
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    const privateUrl = owner.url();
    await viewer.goto(privateUrl.split("/edit/")[0]);
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
    await expect(viewer.getByLabel("Your name")).toHaveCount(0);
    await expect(viewer.locator(".status-bar")).toContainText("Live");
    await owner
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await viewer
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await expect(
      viewer.getByRole("button", { name: "Add Code Block", exact: true }),
    ).toHaveCount(0);
    const provider = 'provider "aws" {\n  region = "us-east-1"\n}';
    async function add(title: string, language: string, content: string) {
      await owner
        .getByRole("button", { name: "Add Code Block", exact: true })
        .click();
      const dialog = owner.getByRole("dialog");
      await dialog.getByLabel("Title").fill(title);
      await dialog
        .getByRole("combobox", { name: "Language", exact: true })
        .selectOption(language);
      await dialog
        .getByRole("textbox", { name: "Code", exact: true })
        .fill(content);
      await dialog
        .getByRole("button", { name: "Add Block", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    }
    await add("Terraform Provider", "hcl", provider);
    for (const command of [
      "terraform init",
      "terraform plan",
      "terraform apply",
    ])
      await add("", "shell", command);
    await expect(viewer.locator(".snippet-card")).toHaveCount(4);
    const providerCard = viewer.getByRole("article", {
      name: "Terraform Provider",
      exact: true,
    });
    await expect(providerCard.locator('[class^="mtk"]').first()).toBeVisible();
    await expect(providerCard).not.toContainText("```");
    await providerCard
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    await expect(
      providerCard.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
    expect(
      (await viewer.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe(provider);
    await expect(
      providerCard.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible({ timeout: 4000 });
    for (const command of [
      "terraform init",
      "terraform plan",
      "terraform apply",
    ]) {
      const card = viewer.getByRole("article", { name: command, exact: true });
      await expect(card).toHaveClass(/compact/);
      await card.getByRole("button", { name: "Copy", exact: true }).click();
      expect(await viewer.evaluate(() => navigator.clipboard.readText())).toBe(
        command,
      );
    }
    await expect(
      viewer.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Delete block", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Move block up", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByRole("button", { name: "Copy code", exact: true }),
    ).toHaveCount(0);
    // Native selection and copying remains available independently of the Copy buttons.
    await viewer
      .getByRole("article", { name: "terraform init", exact: true })
      .locator("code")
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await viewer.keyboard.press("Control+c");
    expect(
      (await viewer.evaluate(() => navigator.clipboard.readText())).trim(),
    ).toBe("terraform init");
    await owner
      .getByRole("article", { name: "terraform plan", exact: true })
      .getByRole("button", { name: "Move block up", exact: true })
      .click();
    await expect(viewer.locator(".snippet-card").nth(1)).toHaveAttribute(
      "aria-label",
      "terraform plan",
    );
    await owner
      .getByRole("article", { name: "Terraform Provider", exact: true })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await owner.getByRole("dialog").getByLabel("Title").fill("Python example");
    await owner
      .getByRole("dialog")
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("python");
    await owner
      .getByRole("dialog")
      .getByRole("textbox", { name: "Code", exact: true })
      .fill('print("hello students")');
    await owner
      .getByRole("button", { name: "Save Block", exact: true })
      .click();
    await expect(
      viewer.getByRole("article", { name: "Python example", exact: true }),
    ).toContainText('print("hello students")');
    await expect(
      viewer.getByRole("article", { name: "Python example", exact: true }),
    ).toContainText("Python");
    await owner
      .getByRole("article", { name: "terraform apply", exact: true })
      .getByRole("button", { name: "Delete block", exact: true })
      .click();
    await owner
      .getByRole("dialog")
      .getByRole("button", { name: "Delete Block", exact: true })
      .click();
    await expect(viewer.locator(".snippet-card")).toHaveCount(3);
    await add("Terraform Provider", "hcl", provider);
    await add(
      "HTML example",
      "html",
      "<script>window.snippetExecuted = true</script>",
    );
    expect(
      await viewer.evaluate(
        () =>
          (window as unknown as { snippetExecuted?: boolean }).snippetExecuted,
      ),
    ).toBeUndefined();
    await expect(
      viewer.getByRole("article", { name: "HTML example", exact: true }),
    ).toContainText("<script>");
    await owner.screenshot({
      path: "test-results/code-blocks-instructor-dark.png",
      fullPage: true,
    });
    await viewer.screenshot({
      path: "test-results/code-blocks-student-dark.png",
      fullPage: true,
    });
    await viewer
      .getByRole("button", { name: "Switch to light mode", exact: true })
      .click();
    await expect(viewer.locator("html")).toHaveAttribute("data-theme", "light");
    await viewer.screenshot({
      path: "test-results/code-blocks-student-light.png",
      fullPage: true,
    });
    await viewer.reload();
    await expect(viewer.locator(".status-bar")).toContainText("Live");
    await viewer
      .getByRole("button", { name: "Code Blocks", exact: false })
      .click();
    await expect(viewer.locator(".snippet-card")).toHaveCount(5);
    await viewer.setViewportSize({ width: 390, height: 844 });
    await expect(
      viewer
        .getByRole("article", { name: "terraform init", exact: true })
        .getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    expect(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await viewer.screenshot({
      path: "test-results/code-blocks-student-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
