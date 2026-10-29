// On a common laptop screen the Create Workspace dialog is taller than the window; its
// Create button must stay in view (it used to sit below the fold, leaving only the dimmed
// dashboard button behind the overlay visible, which looked disabled).
import { test, expect } from "@playwright/test";
import { signUp } from "./helpers";

test("Create Workspace stays visible on a 1280x720 screen for every template, and Empty Workspace creates", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await signUp(page, "Laptop Owner");
  await page.locator(".workspace-dashboard").getByRole("button", { name: "Create Workspace", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workspace name").pressSequentially("Terraform Class");
  await dialog.getByLabel(/Description/).pressSequentially("AWS infrastructure with Terraform");
  const submit = dialog.getByRole("button", { name: "Create Workspace", exact: true });
  // Measured without any scrolling: inside the window and the dialog, enabled, and on top.
  const reachable = () =>
    submit.evaluate((button) => {
      const r = button.getBoundingClientRect(), d = button.closest("dialog")!.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        enabled: !(button as HTMLButtonElement).disabled,
        inWindow: r.top >= 0 && r.bottom <= innerHeight,
        inDialog: r.top >= d.top && r.bottom <= d.bottom,
        onTop: top === button || button.contains(top),
      };
    });
  for (const template of ["Terraform", "Kubernetes", "Python", "General DevOps", "Empty Workspace"]) {
    await dialog.getByText(template, { exact: true }).click();
    expect(await reachable(), template).toEqual({ enabled: true, inWindow: true, inDialog: true, onTop: true });
  }
  // Click it where it is (a real mouse click at its position, no auto-scroll).
  const box = (await submit.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/\/w\/[\w-]{16}$/);
  await expect(page.locator(".status-bar")).toContainText("Connected");
  await expect(page.getByLabel("Workspace access")).toContainText("Editing");
  await expect(page.locator(".sidebar .tree-file")).toHaveCount(0); // Empty Workspace
  const info = await page.evaluate(async () => (await (await fetch("/api/rooms/" + location.pathname.split("/")[2])).json()));
  expect([info.name, info.description]).toEqual(["Terraform Class", "AWS infrastructure with Terraform"]);
});
