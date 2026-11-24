// The Share Workspace popup's copy controls confirm a copy like the Folder Sharing popup: the
// control that copied turns green with a checkmark (and "Copied!" on the text buttons) for about
// 2 s, the clipboard holds exactly the value, the popup stays open, and a refused copy shows a
// clear red message in that section instead. Desktop and phone; dark and light themes.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createWorkspace, signUp } from "./helpers";

const GREEN = "rgb(23, 134, 95)";
const background = (l: Locator) => l.evaluate((b) => getComputedStyle(b).backgroundColor);
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

for (const device of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
]) {
  test(`${device.name}: every Share Workspace copy control confirms a copy, resets after about 2 s, and a failure says so`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { name, ...options } = device;
    const context = await browser.newContext({ ...options, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await signUp(page, "Copy Owner");
      const url = await createWorkspace(page, "Share copy course");
      const id = url.split("/w/")[1];
      await page.getByRole("button", { name: "Share", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const students = dialog.locator("section").filter({ has: page.getByRole("heading", { name: "Students · View only" }) });
      const editors = dialog.getByRole("region", { name: "Editors" });
      await editors.getByRole("button", { name: "Create Edit Link", exact: true }).click();
      const editField = editors.getByLabel("Edit link", { exact: true });
      await expect(editField).toHaveValue(/\/edit\//);
      const studentLink = await students.getByLabel("Student link", { exact: true }).inputValue();
      const editLink = await editField.inputValue();
      expect(studentLink).toBe(`${new URL(url).origin}/w/${id}`);
      // Text buttons are found by position, not by name: their name is "Copied!" while confirming.
      const controls = [
        { label: "student link icon", control: students.getByRole("button", { name: "Copy student link", exact: true }), value: studentLink, text: null },
        { label: "Copy Student Link", control: students.locator("button.full"), value: studentLink, text: "Copy Student Link" },
        { label: "workspace code icon", control: students.getByRole("button", { name: "Copy workspace code", exact: true }), value: id, text: null },
        { label: "edit link icon", control: editors.getByRole("button", { name: "Copy edit link", exact: true }), value: editLink, text: null },
        { label: "Copy Edit Link", control: editors.locator("button.full"), value: editLink, text: "Copy Edit Link" },
      ];
      const resting = [];
      for (const c of controls) resting.push(await background(c.control));
      for (const [i, c] of controls.entries()) {
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await c.control.click();
        const at = Date.now();
        // The control that copied: green, checkmark, "Copied!"; nothing else changes.
        await expect(c.control, c.label).toHaveClass(/\bcopied\b/);
        await expect.poll(() => background(c.control), { message: c.label }).toBe(GREEN);
        await expect(c.control.locator("svg.lucide-check"), c.label).toHaveCount(1);
        if (c.text) await expect(c.control).toHaveText("Copied!");
        else await expect(c.control).toHaveAttribute("title", "Copied!");
        for (const other of controls) if (other !== c) await expect(other.control, `${other.label} unchanged`).not.toHaveClass(/\bcopied\b/);
        expect(await clipboard(page), `${c.label}: clipboard`).toBe(c.value);
        await expect(dialog, "popup stays open").toBeVisible();
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        // Back to normal after about 2 seconds.
        await expect(c.control, c.label).not.toHaveClass(/\bcopied\b/, { timeout: 4000 });
        const shown = Date.now() - at;
        expect(shown, `${c.label}: shown for`).toBeGreaterThanOrEqual(1700);
        expect(shown, `${c.label}: shown for`).toBeLessThan(3500);
        await page.mouse.move(0, 0);
        await expect.poll(() => background(c.control), { message: `${c.label} resting colour` }).toBe(resting[i]);
        await expect(c.control.locator("svg.lucide-check")).toHaveCount(0);
        if (c.text) await expect(c.control).toHaveText(c.text);
        else expect(await c.control.getAttribute("title")).toBeNull();
      }
      // Replacing the Edit Link drops a confirmation that was about the old link.
      await editors.locator("button.full").click();
      await expect(editors.locator("button.full")).toHaveText("Copied!");
      await editors.getByRole("button", { name: "Replace link", exact: true }).click();
      await editors.getByRole("button", { name: "Yes, replace link" }).click();
      await expect(editField).not.toHaveValue(editLink);
      await expect(editors.locator("button.full")).toHaveText("Copy Edit Link", { timeout: 1000 });
      // A refused copy: a clear red message in that section, never "Copied!", popup still open.
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
      });
      const failures = [
        { control: controls[1].control, section: students, message: "Couldn’t copy the student link. Select the link above and press Ctrl+C (⌘C on a Mac)." },
        { control: controls[2].control, section: students, message: "Couldn’t copy the workspace code. Select it and press Ctrl+C (⌘C on a Mac)." },
        { control: controls[4].control, section: editors, message: "Couldn’t copy the Edit Link. Show the link above, select it and press Ctrl+C (⌘C on a Mac)." },
        { control: controls[3].control, section: editors, message: "Couldn’t copy the Edit Link. Show the link above, select it and press Ctrl+C (⌘C on a Mac)." },
        { control: controls[0].control, section: students, message: "Couldn’t copy the student link. Select the link above and press Ctrl+C (⌘C on a Mac)." },
      ];
      for (const f of failures) {
        await f.control.click();
        await expect(f.section.getByRole("alert")).toHaveText(f.message);
        await expect(dialog.getByRole("alert")).toHaveCount(1); // only this one
        expect(await f.section.getByRole("alert").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(237, 134, 150)");
        await expect(f.control).not.toHaveClass(/\bcopied\b/);
        await expect(dialog.getByText("Copied!", { exact: true })).toHaveCount(0);
        await expect(dialog).toBeVisible();
      }
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      expect(await students.getByRole("alert").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(180, 35, 58)");
      // Copying works again and clears the message; green in the light theme too.
      await page.evaluate(() => delete (navigator.clipboard as { writeText?: unknown }).writeText);
      const button = controls[1].control;
      await button.click();
      await expect(button).toHaveText("Copied!");
      await expect.poll(() => background(button)).toBe(GREEN);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      expect(await clipboard(page)).toBe(studentLink);
      // The popup fits the screen.
      expect(await dialog.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
