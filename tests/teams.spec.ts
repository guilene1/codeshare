// Teams UI: navigation, team creation, invitations, roles and membership management,
// Team Workspaces and access indicators, with each role seeing only what it may do.
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
const nav = (page: Page, name: string | RegExp) => page.getByRole("navigation", { name: "Workspaces and teams" }).getByRole("button", { name });
const members = (page: Page) => page.getByRole("region", { name: "Members" });
const memberRow = (page: Page, name: string) => members(page).locator("li").filter({ hasText: name });
async function openTeam(page: Page, team: string) {
  await nav(page, /^My Teams/).click();
  await page.getByRole("article", { name: team }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: team, level: 2 })).toBeVisible();
}
async function confirmDialog(page: Page, button: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("teams: create, invite, accept, roles, rename, remove, transfer, leave and delete, each by the right role", async ({ browser }) => {
  test.setTimeout(240_000);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1280, height: 860 } })));
  const [owner, mia, sam] = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of [owner, mia, sam]) page.on("pageerror", (e) => errors.push(e.message));
  try {
    const miaEmail = uniqueEmail("mia"), samEmail = uniqueEmail("sam");
    await signUp(mia, "Mia Member", miaEmail);
    await signUp(sam, "Sam Second", samEmail);
    await signUp(owner, "Olivia Owner");

    // Navigation: My Workspaces stays the default page, with Shared with Me below it.
    await expect(nav(owner, "My Workspaces")).toHaveAttribute("aria-current", "page");
    await expect(owner.getByRole("region", { name: "Shared with Me" })).toBeVisible();
    for (const name of ["Shared with Me", /^My Teams/, "Team Workspaces"]) await expect(nav(owner, name)).toBeVisible();

    // Access indicators: a new workspace is Private; turning on link access shows Link.
    const privateUrl = await createWorkspace(owner, "Terraform Class");
    await createWorkspace(owner, "Python Basics", { studentLink: true });
    await owner.goto("/workspaces");
    const card = (name: string) => owner.getByRole("article", { name });
    await expect(card("Terraform Class").locator(".card-badge")).toHaveText(["Private"]);
    await expect(card("Python Basics").locator(".card-badge")).toHaveText(["Link"]);

    // Create a team: the name is required; the new team opens with its owner.
    await nav(owner, /^My Teams/).click();
    await expect(owner).toHaveURL(/\/workspaces\?view=teams$/);
    await expect(owner.getByText("No teams yet.")).toBeVisible();
    await owner.getByRole("button", { name: "Create Team" }).first().click();
    const create = owner.getByRole("dialog");
    await expect(create.getByRole("button", { name: "Create team" })).toBeDisabled();
    await create.getByLabel("Team name").fill("DevOps Team");
    await create.getByLabel(/Description/).fill("Platform engineers");
    await create.getByRole("button", { name: "Create team" }).click();
    await expect(owner.getByRole("heading", { name: "DevOps Team", level: 2 })).toBeVisible();
    await expect(owner).toHaveURL(/view=teams&team=[0-9a-f-]{36}$/);
    const teamId = owner.url().split("team=")[1];
    await expect(memberRow(owner, "Olivia Owner (you)")).toContainText("Owner");
    await expect(owner.getByText("You own this team")).toBeVisible();

    // Invitations: existing accounts only; the owner may invite Admins.
    const invite = owner.getByRole("region", { name: "Invite people" });
    await expect(invite.getByLabel("Team role").locator("option")).toHaveText(["Member", "Admin"]);
    await invite.getByLabel("Email address").fill("nobody-" + uniqueEmail());
    await invite.getByRole("button", { name: "Invite" }).click();
    await expect(invite.getByRole("alert")).toContainText("No Kodelumi account uses that email");
    await invite.getByLabel("Email address").fill(miaEmail);
    await invite.getByRole("button", { name: "Invite" }).click();
    await expect(invite.getByRole("list", { name: "Pending invitations" })).toContainText("Mia Member");
    await invite.getByLabel("Email address").fill(samEmail);
    await invite.getByRole("button", { name: "Invite" }).click();
    await expect(invite.getByRole("list", { name: "Pending invitations" })).toContainText("Sam Second");

    // The invitee sees the count, then the invitation, and accepts; Sam declines.
    await mia.reload();
    await expect(nav(mia, /^My Teams/).locator(".nav-count")).toHaveText("1");
    await nav(mia, /^My Teams/).click();
    const invitations = mia.getByRole("region", { name: "Invitations" });
    await expect(invitations).toContainText("DevOps Team");
    await expect(invitations).toContainText("Olivia Owner invited you as Member");
    await invitations.getByRole("button", { name: "Accept" }).click();
    await expect(mia.getByRole("region", { name: "Invitations" })).toHaveCount(0);
    await expect(mia.getByRole("article", { name: "DevOps Team" })).toContainText("2 members");
    await sam.reload();
    await nav(sam, /^My Teams/).click();
    await sam.getByRole("region", { name: "Invitations" }).getByRole("button", { name: "Decline" }).click();
    await expect(sam.getByText("No teams yet.")).toBeVisible();

    // A Member sees names and roles only: no emails, invitations, role controls or Delete.
    await openTeam(mia, "DevOps Team");
    await expect(mia.getByText("You're a Member")).toBeVisible();
    await expect(members(mia)).not.toContainText("@example.test");
    for (const hidden of [mia.getByRole("region", { name: "Invite people" }), mia.getByRole("button", { name: "Rename" }), mia.getByRole("button", { name: "Delete" }), members(mia).locator("select"), members(mia).getByRole("button")])
      await expect(hidden).toHaveCount(0);
    await expect(mia.getByRole("button", { name: "Leave" })).toBeVisible();

    // The owner makes Mia an Admin: she can rename, invite Members only, but not delete.
    await owner.reload();
    await memberRow(owner, "Mia Member").getByLabel("Role for Mia Member").selectOption("admin");
    await expect(memberRow(owner, "Mia Member").getByLabel("Role for Mia Member")).toHaveValue("admin");
    await mia.reload();
    await expect(mia.getByText("You're an Admin")).toBeVisible();
    await expect(mia.getByRole("region", { name: "Invite people" }).getByLabel("Team role").locator("option")).toHaveText(["Member"]);
    await expect(mia.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(memberRow(mia, "Olivia Owner").getByRole("button")).toHaveCount(0, { timeout: 2000 });
    await mia.getByRole("button", { name: "Rename" }).click();
    await mia.getByRole("dialog").getByLabel("Team name").fill("Platform Team");
    await mia.getByRole("dialog").getByRole("button", { name: "Save team" }).click();
    await expect(mia.getByRole("heading", { name: "Platform Team", level: 2 })).toBeVisible();
    // Mia invites Sam again as a Member; Sam accepts; Mia can remove him (with confirmation).
    await mia.getByRole("region", { name: "Invite people" }).getByLabel("Email address").fill(samEmail);
    await mia.getByRole("region", { name: "Invite people" }).getByRole("button", { name: "Invite" }).click();
    await sam.reload();
    await sam.getByRole("region", { name: "Invitations" }).getByRole("button", { name: "Accept" }).click();
    await expect(sam.getByRole("article", { name: "Platform Team" })).toBeVisible();
    await mia.reload();
    await memberRow(mia, "Sam Second").getByRole("button", { name: "Remove Sam Second" }).click();
    await expect(mia.getByRole("dialog")).toContainText("Sam Second loses access to the workspaces shared with");
    await mia.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(memberRow(mia, "Sam Second")).toBeVisible();
    await memberRow(mia, "Sam Second").getByRole("button", { name: "Remove Sam Second" }).click();
    await confirmDialog(mia, "Remove");
    await expect(memberRow(mia, "Sam Second")).toHaveCount(0);

    // Team Workspaces: a workspace shared with the team (Share popup controls are Phase 5).
    const workspaceId = privateUrl.split("/w/")[1];
    expect((await api(owner, `/rooms/${workspaceId}/team-shares`, "POST", { teamId, role: "editor" })).status).toBe(201);
    await nav(mia, "Team Workspaces").click();
    const shared = mia.getByRole("region", { name: "Platform Team" }).getByRole("article", { name: "Terraform Class" });
    await expect(shared).toContainText("Editor");
    await expect(shared).toContainText("Shared by Olivia Owner");
    await expect(shared.locator(".card-badge")).toHaveText(["Team"]);
    await owner.goto("/workspaces");
    await expect(card("Terraform Class").locator(".card-badge")).toHaveText(["Private", "Team"]);
    // Back returns to the previous view; Open opens the workspace with the team's role.
    await mia.goBack();
    await expect(nav(mia, /^My Teams/)).toHaveAttribute("aria-current", "page");
    await mia.goForward();
    await shared.getByRole("button", { name: "Open" }).click();
    await expect(mia.getByLabel("Workspace access")).toContainText("Editing");
    await mia.goto("/workspaces?view=team-workspaces");
    await expect(mia.getByRole("article", { name: "Terraform Class" })).toBeVisible();

    // Transfer ownership to Mia (confirmed); Olivia becomes an Admin and can then leave.
    await openTeam(owner, "Platform Team");
    await owner.getByLabel("New owner").selectOption({ label: "Mia Member" });
    await owner.getByRole("button", { name: "Transfer" }).click();
    await expect(owner.getByRole("dialog")).toContainText("Mia Member becomes the owner");
    await confirmDialog(owner, "Transfer ownership");
    await expect(owner.getByText("You're an Admin")).toBeVisible();
    await expect(owner.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await owner.getByRole("button", { name: "Leave" }).click();
    await confirmDialog(owner, "Leave team");
    await expect(owner).toHaveURL(/view=teams$/);
    await expect(owner.getByRole("article", { name: "Platform Team" })).toHaveCount(0);

    // Deleting needs the team name typed; then the team is gone for everyone.
    await mia.goto("/workspaces?view=teams&team=" + teamId);
    await mia.getByRole("button", { name: "Delete" }).click();
    const del = mia.getByRole("dialog");
    await expect(del.getByRole("button", { name: "Delete team" })).toBeDisabled();
    await del.getByLabel("Type the team name to confirm").fill("Platform Team");
    await confirmDialog(mia, "Delete team");
    await expect(mia.getByText("No teams yet.")).toBeVisible();
    await sam.goto("/workspaces?view=teams&team=" + teamId);
    await expect(sam.getByRole("alert")).toContainText("Team not found");
    expect(errors).toEqual([]);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

test("an outsider can't see a team, even with its link", async ({ browser }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  const [owner, outsider] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await signUp(owner, "Team Owner");
    await signUp(outsider, "Otto Outsider");
    const team = await api(owner, "/teams", "POST", { name: "Secret Team", description: "Private plans" });
    expect(team.status).toBe(201);
    await outsider.goto("/workspaces?view=teams&team=" + team.body.id);
    await expect(outsider.getByRole("alert")).toContainText("Team not found");
    expect(await outsider.content()).not.toContain("Secret Team");
    await outsider.goto("/workspaces?view=team-workspaces");
    await expect(outsider.getByText("You're not in a team yet.", { exact: false })).toBeVisible();
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
});

test("teams UI fits phones and tablets", async ({ browser }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const memberContext = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  try {
    const owner = await ownerContext.newPage(), member = await memberContext.newPage();
    const memberEmail = uniqueEmail("tablet");
    await signUp(member, "Tara Tablet", memberEmail);
    await signUp(owner, "Phoebe Phone");
    const team = await api(owner, "/teams", "POST", { name: "Mobile Team", description: "Works on the go" });
    await api(owner, `/teams/${team.body.id}/invitations`, "POST", { email: memberEmail });
    const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    // Phone: the navigation scrolls on its own; the page never scrolls sideways.
    await owner.goto("/workspaces");
    expect(await noOverflow(owner)).toBe(true);
    await nav(owner, /^My Teams/).click();
    await owner.getByRole("article", { name: "Mobile Team" }).getByRole("button", { name: "Open" }).click();
    await expect(members(owner)).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
    const inviteButton = owner.getByRole("region", { name: "Invite people" }).getByRole("button", { name: "Invite" });
    const box = (await inviteButton.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await nav(owner, "Team Workspaces").scrollIntoViewIfNeeded();
    await nav(owner, "Team Workspaces").click();
    await expect(owner.getByRole("heading", { name: "Team Workspaces", level: 2 })).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
    // Tablet: the invitation and its buttons fit; accepting works.
    await member.goto("/workspaces?view=teams");
    const invitation = member.getByRole("region", { name: "Invitations" });
    for (const name of ["Accept", "Decline"]) {
      const b = (await invitation.getByRole("button", { name }).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(768);
    }
    expect(await noOverflow(member)).toBe(true);
    await invitation.getByRole("button", { name: "Accept" }).click();
    await expect(member.getByRole("article", { name: "Mobile Team" })).toBeVisible();
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});
