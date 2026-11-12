// Folder sharing, Phase 1: the Explorer tree and workspace name are no longer inside the live
// lesson document. They load over REST and refresh on data-free WebSocket notices, so every
// open browser stays in sync while the frames a lesson sends never contain the workspace tree.
import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, openFromExplorer, signUp } from "./helpers";

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

test("Explorers stay in sync live across browsers, and the live lesson never carries the workspace tree", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  const [owner, guest, student] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, guest, student]) page.on("pageerror", (e) => errors.push(e.message));
  // Everything the student's browser receives over the live connection.
  const frames: string[] = [];
  student.on("websocket", (ws) =>
    ws.on("framereceived", (frame) => frames.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("latin1"))),
  );
  try {
    await signUp(owner, "Tree Owner");
    const url = await createWorkspace(owner, "Live tree course", { studentLink: true });
    const week1 = (await api(owner, "/folders", "POST", { name: "Week 01 - Linux" })).body.id as string;
    const week2 = (await api(owner, "/folders", "POST", { name: "Week 02 - Docker" })).body.id as string;
    expect((await api(owner, `/documents?folder=${week1}`, "POST", { filename: "linux.md", language: "markdown", content: "# Linux\n" })).status).toBe(201);
    expect((await api(owner, `/documents?folder=${week2}`, "POST", { filename: "docker.md", language: "markdown", content: "# Docker\n" })).status).toBe(201);
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("dialog").getByRole("button", { name: "Create Edit Link", exact: true }).click();
    const editLink = await owner.getByRole("dialog").getByLabel("Edit link", { exact: true }).inputValue();
    await owner.getByRole("button", { name: "Close dialog" }).click();

    // The student reads Week 1; the guest edits in Week 2; the owner stays at the root.
    await student.goto(url + "?folder=" + week1);
    await expect(student.getByLabel("Connection status")).toContainText("Live");
    await openFromExplorer(student, "linux.md");
    await guest.goto(editLink);
    await guest.getByLabel("Your name").fill("Guest");
    await guest.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await guest.getByRole("button", { name: "Open folder Week 02 - Docker", exact: true }).click();
    await openFromExplorer(guest, "docker.md");
    const folderButton = (page: Page, name: string) => page.getByRole("button", { name: "Open folder " + name, exact: true });
    for (const page of [student, guest]) await expect(folderButton(page, "Week 02 - Docker")).toBeVisible();

    // Folder created, renamed and deleted, a file added, and the workspace renamed: every
    // other browser follows without reloading.
    expect((await api(owner, "/folders", "POST", { name: "Week 03 - Kubernetes" })).status).toBe(201);
    for (const page of [student, guest]) await expect(folderButton(page, "Week 03 - Kubernetes")).toBeVisible();
    expect((await api(owner, `/folders/${week2}`, "PATCH", { name: "Week 02 - Containers" })).status).toBe(200);
    for (const page of [student, guest]) {
      await expect(folderButton(page, "Week 02 - Containers")).toBeVisible();
      await expect(folderButton(page, "Week 02 - Docker")).toHaveCount(0);
    }
    expect((await api(owner, `/documents?folder=${week1}`, "POST", { filename: "processes.md", language: "markdown", content: "# ps\n" })).status).toBe(201);
    await expect(student.locator(".sidebar").getByRole("button", { name: "processes.md", exact: true })).toBeVisible();
    const week3 = (await api(owner, "/tree")).body.folders.find((f: { name: string }) => f.name === "Week 03 - Kubernetes").id;
    expect((await api(owner, `/folders/${week3}`, "DELETE")).status).toBe(200);
    for (const page of [student, guest]) await expect(folderButton(page, "Week 03 - Kubernetes")).toHaveCount(0);
    expect((await api(owner, "", "PATCH", { name: "Renamed live course" })).status).toBe(200);
    await expect(student.locator(".course-root")).toContainText("Renamed live course");

    // Live editing keeps working throughout: the guest's typing reaches the owner's browser.
    // (Documents open in Preview; the guest switches to Edit to type.)
    await guest.getByRole("button", { name: "Edit", exact: true }).click();
    await guest.locator(".monaco-editor textarea").focus();
    await guest.keyboard.type("Compose files ", { delay: 20 });
    await owner.getByRole("button", { name: "Open folder Week 02 - Containers", exact: true }).click();
    await openFromExplorer(owner, "docker.md");
    await expect(owner.locator(".markdown-preview")).toContainText("Compose files");
    for (const page of [owner, guest]) await expect(page.getByLabel("Connection status")).toContainText("Connected");
    await expect(student.getByLabel("Connection status")).toContainText("Live");

    // The student's live connection never carried any folder name or the workspace name.
    const received = frames.join("\n");
    expect(frames.length).toBeGreaterThan(0);
    for (const secret of ["Week 02 - Docker", "Week 02 - Containers", "Week 03 - Kubernetes", "Live tree course", "Renamed live course", "docker.md"])
      expect(received, `the student's live frames contain "${secret}"`).not.toContain(secret);
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});
