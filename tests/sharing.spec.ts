import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

const FENCE = "```";

// Adds a Markdown lesson with a code block and an uploaded image through the owner's API.
async function createLesson(page: Page) {
  return page.evaluate(
    async ({ fence }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 100;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#38bdf8";
      context.fillRect(0, 0, 160, 100);
      const bytes = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const image = await (
        await fetch(`/api/rooms/${id}/images`, {
          method: "POST",
          headers: { "content-type": "image/png", "x-csrf-token": csrfToken },
          body: bytes,
        })
      ).json();
      const content = [
        "# Shared lesson",
        "",
        fence + "bash",
        "kubectl get pods",
        fence,
        "",
        `![diagram](/api/rooms/${id}/images/${image.id})`,
      ].join("\n");
      return (
        await fetch(`/api/rooms/${id}/documents`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ filename: "lesson.md", language: "markdown", content }),
        })
      ).status;
    },
    { fence: FENCE },
  );
}
async function openLesson(page: Page) {
  await page.locator(".sidebar").getByRole("button", { name: "lesson.md", exact: true }).click();
  await expect(page.locator(".markdown-preview .inline-block")).toHaveCount(1);
}
// View-only: each code block keeps its Copy code button (students copy commands), but there
// is no file-level Copy or Download, workspace link copying, or image "Original" link.
async function expectViewOnlyControls(page: Page) {
  for (const label of ["Copy file", "Download file", "Copy workspace link", "Share"])
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  await expect(page.locator(".inline-block").getByRole("button", { name: "Copy code" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Copy/ })).toHaveCount(1);
  await page.getByRole("button", { name: /Open image full screen/ }).click();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Original/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close image viewer" }).click();
}

test("sharing: Viewer and Editor accounts, Shared with Me, view-only controls, anonymous links unchanged", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const contexts = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      browser.newContext(i === 0 ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
    ),
  );
  const [owner, vera, ed, student] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, vera, ed, student]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    const veraEmail = uniqueEmail("vera"),
      edEmail = uniqueEmail("ed");
    await signUp(vera, "Vera Viewer", veraEmail);
    await signUp(ed, "Ed Editor", edEmail);
    // Nothing shared yet.
    await expect(vera.getByRole("region", { name: "Shared with Me" })).toContainText(
      "Nothing has been shared with you yet",
    );

    await signUp(owner, "Olivia Owner");
    const url = await createWorkspace(owner, "Shared Kubernetes lab");
    expect(await createLesson(owner)).toBe(201);
    await openLesson(owner);

    // Owner: full Copy and Download controls.
    for (const label of ["Copy workspace link", "Share", "Copy file", "Download file"])
      await expect(owner.getByRole("button", { name: label, exact: true })).toBeVisible();
    await owner.locator(".inline-block").getByRole("button", { name: "Copy code" }).click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe("kubectl get pods");
    const download = owner.waitForEvent("download");
    await owner.getByRole("button", { name: "Download file", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("lesson.md");
    await owner.getByRole("button", { name: /Open image full screen/ }).click();
    await expect(owner.getByRole("link", { name: /Original/ })).toBeVisible();
    await owner.getByRole("button", { name: "Close image viewer" }).click();

    // Share by email with existing accounts only; unknown emails are refused, no invites.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const people = owner.getByRole("region", { name: "People with access" });
    await expect(people).toContainText("Not shared with any accounts yet.");
    await people.getByLabel("Email address").fill(uniqueEmail("nobody"));
    await people.getByRole("button", { name: "Share", exact: true }).click();
    await expect(people.getByRole("alert")).toContainText("No Kodelumi account uses that email");
    await people.getByLabel("Email address").fill(veraEmail);
    await people.getByRole("button", { name: "Share", exact: true }).click();
    await expect(people.locator(".people-list li")).toHaveCount(1);
    await people.getByLabel("Email address").fill(edEmail);
    await people.getByLabel("Permission", { exact: true }).selectOption("editor");
    await people.getByRole("button", { name: "Share", exact: true }).click();
    await expect(people.locator(".people-list li")).toHaveCount(2);
    await expect(people.getByLabel("Permission for Vera Viewer")).toHaveValue("viewer");
    await expect(people.getByLabel("Permission for Ed Editor")).toHaveValue("editor");
    // The class link still works for everyone, with no account.
    await expect(owner.getByLabel("Student link", { exact: true })).toHaveValue(url);
    await owner.screenshot({ path: "test-results/sharing-owner-people.png" });
    await owner.getByRole("button", { name: "Close dialog" }).click();

    // Viewer share: Shared with Me lists it; opening it is view-only, code blocks copyable.
    await vera.reload();
    const veraShared = vera.getByRole("region", { name: "Shared with Me" });
    const card = veraShared.getByRole("article", { name: "Shared Kubernetes lab" });
    await expect(card).toContainText("Viewer");
    await expect(card).toContainText("Shared by Olivia Owner");
    await vera.screenshot({ path: "test-results/sharing-shared-with-me.png" });
    await card.getByRole("button", { name: /Open/ }).click();
    await expect(vera.getByLabel("Workspace access")).toContainText("View Only");
    await openLesson(vera);
    await expectViewOnlyControls(vera);
    for (const label of ["Edit code block", "Insert Code Block", "New file", "Rename file", "Delete file"])
      await expect(vera.getByRole("button", { name: label, exact: true })).toHaveCount(0);

    // Anonymous student: same view-only interface, straight from the link.
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await expect(student.getByLabel("Your name")).toHaveCount(0);
    await openLesson(student);
    await expectViewOnlyControls(student);
    await student.screenshot({ path: "test-results/sharing-student-view-only.png" });

    // Editor share: edits content and keeps Copy, but cannot manage the workspace.
    await ed.reload();
    await ed
      .getByRole("region", { name: "Shared with Me" })
      .getByRole("article", { name: "Shared Kubernetes lab" })
      .getByRole("button", { name: /Open/ })
      .click();
    await expect(ed.getByLabel("Workspace access")).toContainText("Editing");
    await openLesson(ed);
    await expect(ed.locator(".inline-block").getByRole("button", { name: "Copy code" })).toBeVisible();
    await expect(ed.getByRole("button", { name: "Download file", exact: true })).toBeVisible();
    await ed.getByRole("button", { name: "Share", exact: true }).click();
    await expect(ed.getByRole("region", { name: "People with access" })).toHaveCount(0);
    await ed.getByRole("button", { name: "Close dialog" }).click();
    await ed.getByRole("button", { name: "Editor settings", exact: true }).click();
    await expect(ed.getByLabel("Workspace name", { exact: true })).toHaveCount(0);
    await ed.getByRole("button", { name: "Done", exact: true }).click();

    // Revoking removes the workspace from Shared with Me.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("button", { name: "Remove Ed Editor" }).click();
    await expect(people.locator(".people-list li")).toHaveCount(1);
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await expect(ed.locator(".connection-warning[role=alert]")).toContainText(
      "access to this workspace changed",
    );
    await ed.goto("/workspaces");
    await expect(ed.getByRole("region", { name: "Shared with Me" })).toContainText(
      "Nothing has been shared with you yet",
    );
    // Recipients can remove a shared workspace from their own list.
    await vera.goto("/workspaces");
    await veraShared.getByRole("button", { name: "Manage Shared Kubernetes lab" }).click();
    await vera.getByRole("button", { name: "Remove from my list" }).click();
    await expect(veraShared).toContainText("Nothing has been shared with you yet");
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
});
