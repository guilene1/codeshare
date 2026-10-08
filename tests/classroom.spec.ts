import { test, expect } from "@playwright/test";
import { createWorkspace, openFromExplorer, signUp } from "./helpers";
test("instructor broadcasts to read-only students without leaking the private link", async ({
  browser,
}) => {
  const instructor = await browser.newContext(),
    student = await browser.newContext();
  const owner = await instructor.newPage(),
    viewer = await student.newPage();
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  viewer.on("pageerror", (e) => errors.push(e.message));
  try {
    await signUp(owner, "Instructor");
    const ownerUrl = await createWorkspace(owner, "Cloud classroom");
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const studentUrl = await owner
      .getByLabel("Student link", { exact: true })
      .inputValue();
    // The owner edits through the account, so the Student Link is the plain URL.
    expect(studentUrl).toBe(ownerUrl);
    await expect(
      owner.getByLabel("Private editor link", { exact: true }),
    ).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Create co-editor link", exact: true })
      .click();
    const token = (
      await owner.getByLabel("Private editor link", { exact: true }).inputValue()
    ).split("/edit/")[1];
    expect(token).toMatch(/^[\w-]{43}$/);
    await expect(
      owner.getByRole("button", { name: "Copy Editor Link", exact: true }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await viewer.goto(studentUrl);
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
    await expect(viewer.getByLabel("Your name")).toHaveCount(0);
    await expect(viewer.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await expect(viewer.locator(".status-bar")).toContainText("Live");
    await expect(owner.locator(".presence-count")).toContainText("1");
    await expect(viewer.getByLabel("Programming language")).toHaveCount(0);
    await expect(owner.locator(".sidebar-people")).toContainText(
      "1 anonymous viewers",
    );
    await expect(owner.locator(".sidebar-people .person")).toHaveCount(1);
    for (const label of [
      "New file",
      "My Workspaces",
      "Move file up",
      "Move file down",
      "Saved",
      "Paste code",
      "Add file tab",
      "Rename file",
      "Delete file",
    ])
      await expect(
        viewer.getByRole("button", { name: label, exact: true }),
      ).toHaveCount(0);
    const ownerEditor = owner.locator(".monaco-editor textarea"),
      studentEditor = viewer.locator(".monaco-editor textarea");
    await expect(studentEditor).toBeVisible();
    await studentEditor.focus();
    await viewer.keyboard.press("Control+Home");
    await viewer.keyboard.type("# Not allowed\n");
    await viewer.keyboard.press("Delete");
    await expect(viewer.locator(".view-lines")).not.toContainText(
      "Not allowed",
    );
    await expect(owner.locator(".view-lines")).toContainText(
      "required_providers",
    );
    await ownerEditor.focus();
    await owner.keyboard.press("Control+Home");
    await owner.keyboard.type("# Instructor example\n");
    await expect(viewer.locator(".view-lines")).toContainText(
      "Instructor example",
    );
    await expect(viewer.locator(".status-bar")).toContainText(
      "Instructor is editing",
    );
    await student.grantPermissions(["clipboard-read", "clipboard-write"]);
    await viewer
      .getByRole("button", { name: "Copy file", exact: true })
      .click();
    expect(
      await viewer.evaluate(() => navigator.clipboard.readText()),
    ).toContain("Instructor example");
    await studentEditor.focus();
    await viewer.keyboard.press("Control+a");
    await viewer.keyboard.press("Control+c");
    expect(
      await viewer.evaluate(() => navigator.clipboard.readText()),
    ).toContain("provider");
    await viewer
      .getByRole("button", { name: "Find in file", exact: true })
      .click();
    await expect(viewer.locator(".find-widget")).toBeVisible();
    await viewer.keyboard.press("Escape");
    await viewer.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      viewer.getByRole("button", { name: "Copy Editor Link", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewer.getByLabel("Private editor link", { exact: true }),
    ).toHaveCount(0);
    expect(await viewer.content()).not.toContain(token);
    await viewer.getByRole("button", { name: "Close dialog" }).click();
    const roomId = studentUrl.split("/").pop()!;
    const attacks = await viewer.evaluate(async (id) => {
      const bodies = [
        {
          method: "POST",
          path: "/documents",
          body: { filename: "attack.tf", language: "hcl", role: "editor" },
        },
        { method: "PATCH", path: "", body: { name: "Attack", role: "editor" } },
      ];
      return Promise.all(
        bodies.map(
          async (b) =>
            (
              await fetch("/api/rooms/" + id + b.path, {
                method: b.method,
                headers: {
                  "content-type": "application/json",
                  "X-Role": "editor",
                },
                body: JSON.stringify(b.body),
              })
            ).status,
        ),
      );
    }, roomId);
    expect(attacks).toEqual([403, 403]);
    await viewer.evaluate(() =>
      localStorage.setItem("devshare.role", "editor"),
    );
    await viewer.reload();
    await expect(viewer.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await owner
      .getByRole("button", { name: "Add file tab", exact: true })
      .click();
    await owner
      .getByLabel("Filename", { exact: true })
      .fill("lesson-variables.tf");
    await owner
      .getByRole("button", { name: "Create file", exact: true })
      .click();
    await openFromExplorer(viewer, "lesson-variables.tf");
    await owner.getByLabel("Programming language").selectOption("python");
    await expect(viewer.getByLabel("File language")).toHaveText("python");
    await owner
      .getByRole("button", { name: "Editor settings", exact: true })
      .click();
    await owner
      .getByLabel("Workspace name", { exact: true })
      .fill("Updated classroom");
    await owner
      .getByRole("button", { name: "Save workspace name", exact: true })
      .click();
    await expect(viewer.locator(".room-title")).toContainText(
      "Updated classroom",
    );
    await owner.getByRole("button", { name: "Done", exact: true }).click();
    await viewer.getByRole("button", { name: "Switch to light mode" }).click();
    await viewer
      .getByRole("button", { name: "Viewing preferences", exact: true })
      .click();
    await expect(
      viewer.getByLabel("Workspace name", { exact: true }),
    ).toHaveCount(0);
    await viewer.getByLabel("Font size").selectOption("18");
    await viewer.getByRole("button", { name: "Done", exact: true }).click();
    await viewer.reload();
    await expect(viewer.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(viewer.getByLabel("Workspace access")).toContainText(
      "View Only",
    );
    await viewer.getByRole("tab", { name: "main.tf", exact: true }).click();
    await expect(viewer.locator(".view-lines")).toContainText(
      "Instructor example",
    );
    await viewer.screenshot({ path: "test-results/student-view-light.png" });
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.screenshot({ path: "test-results/instructor-sharing.png" });
    expect(
      await viewer.evaluate(() =>
        localStorage.getItem(
          "devshare.name." + location.pathname.split("/")[2],
        ),
      ),
    ).toBeNull();
    await viewer.close();
    await expect(owner.locator(".presence-count")).toContainText("0 viewers");
    expect(errors).toEqual([]);
  } finally {
    await instructor.close().catch(() => {});
    await student.close().catch(() => {});
  }
});
