// General access in a real browser: new workspaces are Restricted; the student link works
// once "Anyone with the link can view" is on, and stops at once when it's turned off; shares
// and Edit Links keep working in Restricted workspaces (including document images).
import { test, expect, type Page } from "@playwright/test";
import { allowStudentLink, createWorkspace, openFromExplorer, signUp, uniqueEmail } from "./helpers";

async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const id = location.pathname.split("/")[2];
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch(`/api/rooms/${id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}

test("Restricted by default: students need link access; outsiders see nothing; shares and Edit Links still work", async ({ browser }) => {
  test.setTimeout(150_000);
  const contexts = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext()));
  const [owner, student, outsider, viewer, guest] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, student, outsider, viewer, guest]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    const viewerEmail = uniqueEmail("viewer");
    await signUp(viewer, "Vera Viewer", viewerEmail);
    await signUp(outsider, "Otto Outsider");
    await signUp(owner, "Private Owner");
    const url = await createWorkspace(owner, "Private course");
    const id = url.split("/w/")[1];
    // The owner sees Restricted in Share, with the explanation.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const access = owner.getByRole("dialog").getByLabel("General access");
    await expect(access).toHaveValue("private");
    await expect(owner.getByRole("dialog")).toContainText("Restricted: only you and people you share with can open this link.");
    await owner.getByRole("button", { name: "Close dialog" }).click();
    // A lesson with a 40x30 PNG image, drawn in the page and uploaded with its bytes.
    const upload = await owner.evaluate(async (id) => {
      const canvas = Object.assign(document.createElement("canvas"), { width: 40, height: 30 });
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#6366f1";
      ctx.fillRect(0, 0, 40, 30);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch(`/api/rooms/${id}/images`, {
        method: "POST",
        headers: { "content-type": "image/png", "x-csrf-token": csrfToken },
        body: blob,
      });
      return { status: r.status, body: await r.json() };
    }, id);
    expect(upload.status).toBe(201);
    const content = `# Private lesson\n\nSecret notes.\n\n![diagram](/api/rooms/${id}/images/${upload.body.id})\n`;
    expect((await api(owner, "/documents", "POST", { filename: "lesson.md", language: "markdown", content })).status).toBe(201);

    // An anonymous student and a signed-in outsider get "not found", and nothing leaks.
    for (const page of [student, outsider]) {
      await page.goto(url);
      await expect(page.getByText("Workspace not found", { exact: false })).toBeVisible();
      await expect(page.getByLabel("Workspace access")).toHaveCount(0);
      expect(await page.content()).not.toContain("Private course");
      expect(await page.content()).not.toContain("Secret notes");
    }

    // A viewer share opens it read-only, with the restricted note and no access control.
    expect((await api(owner, "/shares", "POST", { email: viewerEmail, role: "viewer" })).status).toBe(201);
    await viewer.goto(url);
    await expect(viewer.getByLabel("Workspace access")).toContainText("View Only");
    await openFromExplorer(viewer, "lesson.md");
    await expect(viewer.locator(".markdown-preview")).toContainText("Secret notes");

    // An Edit Link guest edits in the Restricted workspace and sees the document image.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Create Edit Link", exact: true }).click();
    const editLink = await owner.getByRole("dialog").getByLabel("Edit link", { exact: true }).inputValue();
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await guest.goto(editLink);
    await guest.getByLabel("Your name").fill("Guest");
    await guest.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await expect(guest.getByLabel("Workspace access")).toContainText("Editing");
    await openFromExplorer(guest, "lesson.md");
    const image = guest.locator(".markdown-preview .doc-image img");
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(40);
    await guest.getByRole("button", { name: "Share", exact: true }).click();
    await expect(guest.getByRole("dialog").getByLabel("General access")).toHaveCount(0);
    await expect(guest.getByRole("dialog")).toContainText("Restricted: only people with access can open this link.");
    await guest.getByRole("button", { name: "Close dialog" }).click();

    // The owner allows anyone with the link: the student joins without signing in.
    await allowStudentLink(owner);
    await student.goto(url);
    await expect(student.getByLabel("Workspace access")).toContainText("View Only");
    await openFromExplorer(student, "lesson.md");
    await expect(student.locator(".markdown-preview")).toContainText("Secret notes");
    await expect.poll(() => student.locator(".markdown-preview .doc-image img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(40);

    // Back to Restricted: the open student page is told at once; the viewer share, the
    // owner and the Edit Link guest keep working.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("dialog").getByLabel("General access").selectOption("private");
    await expect(owner.getByRole("dialog").getByLabel("General access")).toHaveValue("private");
    await owner.getByRole("button", { name: "Close dialog" }).click();
    await expect(student.getByText("Access to this workspace changed. Refresh to continue.")).toBeVisible();
    await student.reload();
    await expect(student.getByText("Workspace not found", { exact: false })).toBeVisible();
    for (const page of [owner, viewer, guest])
      await expect(page.getByLabel("Connection status")).toContainText(page === viewer ? "Live" : "Connected");
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});
