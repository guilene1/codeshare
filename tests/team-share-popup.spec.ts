// Share popup, Teams with access: the owner shares a private workspace with a team as Viewer
// or Editor, changes or removes it during live collaboration; access follows membership;
// team admins and team-derived editors never manage sharing; it fits every screen size.
import { test, expect, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { csrfToken } = await (await fetch("/api/auth/me")).json();
      const r = await fetch("/api" + path, {
        method,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}
async function joinTeam(owner: Page, member: Page, teamId: string, email: string, role = "member") {
  expect((await api(owner, `/teams/${teamId}/invitations`, "POST", { email, role })).status).toBe(201);
  const invitation = (await api(member, "/me/invitations")).body.invitations.find((i: { teamId: string }) => i.teamId === teamId);
  expect((await api(member, `/me/invitations/${invitation.id}/accept`, "POST", {})).status).toBe(200);
}
const teams = (page: Page) => page.getByRole("dialog").getByRole("region", { name: "Teams with access" });
const openShare = (page: Page) => page.getByRole("button", { name: "Share", exact: true }).click();
const closeShare = async (page: Page) => {
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
const access = (page: Page) => page.getByLabel("Workspace access");

test("team sharing in the Share popup: Viewer, Editor, live changes, combined grants, membership and removal", async ({ browser }) => {
  test.setTimeout(240_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 800 } })));
  const [owner, mia, adam, sam] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, mia, adam, sam]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    const miaEmail = uniqueEmail("mia"), adamEmail = uniqueEmail("adam"), samEmail = uniqueEmail("sam");
    await signUp(mia, "Mia Member", miaEmail);
    await signUp(adam, "Adam TeamAdmin", adamEmail);
    await signUp(sam, "Sam Later", samEmail);
    await signUp(owner, "Olivia Owner");
    const url = await createWorkspace(owner, "Terraform Class");
    const id = url.split("/w/")[1];
    const team = (await api(owner, "/teams", "POST", { name: "DevOps Team" })).body;
    await joinTeam(owner, mia, team.id, miaEmail);
    await joinTeam(owner, adam, team.id, adamEmail, "admin");

    // Membership alone opens nothing.
    for (const page of [mia, adam]) {
      await page.goto(url);
      await expect(page.getByText("Workspace not found", { exact: false })).toBeVisible();
    }

    // The owner shares the private workspace with the team as Viewer.
    await openShare(owner);
    await expect(teams(owner)).toContainText("Not shared with any teams yet.");
    await expect(teams(owner).getByLabel("Team", { exact: true }).locator("option")).toHaveText(["Choose a team…", "DevOps Team"]);
    await expect(teams(owner).getByRole("button", { name: "Share" })).toBeDisabled();
    await teams(owner).getByLabel("Team", { exact: true }).selectOption({ label: "DevOps Team" });
    await teams(owner).getByRole("button", { name: "Share" }).click();
    const row = teams(owner).getByRole("list", { name: "Teams" }).locator("li").filter({ hasText: "DevOps Team" });
    await expect(row).toContainText("3 members");
    await expect(row.getByLabel("Permission for DevOps Team")).toHaveValue("viewer");
    await expect(teams(owner).getByLabel("Team", { exact: true })).toBeDisabled(); // no other team to add
    await expect(owner.getByRole("dialog").getByLabel("General access")).toHaveValue("private"); // still Restricted
    await closeShare(owner);

    // Team Viewers open it read-only; a team admin gets no sharing controls.
    for (const page of [mia, adam]) {
      await page.reload();
      await expect(access(page)).toContainText("View Only");
      await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    }
    expect((await api(adam, `/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "editor" })).status).toBe(403);

    // Upgrading to Editor while Mia has the workspace open: she becomes an editor in place,
    // and her edits reach the owner live.
    await openShare(owner);
    await teams(owner).getByLabel("Permission for DevOps Team").selectOption("editor");
    await expect(teams(owner).getByLabel("Permission for DevOps Team")).toHaveValue("editor");
    await closeShare(owner);
    await expect(access(mia)).toContainText("Editing");
    await expect(mia.locator(".status-bar")).toContainText("Connected");
    await mia.locator(".sidebar").getByRole("button", { name: "main.tf", exact: true }).click();
    await mia.locator(".monaco-editor .view-lines").first().click();
    await mia.keyboard.press("Control+Home");
    await mia.keyboard.type("# edited by the team\n");
    await expect(owner.locator(".monaco-editor .view-lines").first()).toContainText("# edited by the team");
    // A team-derived Editor edits but doesn't manage sharing.
    await openShare(mia);
    await expect(mia.getByRole("dialog").getByRole("region", { name: "Teams with access" })).toHaveCount(0);
    await expect(mia.getByRole("dialog").getByRole("region", { name: "People with access" })).toHaveCount(0);
    await expect(mia.getByRole("dialog").getByLabel("General access")).toHaveCount(0);
    await closeShare(mia);

    // A direct Editor share (Adam) sees the teams read-only.
    await openShare(owner);
    const people = owner.getByRole("dialog").getByRole("region", { name: "People with access" });
    await people.getByLabel("Email address").fill(adamEmail);
    await people.getByLabel("Permission", { exact: true }).selectOption("editor");
    await people.getByRole("button", { name: "Share", exact: true }).click();
    await expect(people.getByLabel("Permission for Adam TeamAdmin")).toHaveValue("editor");
    // Mia gets a direct Viewer share too, so removing the team leaves her that.
    await people.getByLabel("Email address").fill(miaEmail);
    await people.getByLabel("Permission", { exact: true }).selectOption("viewer");
    await people.getByRole("button", { name: "Share", exact: true }).click();
    await expect(people.getByLabel("Permission for Mia Member")).toHaveValue("viewer");
    await closeShare(owner);
    await adam.reload();
    await expect(access(adam)).toContainText("Editing");
    await openShare(adam);
    await expect(teams(adam)).toContainText("Only the workspace owner can share it with teams.");
    await expect(teams(adam).getByRole("list", { name: "Teams" })).toContainText("DevOps Team");
    await expect(teams(adam).locator("select, button")).toHaveCount(0);
    await closeShare(adam);
    await expect(access(mia)).toContainText("Editing"); // team Editor beats her direct Viewer share

    // Removing team access asks first; Cancel keeps it.
    await openShare(owner);
    await teams(owner).getByRole("button", { name: "Remove DevOps Team" }).click();
    const confirm = teams(owner).getByRole("group", { name: "Confirm team access removal" });
    await expect(confirm).toContainText("Its members lose access right away, unless they have another way in");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(teams(owner).getByRole("list", { name: "Teams" })).toContainText("DevOps Team");
    await teams(owner).getByRole("button", { name: "Remove DevOps Team" }).click();
    await teams(owner).getByRole("button", { name: "Remove team access" }).click();
    await expect(teams(owner)).toContainText("Not shared with any teams yet.");
    await closeShare(owner);
    // At once: Mia keeps her own Viewer share (read-only now); Adam keeps his Editor share.
    await expect(access(mia)).toContainText("View Only");
    await adam.reload();
    await expect(access(adam)).toContainText("Editing");

    // Shared again as Viewer: a new member gets access when they join, and loses it when removed.
    await openShare(owner);
    await teams(owner).getByLabel("Team", { exact: true }).selectOption({ label: "DevOps Team" });
    await teams(owner).getByRole("button", { name: "Share" }).click();
    await expect(teams(owner).getByRole("list", { name: "Teams" })).toContainText("DevOps Team");
    await closeShare(owner);
    await sam.goto(url);
    await expect(sam.getByText("Workspace not found", { exact: false })).toBeVisible();
    await joinTeam(owner, sam, team.id, samEmail);
    await sam.reload();
    await expect(access(sam)).toContainText("View Only");
    expect((await api(owner, `/teams/${team.id}/members/${(await api(sam, "/auth/me")).body.user.id}`, "DELETE")).status).toBe(200);
    await expect(sam.getByText("Your access to this workspace changed. Refresh to continue.")).toBeVisible();
    await sam.reload();
    await expect(sam.getByText("Workspace not found", { exact: false })).toBeVisible();
    // The owner was never interrupted.
    await expect(owner.locator(".status-bar")).toContainText("Connected");
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

// Regression: an open file used to stay bound to the old shared document after a reconnect
// with new rights, so a Viewer upgraded to Editor could type but nothing was saved or seen.
test("an open file keeps syncing after a direct Viewer share is upgraded to Editor", async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 800 } })));
  const [owner, viewer] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    const viewerEmail = uniqueEmail("upgrade");
    await signUp(viewer, "Vic Viewer", viewerEmail);
    await signUp(owner, "Upgrade Owner");
    const url = await createWorkspace(owner, "Upgrade course");
    const id = url.split("/w/")[1];
    expect((await api(owner, `/rooms/${id}/shares`, "POST", { email: viewerEmail, role: "viewer" })).status).toBe(201);
    await viewer.goto(url);
    await expect(access(viewer)).toContainText("View Only");
    await viewer.locator(".sidebar").getByRole("button", { name: "main.tf", exact: true }).click();
    await expect(viewer.locator(".monaco-editor .view-lines").first()).toContainText("terraform");
    const viewerId = (await api(viewer, "/auth/me")).body.user.id;
    expect((await api(owner, `/rooms/${id}/shares/${viewerId}`, "PATCH", { role: "editor" })).status).toBe(200);
    await expect(access(viewer)).toContainText("Editing");
    await expect(viewer.locator(".status-bar")).toContainText("Connected");
    await viewer.locator(".monaco-editor .view-lines").first().click();
    await viewer.keyboard.press("Control+Home");
    await viewer.keyboard.type("# after the upgrade\n");
    await expect(owner.locator(".monaco-editor .view-lines").first()).toContainText("# after the upgrade");
    // Saved on the server, not just shown.
    const mainTf = (await api(owner, `/rooms/${id}/tree`)).body.documents.find((d: { filename: string }) => d.filename === "main.tf");
    await expect.poll(async () => (await api(owner, `/rooms/${id}/documents/${mainTf.id}/content`)).body.content).toContain("# after the upgrade");
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

test("owners without teams are pointed to My Teams; the Teams section fits laptop, tablet and phone", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const owner = await context.newPage();
    await signUp(owner, "Sizing Owner");
    await createWorkspace(owner, "Responsive course");
    await openShare(owner);
    await expect(teams(owner)).toContainText("You're not in a team yet.");
    await expect(teams(owner).getByRole("link", { name: "Create one in My Teams" })).toHaveAttribute("href", "/workspaces?view=teams");
    await closeShare(owner);
    for (const name of ["Infrastructure and Platform Reliability Engineering Guild of the Northern Region", "Python Mentors", "Mobile Crew"])
      expect((await api(owner, "/teams", "POST", { name })).status).toBe(201);
    for (const [label, viewport] of [["laptop", { width: 1280, height: 720 }], ["tablet", { width: 768, height: 1024 }], ["phone", { width: 390, height: 844 }]] as const) {
      await owner.setViewportSize(viewport);
      await owner.reload();
      await expect(owner.locator(".status-bar")).toContainText("Connected");
      await openShare(owner);
      const section = teams(owner);
      await section.scrollIntoViewIfNeeded();
      const picker = section.getByLabel("Team", { exact: true });
      await picker.selectOption({ index: 1 });
      const share = section.getByRole("button", { name: "Share" });
      await expect(share).toBeEnabled();
      // Every control sits inside the dialog, the dialog never scrolls sideways, and the
      // Share button is on screen and clickable.
      const fit = await owner.getByRole("dialog").evaluate((d) => {
        const box = d.getBoundingClientRect();
        return {
          sideways: d.scrollWidth > d.clientWidth + 1,
          inside: [...d.querySelectorAll(".team-access select, .team-access button")].every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1;
          }),
        };
      });
      expect(fit, label).toEqual({ sideways: false, inside: true });
      await share.scrollIntoViewIfNeeded();
      await expect(share).toBeInViewport();
      await share.click();
      await expect(section.getByRole("list", { name: "Teams" }).locator("li")).toHaveCount(label === "laptop" ? 1 : label === "tablet" ? 2 : 3);
      expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label).toBe(true);
      await closeShare(owner);
    }
  } finally {
    await context.close();
  }
});
