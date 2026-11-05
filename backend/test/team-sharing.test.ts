import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("team sharing: explicit roles, highest grant wins, live collaboration and immediate revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-team-share-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const providers: WebsocketProvider[] = [];
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
  const upgrade = (id: string, cookie?: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, ["devshare"], { origin, headers: cookie ? { cookie } : {} });
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
  // A live collaborator; `closes` counts server-initiated closes (access changes).
  const connect = (id: string, cookie?: string, protocols = ["devshare"]) => {
    class Socket extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers: cookie ? { cookie } : {} });
      }
    }
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, new Y.Doc(), {
      WebSocketPolyfill: Socket as never,
      disableBc: true,
      protocols,
    });
    const state = { provider, closes: [] as number[] };
    provider.on("connection-close", (e: { code: number } | null) => e && state.closes.push(e.code));
    providers.push(provider);
    return state;
  };
  const lesson = (p: WebsocketProvider) =>
    [...p.doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === "lesson.md")?.get("content") as Y.Text | undefined;
  const accept = async (who: { headers: Record<string, string> }) => {
    const invitation = (await call("/me/invitations", "GET", undefined, who.headers)).body.invitations[0];
    assert.equal((await call(`/me/invitations/${invitation.id}/accept`, "POST", {}, who.headers)).status, 200);
  };
  const accessOf = async (id: string, who: { headers: Record<string, string> }) => {
    const r = await call("/rooms/" + id, "GET", undefined, who.headers);
    return r.status === 200 ? r.body.access : r.status;
  };
  try {
    const owner = await signUp(base, origin, "Olivia Owner"),
      admin = await signUp(base, origin, "Adam TeamAdmin"),
      member = await signUp(base, origin, "Mia Member"),
      newcomer = await signUp(base, origin, "Nina Newcomer"),
      outsider = await signUp(base, origin, "Otto Outsider");
    // A private workspace with a lesson, and a team the owner belongs to.
    const { id } = (await call("/rooms", "POST", { name: "Terraform Class", language: "markdown" }, owner.headers)).body as { id: string };
    assert.equal((await call(`/rooms/${id}/documents`, "POST", { filename: "lesson.md", language: "markdown", content: "Lesson" }, owner.headers)).status, 201);
    const team = (await call("/teams", "POST", { name: "DevOps Team" }, owner.headers)).body as { id: string };
    for (const [who, role] of [[admin, "admin"], [member, "member"]] as const) {
      await call(`/teams/${team.id}/invitations`, "POST", { email: who.email, role }, owner.headers);
      await accept(who);
    }
    const otherTeam = (await call("/teams", "POST", { name: "Outsiders" }, outsider.headers)).body as { id: string };

    // 1. Membership alone grants nothing.
    for (const who of [admin, member]) {
      assert.equal(await accessOf(id, who), 404);
      assert.equal(await upgrade(id, who.cookie), 404);
    }
    assert.deepEqual((await call(`/teams/${team.id}/workspaces`, "GET", undefined, member.headers)).body.workspaces, []);

    // 2. Only the owner shares with a team, and only with teams they belong to.
    assert.equal((await call(`/rooms/${id}/team-shares`, "POST", { teamId: team.id }, admin.headers)).status, 404, "a team admin with no access sees nothing");
    assert.equal((await call(`/rooms/${id}/team-shares`, "POST", { teamId: otherTeam.id }, owner.headers)).status, 404, "not one of the owner's teams");
    assert.equal((await call(`/rooms/${id}/team-shares`, "POST", { teamId: "nope" }, owner.headers)).status, 404);
    assert.equal((await call(`/rooms/${id}/team-shares`, "POST", { teamId: team.id, role: "owner" }, owner.headers)).status, 400);
    const shared = await call(`/rooms/${id}/team-shares`, "POST", { teamId: team.id, role: "viewer" }, owner.headers);
    assert.equal(shared.status, 201);
    assert.deepEqual(shared.body.teamShares.map((s: any) => [s.name, s.role, s.memberCount]), [["DevOps Team", "viewer", 3]]);

    // 3. Viewer team share: members read, never write; team roles add no management rights.
    for (const who of [admin, member]) assert.equal(await accessOf(id, who), "viewer");
    assert.equal((await call(`/rooms/${id}/documents`, "POST", { filename: "x.md", language: "markdown" }, member.headers)).status, 403);
    const asAdmin = (await call("/rooms/" + id, "GET", undefined, admin.headers)).body;
    assert.equal(asAdmin.canShare, false, "a team admin can't manage sharing");
    for (const [path, method, body] of [
      ["/team-shares", "GET", undefined],
      ["/team-shares", "POST", { teamId: team.id, role: "editor" }],
      ["/shares", "POST", { email: outsider.email }],
      ["/visibility", "PUT", { visibility: "link" }],
      ["/editor-link", "POST", {}],
    ] as const)
      assert.equal((await call(`/rooms/${id}${path}`, method, body, admin.headers)).status, 403, `team admin ${method} ${path}`);
    assert.deepEqual((await call(`/teams/${team.id}/workspaces`, "GET", undefined, member.headers)).body.workspaces.map((w: any) => [w.name, w.role, w.ownerName]), [["Terraform Class", "viewer", "Olivia Owner"]]);
    assert.equal((await call(`/teams/${team.id}/workspaces`, "GET", undefined, outsider.headers)).status, 404);
    // Live: the team viewer receives the owner's edits; its own edit is refused.
    const ownerLive = connect(id, owner.cookie), memberLive = connect(id, member.cookie);
    await until(() => ownerLive.provider.synced && memberLive.provider.synced && !!lesson(memberLive.provider));
    lesson(ownerLive.provider)!.insert(0, "Hello ");
    await until(() => lesson(memberLive.provider)?.toString() === "Hello Lesson");
    lesson(memberLive.provider)!.insert(0, "hack ");
    await until(() => memberLive.closes.includes(1008));
    memberLive.provider.shouldConnect = false;
    assert.equal(lesson(ownerLive.provider)!.toString(), "Hello Lesson");

    // 4. Upgrading the team to Editor reconnects its viewers, who then edit in real time.
    const memberViewer = connect(id, member.cookie);
    await until(() => memberViewer.provider.synced);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "editor" }, admin.headers)).status, 403);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "editor" }, owner.headers)).status, 200);
    await until(() => memberViewer.closes.length === 1);
    memberViewer.provider.shouldConnect = false;
    assert.deepEqual(ownerLive.closes, [], "the owner's session is untouched");
    assert.equal(await accessOf(id, member), "editor");
    const memberEditor = connect(id, member.cookie);
    await until(() => memberEditor.provider.synced && !!lesson(memberEditor.provider));
    lesson(memberEditor.provider)!.insert(0, "Team: ");
    await until(() => lesson(ownerLive.provider)?.toString() === "Team: Hello Lesson");
    // Team Editors edit content but never manage the workspace.
    assert.equal((await call(`/rooms/${id}/documents`, "POST", { filename: "team.md", language: "markdown" }, member.headers)).status, 201);
    assert.equal((await call("/rooms/" + id, "GET", undefined, member.headers)).body.canShare, false);
    for (const [path, method, body] of [["", "PATCH", { name: "Taken" }], ["", "DELETE", undefined], ["/visibility", "PUT", { visibility: "link" }], ["/shares", "GET", undefined]] as const)
      assert.equal((await call(`/rooms/${id}${path}`, method, body, member.headers)).status, 403, `team editor ${method} ${path || "/"}`);

    // 5. Combinations: the highest grant wins, and losing one grant keeps the others.
    assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: member.email, role: "viewer" }, owner.headers)).status, 201);
    assert.equal(await accessOf(id, member), "editor", "team Editor beats a direct Viewer share");
    await until(() => memberEditor.provider.synced);
    assert.deepEqual(memberEditor.closes, [], "adding a lower grant closes nothing");
    await call(`/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "viewer" }, owner.headers);
    await until(() => memberEditor.closes.length === 1, 3000);
    memberEditor.provider.shouldConnect = false;
    assert.equal(await accessOf(id, member), "viewer");
    // Same level through two grants: removing either keeps the session open.
    await call(`/rooms/${id}/shares/${member.user.id}`, "PATCH", { role: "editor" }, owner.headers);
    await call(`/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "editor" }, owner.headers);
    const twoGrants = connect(id, member.cookie);
    await until(() => twoGrants.provider.synced);
    assert.equal((await call(`/rooms/${id}/shares/${member.user.id}`, "DELETE", undefined, owner.headers)).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(twoGrants.closes, [], "still an Editor through the team");
    assert.equal(await accessOf(id, member), "editor");
    twoGrants.provider.destroy();
    // An Edit Link guest is unaffected by team changes.
    const token = (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).body.token as string;
    const guest = connect(id, undefined, ["devshare", "editor." + token]);
    await until(() => guest.provider.synced);

    // 6. A new member gets access as soon as they accept, and an open link session
    //    reconnects with the team's role.
    const linkRoom = (await call("/rooms", "POST", { name: "Open lab", visibility: "link" }, owner.headers)).body.id as string;
    await call(`/rooms/${linkRoom}/team-shares`, "POST", { teamId: team.id, role: "editor" }, owner.headers);
    assert.equal(await accessOf(linkRoom, newcomer), "viewer", "a link viewer before joining");
    const newcomerLink = connect(linkRoom, newcomer.cookie);
    await until(() => newcomerLink.provider.synced);
    await call(`/teams/${team.id}/invitations`, "POST", { email: newcomer.email }, admin.headers);
    assert.equal(await accessOf(id, newcomer), 404, "an invitation alone grants nothing");
    await accept(newcomer);
    assert.equal(await accessOf(id, newcomer), "editor");
    assert.equal(await accessOf(linkRoom, newcomer), "editor");
    await until(() => newcomerLink.closes.length === 1);
    newcomerLink.provider.shouldConnect = false;
    // Team roles inside the team don't change workspace access.
    await call(`/teams/${team.id}/members/${newcomer.user.id}`, "PATCH", { role: "admin" }, owner.headers);
    assert.equal(await accessOf(id, newcomer), "editor");

    // 7. Removing a member revokes at once: live session closed, REST and WebSocket refused.
    const newcomerLive = connect(id, newcomer.cookie);
    await until(() => newcomerLive.provider.synced);
    assert.equal((await call(`/teams/${team.id}/members/${newcomer.user.id}`, "DELETE", undefined, owner.headers)).status, 200);
    await until(() => newcomerLive.closes.length === 1);
    newcomerLive.provider.shouldConnect = false;
    assert.equal(await accessOf(id, newcomer), 404);
    assert.equal(await upgrade(id, newcomer.cookie), 404);
    assert.equal(await accessOf(linkRoom, newcomer), "viewer", "back to link access only");
    // Leaving works the same way.
    const adminLive = connect(id, admin.cookie);
    await until(() => adminLive.provider.synced);
    assert.equal((await call(`/teams/${team.id}/leave`, "POST", {}, admin.headers)).status, 200);
    await until(() => adminLive.closes.length === 1);
    adminLive.provider.shouldConnect = false;
    assert.equal(await accessOf(id, admin), 404);

    // 8. Removing the team share revokes it for everyone in the team at once.
    const memberAgain = connect(id, member.cookie);
    await until(() => memberAgain.provider.synced);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "DELETE", undefined, member.headers)).status, 403);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "DELETE", undefined, owner.headers)).status, 200);
    await until(() => memberAgain.closes.length === 1);
    memberAgain.provider.shouldConnect = false;
    assert.equal(await accessOf(id, member), 404);
    assert.deepEqual((await call(`/teams/${team.id}/workspaces`, "GET", undefined, member.headers)).body.workspaces.map((w: any) => w.name), ["Open lab"]);

    // 9. Deleting the team revokes every workspace it was shared with.
    await call(`/rooms/${id}/team-shares`, "POST", { teamId: team.id, role: "viewer" }, owner.headers);
    const beforeDelete = connect(id, member.cookie);
    await until(() => beforeDelete.provider.synced);
    assert.equal((await call(`/teams/${team.id}`, "DELETE", undefined, owner.headers)).status, 200);
    await until(() => beforeDelete.closes.length === 1);
    beforeDelete.provider.shouldConnect = false;
    assert.equal(await accessOf(id, member), 404);
    assert.equal(Number(app.rooms.db.prepare("SELECT COUNT(*) n FROM workspace_team_shares WHERE team_id=?").get(team.id)!.n), 0);

    // Sessions that never depended on the team were never interrupted.
    assert.deepEqual([ownerLive.closes, guest.closes], [[], []]);
    assert.ok(ownerLive.provider.wsconnected && guest.provider.wsconnected);
    // The activity log records team sharing (it stays out of the live content feed).
    const actions = app.rooms.db.prepare("SELECT action FROM activity WHERE workspace_id=? AND action LIKE 'team.%' ORDER BY rowid").all(id).map((r) => r.action);
    assert.deepEqual(actions.slice(0, 3), ["team.shared", "team.changed", "team.changed"]);
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team shares belong to the owner: they survive the owner leaving the team, and only the owner removes them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-team-share-owner-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api" + path, { method, headers: { origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const owner = await signUp(base, origin, "Owner"), next = await signUp(base, origin, "Next owner"), editorShare = await signUp(base, origin, "Direct editor");
    const { id } = (await call("/rooms", "POST", { name: "Course" }, owner.headers)).body;
    const team = (await call("/teams", "POST", { name: "Team" }, owner.headers)).body;
    await call(`/teams/${team.id}/invitations`, "POST", { email: next.email }, owner.headers);
    const inv = (await call("/me/invitations", "GET", undefined, next.headers)).body.invitations[0];
    await call(`/me/invitations/${inv.id}/accept`, "POST", {}, next.headers);
    await call(`/rooms/${id}/team-shares`, "POST", { teamId: team.id, role: "editor" }, owner.headers);
    // A direct Editor share can see team shares but not change them.
    await call(`/rooms/${id}/shares`, "POST", { email: editorShare.email, role: "editor" }, owner.headers);
    assert.equal((await call(`/rooms/${id}/team-shares`, "GET", undefined, editorShare.headers)).status, 200);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "PATCH", { role: "viewer" }, editorShare.headers)).status, 403);
    // The owner hands the team over and leaves it: the share stays for the team.
    await call(`/teams/${team.id}/transfer`, "POST", { userId: next.user.id }, owner.headers);
    assert.equal((await call(`/teams/${team.id}/leave`, "POST", {}, owner.headers)).status, 200);
    assert.equal((await call("/rooms/" + id, "GET", undefined, next.headers)).body.access, "editor");
    assert.equal((await call("/rooms/" + id, "GET", undefined, owner.headers)).body.access, "owner", "the owner keeps the workspace");
    // The new team owner can't change the share; the workspace owner still can.
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "DELETE", undefined, next.headers)).status, 403);
    assert.equal((await call(`/rooms/${id}/team-shares/${team.id}`, "DELETE", undefined, owner.headers)).status, 200);
    assert.equal((await call("/rooms/" + id, "GET", undefined, next.headers)).status, 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
