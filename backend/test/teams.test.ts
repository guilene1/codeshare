import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

type Detail = {
  id: string;
  name: string;
  description: string;
  role: string;
  memberCount: number;
  members: { userId: string; displayName: string; email?: string; role: string; you: boolean }[];
  invitations?: { id: string; userId: string; email: string; role: string; invitedBy: string }[];
};

test("teams: roles, invitations, membership changes and ownership are enforced on every endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-teams-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json, text };
  };
  try {
    const owner = await signUp(base, origin, "Olivia Owner"),
      admin = await signUp(base, origin, "Adam Admin"),
      member = await signUp(base, origin, "Mia Member"),
      second = await signUp(base, origin, "Sam Second"),
      outsider = await signUp(base, origin, "Otto Outsider");
    const as = (who: typeof owner) => who.headers;

    // Signed-out callers are refused everywhere.
    for (const [path, method] of [["/teams", "GET"], ["/teams", "POST"], ["/me/invitations", "GET"]] as const)
      assert.equal((await call(path, method, method === "POST" ? { name: "x" } : undefined)).status, 401, `${method} ${path}`);

    // Create: validated, the creator becomes the only owner.
    for (const body of [{}, { name: "   " }, { name: "x".repeat(81) }, { name: "Ok", description: "x".repeat(401) }])
      assert.equal((await call("/teams", "POST", body, as(owner))).status, 400, JSON.stringify(body).slice(0, 40));
    const created = await call("/teams", "POST", { name: "  DevOps Team ", description: "Platform engineers" }, as(owner));
    assert.equal(created.status, 201);
    const team = created.body as Detail;
    assert.deepEqual([team.name, team.description, team.role, team.memberCount], ["DevOps Team", "Platform engineers", "owner", 1]);
    const teamPath = "/teams/" + team.id;
    assert.deepEqual((await call("/teams", "GET", undefined, as(owner))).body.teams.map((t: Detail) => [t.name, t.role]), [["DevOps Team", "owner"]]);

    // Non-members can't see, change or even confirm the team exists.
    const unknown = await call("/teams/00000000-0000-4000-8000-000000000000", "GET", undefined, as(outsider));
    assert.equal(unknown.status, 404);
    for (const [path, method, body] of [
      ["", "GET", undefined],
      ["", "PATCH", { name: "Taken" }],
      ["", "DELETE", undefined],
      ["/invitations", "POST", { email: outsider.email }],
      ["/members/" + owner.user.id, "DELETE", undefined],
      ["/members/" + owner.user.id, "PATCH", { role: "member" }],
      ["/leave", "POST", undefined],
      ["/transfer", "POST", { userId: outsider.user.id }],
    ] as const) {
      const r = await call(teamPath + path, method, body, as(outsider));
      assert.equal(r.status, 404, `outsider ${method} ${path || "/"}`);
      assert.equal(r.text, unknown.text, "same response as an unknown team");
      assert.ok(!r.text.includes("DevOps"));
    }
    assert.deepEqual((await call("/teams", "GET", undefined, as(outsider))).body.teams, []);

    // Invitations go to existing accounts only; the owner can invite admins.
    assert.equal((await call(teamPath + "/invitations", "POST", { email: "nobody@example.test" }, as(owner))).status, 404);
    assert.equal((await call(teamPath + "/invitations", "POST", { email: "not-an-email" }, as(owner))).status, 400);
    assert.equal((await call(teamPath + "/invitations", "POST", { email: owner.email }, as(owner))).status, 400, "already in the team");
    assert.equal((await call(teamPath + "/invitations", "POST", { email: admin.email, role: "owner" }, as(owner))).status, 400);
    const toAdmin = await call(teamPath + "/invitations", "POST", { email: admin.email, role: "member" }, as(owner));
    assert.equal(toAdmin.status, 201);
    // Inviting again updates the pending invitation instead of duplicating it.
    const again = await call(teamPath + "/invitations", "POST", { email: admin.email.toUpperCase(), role: "admin" }, as(owner));
    assert.equal(again.status, 200);
    assert.deepEqual((again.body as Detail).invitations!.map((i) => [i.email, i.role, i.invitedBy]), [[admin.email, "admin", "Olivia Owner"]]);
    assert.deepEqual((await call(teamPath, "GET", undefined, as(owner))).body.members.length, 1, "an invitation is not membership");

    // Only the invitee sees and answers their invitation.
    const pending = (await call("/me/invitations", "GET", undefined, as(admin))).body.invitations;
    assert.deepEqual(pending.map((i: any) => [i.teamName, i.role, i.invitedBy]), [["DevOps Team", "admin", "Olivia Owner"]]);
    assert.deepEqual((await call("/me/invitations", "GET", undefined, as(outsider))).body.invitations, []);
    for (const action of ["accept", "decline"])
      assert.equal((await call(`/me/invitations/${pending[0].id}/${action}`, "POST", {}, as(outsider))).status, 404, `outsider can't ${action}`);
    const accepted = await call(`/me/invitations/${pending[0].id}/accept`, "POST", {}, as(admin));
    assert.deepEqual([accepted.status, (accepted.body as Detail).role], [200, "admin"]);
    assert.equal((await call(`/me/invitations/${pending[0].id}/accept`, "POST", {}, as(admin))).status, 404, "used once");

    // Admins invite Members, never Admins; Members can't invite.
    assert.equal((await call(teamPath + "/invitations", "POST", { email: member.email, role: "admin" }, as(admin))).status, 403);
    assert.equal((await call(teamPath + "/invitations", "POST", { email: member.email }, as(admin))).status, 201);
    const memberInvite = (await call("/me/invitations", "GET", undefined, as(member))).body.invitations[0];
    assert.equal((await call(`/me/invitations/${memberInvite.id}/accept`, "POST", {}, as(member))).status, 200);
    assert.equal((await call(teamPath + "/invitations", "POST", { email: second.email }, as(member))).status, 403);
    // A declined invitation simply disappears (and can be sent again).
    assert.equal((await call(teamPath + "/invitations", "POST", { email: second.email }, as(admin))).status, 201);
    const secondInvite = (await call("/me/invitations", "GET", undefined, as(second))).body.invitations[0];
    assert.equal((await call(`/me/invitations/${secondInvite.id}/decline`, "POST", {}, as(second))).status, 200);
    assert.deepEqual((await call("/me/invitations", "GET", undefined, as(second))).body.invitations, []);
    assert.equal((await call(teamPath, "GET", undefined, as(second))).status, 404, "declining never joins");
    // Cancelling: the owner cancels anything, admins only Member invitations.
    await call(teamPath + "/invitations", "POST", { email: second.email, role: "admin" }, as(owner));
    const adminInvite = (await call(teamPath, "GET", undefined, as(owner))).body.invitations[0];
    assert.equal((await call(teamPath + "/invitations/" + adminInvite.id, "DELETE", undefined, as(admin))).status, 403);
    assert.equal((await call(teamPath + "/invitations/" + adminInvite.id, "DELETE", undefined, as(member))).status, 403);
    assert.equal((await call(teamPath + "/invitations/" + adminInvite.id, "DELETE", undefined, as(owner))).status, 200);
    assert.deepEqual((await call("/me/invitations", "GET", undefined, as(second))).body.invitations, []);

    // What each role sees: Members see names and roles, but no emails or invitations.
    const seenByMember = (await call(teamPath, "GET", undefined, as(member))).body as Detail;
    assert.deepEqual(seenByMember.members.map((m) => [m.displayName, m.role]), [["Olivia Owner", "owner"], ["Adam Admin", "admin"], ["Mia Member", "member"]]);
    assert.ok(seenByMember.members.every((m) => m.email === undefined) && seenByMember.invitations === undefined);
    assert.ok(!JSON.stringify(seenByMember).includes(owner.email));
    assert.ok(((await call(teamPath, "GET", undefined, as(admin))).body as Detail).members.every((m) => m.email));
    assert.deepEqual(seenByMember.members.filter((m) => m.you).map((m) => m.displayName), ["Mia Member"]);

    // Renaming: owner and admins; never Members.
    assert.equal((await call(teamPath, "PATCH", { name: "Renamed" }, as(member))).status, 403);
    assert.equal((await call(teamPath, "PATCH", { name: "" }, as(admin))).status, 400);
    const renamed = await call(teamPath, "PATCH", { name: "Platform Team" }, as(admin));
    assert.deepEqual([renamed.status, renamed.body.name, renamed.body.description], [200, "Platform Team", "Platform engineers"]);

    // Roles: only the owner changes them, and never into or out of "owner".
    assert.equal((await call(teamPath + "/members/" + member.user.id, "PATCH", { role: "admin" }, as(admin))).status, 403);
    assert.equal((await call(teamPath + "/members/" + member.user.id, "PATCH", { role: "owner" }, as(owner))).status, 400);
    assert.equal((await call(teamPath + "/members/" + owner.user.id, "PATCH", { role: "member" }, as(owner))).status, 400);
    assert.equal((await call(teamPath + "/members/" + outsider.user.id, "PATCH", { role: "admin" }, as(owner))).status, 404);
    assert.equal((await call(teamPath + "/members/" + member.user.id, "PATCH", { role: "admin" }, as(owner))).status, 200);
    assert.equal((await call(teamPath + "/members/" + member.user.id, "PATCH", { role: "member" }, as(owner))).status, 200);

    // Removing: admins remove Members only; nobody removes the owner; self-removal is Leave.
    assert.equal((await call(teamPath + "/members/" + owner.user.id, "DELETE", undefined, as(admin))).status, 403);
    assert.equal((await call(teamPath + "/members/" + admin.user.id, "DELETE", undefined, as(member))).status, 403);
    assert.equal((await call(teamPath + "/members/" + admin.user.id, "DELETE", undefined, as(admin))).status, 400);
    assert.equal((await call(teamPath + "/members/" + member.user.id, "DELETE", undefined, as(admin))).status, 200);
    // A removed member loses every right at once.
    assert.equal((await call(teamPath, "GET", undefined, as(member))).status, 404);
    assert.equal((await call(teamPath + "/invitations", "POST", { email: second.email }, as(member))).status, 404);
    assert.deepEqual((await call("/teams", "GET", undefined, as(member))).body.teams, []);

    // Leaving: anyone but the owner, who must transfer first.
    const ownerLeave = await call(teamPath + "/leave", "POST", {}, as(owner));
    assert.equal(ownerLeave.status, 409);
    assert.match(ownerLeave.body.error, /Transfer ownership/);
    await call(teamPath + "/invitations", "POST", { email: member.email }, as(owner));
    await call(`/me/invitations/${(await call("/me/invitations", "GET", undefined, as(member))).body.invitations[0].id}/accept`, "POST", {}, as(member));
    assert.equal((await call(teamPath + "/leave", "POST", {}, as(member))).status, 200);
    assert.equal((await call(teamPath, "GET", undefined, as(member))).status, 404);

    // Transfer: owner only, to a current member; the old owner stays on as an admin.
    assert.equal((await call(teamPath + "/transfer", "POST", { userId: owner.user.id }, as(admin))).status, 403);
    assert.equal((await call(teamPath + "/transfer", "POST", { userId: outsider.user.id }, as(owner))).status, 404);
    assert.equal((await call(teamPath + "/transfer", "POST", { userId: owner.user.id }, as(owner))).status, 400);
    const transferred = await call(teamPath + "/transfer", "POST", { userId: admin.user.id }, as(owner));
    assert.equal(transferred.status, 200);
    assert.deepEqual((transferred.body as Detail).members.map((m) => [m.displayName, m.role]), [["Adam Admin", "owner"], ["Olivia Owner", "admin"]]);
    assert.equal(Number(app.rooms.db.prepare("SELECT COUNT(*) n FROM team_members WHERE team_id=? AND role='owner'").get(team.id)!.n), 1);
    // The old owner now has admin rights only and can leave; the new owner deletes.
    assert.equal((await call(teamPath, "DELETE", undefined, as(owner))).status, 403);
    assert.equal((await call(teamPath + "/transfer", "POST", { userId: owner.user.id }, as(owner))).status, 403);
    assert.equal((await call(teamPath + "/leave", "POST", {}, as(owner))).status, 200);
    // The database itself refuses a second owner.
    assert.throws(() =>
      app.rooms.db.prepare("INSERT INTO team_members (team_id,user_id,role,created_at,updated_at) VALUES (?,?,'owner',1,1)").run(team.id, second.user.id),
    );

    // Deleting: owner only; members and pending invitations go with the team.
    await call(teamPath + "/invitations", "POST", { email: second.email }, as(admin));
    assert.equal((await call(teamPath, "DELETE", undefined, as(owner))).status, 404, "a former member gets nothing");
    assert.equal((await call(teamPath, "DELETE", undefined, as(admin))).status, 200);
    assert.equal((await call(teamPath, "GET", undefined, as(admin))).status, 404);
    assert.deepEqual((await call("/me/invitations", "GET", undefined, as(second))).body.invitations, []);
    for (const table of ["teams", "team_members", "team_invitations"])
      assert.equal(Number(app.rooms.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n), 0, table);

    // Cookie writes still need the per-session CSRF token.
    const noCsrf = await call("/teams", "POST", { name: "Sneaky" }, { cookie: owner.cookie });
    assert.equal(noCsrf.status, 403);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team membership grants no access to members' private workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-team-isolation-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, { method, headers: { origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upgrade = (id: string, cookie: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, ["devshare"], { origin, headers: { cookie } });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("unexpected-response", (_q, r) => {
        resolve(r.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
  try {
    const owner = await signUp(base, origin, "Owner"), teammate = await signUp(base, origin, "Teammate");
    const { id: workspace } = (await (await call("/rooms", "POST", { name: "Owner's private notes" }, owner.headers)).json()) as { id: string };
    // Created before and after the team exists: neither becomes visible to the team.
    const team = (await (await call("/teams", "POST", { name: "Shared team" }, owner.headers)).json()) as { id: string };
    const { id: later } = (await (await call("/rooms", "POST", { name: "Made after the team" }, owner.headers)).json()) as { id: string };
    await call(`/teams/${team.id}/invitations`, "POST", { email: teammate.email, role: "admin" }, owner.headers);
    const invite = (await (await call("/me/invitations", "GET", undefined, teammate.headers)).json()).invitations[0];
    assert.equal((await call(`/me/invitations/${invite.id}/accept`, "POST", {}, teammate.headers)).status, 200);
    for (const id of [workspace, later]) {
      const r = await call("/rooms/" + id, "GET", undefined, teammate.headers);
      assert.equal(r.status, 404);
      assert.ok(!(await r.text()).includes("private notes"));
      assert.equal(await upgrade(id, teammate.cookie), 404);
    }
    const lists = [await (await call("/me/workspaces", "GET", undefined, teammate.headers)).json(), await (await call("/me/shared", "GET", undefined, teammate.headers)).json()];
    assert.deepEqual(lists.map((l) => l.workspaces), [[], []]);
    // Team detail never mentions the owner's workspaces.
    const detail = await (await call(`/teams/${team.id}`, "GET", undefined, teammate.headers)).text();
    assert.ok(!detail.includes(workspace) && !detail.includes("private notes"));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the team migration is additive and idempotent on an existing database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-team-migration-"));
  const dbPath = join(dir, "db.sqlite");
  try {
    // A database from before teams existed: accounts and a workspace, no team tables.
    const first = openDatabase(dbPath);
    for (const t of ["team_invitations", "team_members", "teams"]) first.exec(`DROP TABLE ${t}`);
    first.prepare("INSERT INTO users (id,email,display_name,password_hash,created_at,updated_at,password_changed_at) VALUES ('u1','a@example.test','A','x',1,1,1)").run();
    first.close();
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='teams'").get()!.n, 0);
    raw.close();
    for (let i = 0; i < 2; i++) {
      const db = openDatabase(dbPath);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('teams','team_members','team_invitations','team_one_owner') ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(names, ["team_invitations", "team_members", "team_one_owner", "teams"]);
      assert.equal(db.prepare("SELECT display_name FROM users WHERE id='u1'").get()!.display_name, "A", "accounts untouched");
      assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
