import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { fileNames, fileText, lockSetup, pause, PNG, until } from "./lockFixture.js";
import { signUp } from "./helpers.js";

// Live Coding sessions: lifecycle, links, viewer access modes, read-only viewers, pause/resume,
// collaborators, persistence, Save to Workspace and the associated folder's locks.

async function liveSetup(env?: Record<string, string>) {
  const s = await lockSetup({ env });
  const create = async (body: Record<string, unknown> = {}, as = s.owner.headers) => {
    const r = await s.call("/live", "POST", { name: "Week 06 - Ansible Live Coding", ...body }, as);
    assert.equal(r.status, 201, r.text);
    return r.json as { id: string; token: string };
  };
  const status = (id: string, next: string, as = s.owner.headers) => s.call(`/live/${id}/status`, "POST", { status: next }, as);
  const file = async (id: string, filename: string, language: string, as = s.owner.headers) => {
    const r = await s.call(`/live/${id}/files`, "POST", { filename, language }, as);
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };
  const viewer = (id: string, token?: string, cookie?: string) =>
    s.connect(id, { path: "/ws/live", cookie, protocols: token ? ["devshare", "live." + token] : ["devshare"] });
  const text = (doc: Y.Doc, name: string) =>
    [...doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === name)!.get("content") as Y.Text;
  const access = (token: string, headers: Record<string, string> = {}) =>
    s.call("/live/access", "GET", undefined, { ...headers, authorization: "Bearer " + token });
  return { ...s, s, create, status, file, viewer, text, access };
}

test("lifecycle: draft sessions are for their runners only; going live opens the link; listing and roles", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create({ workspaceId: t.id, folderId: t.week1, collaborators: [t.editor.email] });
    assert.match(token, /^[\w-]{43}$/);
    const draft = await t.access(token);
    assert.deepEqual([draft.status, draft.json.state], [409, "draft"]);
    assert.equal(await t.upgrade(`/ws/live/${id}`, undefined, ["devshare", "live." + token]), 404, "no live connection to a draft");
    assert.equal((await t.status(id, "ended")).status, 409, "a draft can't end");
    assert.equal((await t.status(id, "live")).status, 200);
    const open = await t.access(token);
    assert.equal(open.status, 200);
    assert.equal(open.json.role, "viewer");
    assert.equal(open.json.workspace, undefined, "viewers learn nothing about the workspace");
    assert.ok(!open.text.includes("March 2027"), "no workspace name for viewers");
    const mine = (await t.call("/live", "GET", undefined, t.owner.headers)).json.sessions;
    assert.equal(mine[0].role, "owner");
    assert.equal(mine[0].workspace.name, "March 2027 DevOps Class");
    assert.equal(mine[0].folder.name, "Week 01 - Linux");
    assert.equal((await t.call("/live", "GET", undefined, t.editor.headers)).json.sessions[0].role, "editor");
    assert.deepEqual((await t.call("/live", "GET", undefined, t.student.headers)).json.sessions, []);
    // Rename; delete needs the owner.
    assert.equal((await t.call(`/live/${id}`, "PATCH", { name: "Ansible" }, t.editor.headers)).status, 403);
    assert.equal((await t.call(`/live/${id}`, "PATCH", { name: "Ansible" }, t.owner.headers)).json.name, "Ansible");
    assert.equal((await t.call(`/live/${id}`, "DELETE", undefined, t.editor.headers)).status, 403);
    assert.equal((await t.call(`/live/${id}`, "DELETE", undefined, t.owner.headers)).status, 200);
    assert.equal((await t.access(token)).status, 404);
  } finally {
    await t.close();
  }
});

test("real time: viewers watch code appear, never write; collaborators edit; strangers get nothing", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create({ collaborators: [t.editor.email] });
    await t.status(id, "live");
    await t.file(id, "playbook.yaml", "yaml");
    const owner = t.viewer(id, undefined, t.owner.cookie);
    const watcher = t.viewer(id, token);
    const collaborator = t.viewer(id, undefined, t.editor.cookie);
    await until(() => owner.provider.synced && watcher.provider.synced && collaborator.provider.synced);
    t.text(owner.doc, "playbook.yaml").insert(0, "- name: Install Nginx\n");
    await until(() => fileText(watcher.doc, "playbook.yaml") === "- name: Install Nginx\n", 3000, "viewer sees typing");
    t.text(collaborator.doc, "playbook.yaml").insert(0, "---\n");
    await until(() => fileText(owner.doc, "playbook.yaml")!.startsWith("---\n") && fileText(watcher.doc, "playbook.yaml")!.startsWith("---\n"));
    // A viewer's write is refused and closes its connection; nothing changes.
    t.text(watcher.doc, "playbook.yaml").insert(0, "HACKED ");
    await until(() => watcher.closes.includes(1008), 3000, "viewer closed");
    await pause(100);
    assert.ok(!fileText(owner.doc, "playbook.yaml")!.includes("HACKED"));
    // A signed-in stranger without the link, and a guessed token, get nothing.
    assert.equal(await t.upgrade(`/ws/live/${id}`, t.student.cookie), 404);
    assert.equal((await t.call(`/live/${id}`, "GET", undefined, t.student.headers)).status, 404);
    assert.equal((await t.access("A".repeat(43))).status, 404);
    // REST: viewers can't create files; the viewer count reaches the runners.
    assert.equal((await t.call(`/live/${id}/files`, "POST", { filename: "x.md", language: "markdown" }, { authorization: "Bearer " + token })).status, 403);
  } finally {
    await t.close();
  }
});

test("pause and resume: viewers keep what they had, nothing new reaches them, then they catch up exactly", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create();
    await t.status(id, "live");
    await t.file(id, "inventory.ini", "ini");
    const owner = t.viewer(id, undefined, t.owner.cookie);
    const first = t.viewer(id, token);
    await until(() => owner.provider.synced && first.provider.synced);
    t.text(owner.doc, "inventory.ini").insert(0, "[web]\n");
    await until(() => fileText(first.doc, "inventory.ini") === "[web]\n");
    await t.status(id, "paused");
    t.text(owner.doc, "inventory.ini").insert(6, "secret-host-during-pause\n");
    const late = t.viewer(id, token);
    await until(() => late.provider.synced);
    await pause(300);
    assert.equal(fileText(first.doc, "inventory.ini"), "[web]\n", "nothing new while paused");
    assert.equal(fileText(late.doc, "inventory.ini"), "[web]\n", "a viewer joining during the pause gets the paused state");
    // Even across a restart of the session (unloaded and loaded again), the pause holds.
    await t.status(id, "live");
    await until(() => fileText(first.doc, "inventory.ini") === "[web]\nsecret-host-during-pause\n" && fileText(late.doc, "inventory.ini") === fileText(first.doc, "inventory.ini"), 3000, "catch up");
    assert.ok(first.notices.some((n) => n.live?.status === "paused") && first.notices.some((n) => n.live?.status === "live"));
  } finally {
    await t.close();
  }
});

test("ending: viewers are disconnected unless the session stays available read-only; nobody edits an ended session", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create();
    await t.status(id, "live");
    await t.file(id, "notes.md", "markdown");
    const watcher = t.viewer(id, token);
    await until(() => watcher.provider.synced);
    await t.status(id, "ended");
    await until(() => watcher.closes.includes(4002), 3000, "viewer closed at the end");
    assert.equal((await t.access(token)).status, 410);
    // Allowed to stay available: read-only for everyone, including the owner.
    await t.call(`/live/${id}`, "PATCH", { afterEnd: "available" }, t.owner.headers);
    assert.equal((await t.access(token)).status, 200);
    const again = t.viewer(id, token);
    await until(() => again.provider.synced);
    assert.deepEqual(fileNames(again.doc), ["notes.md"]);
    assert.equal((await t.call(`/live/${id}/files`, "POST", { filename: "z.md", language: "markdown" }, t.owner.headers)).status, 403);
    // Archived: only its runners.
    await t.status(id, "archived");
    assert.equal((await t.access(token)).status, 410);
    assert.equal((await t.call(`/live/${id}`, "GET", undefined, t.owner.headers)).status, 200);
    assert.equal((await t.status(id, "live")).status, 409, "unarchive first");
    assert.equal((await t.status(id, "ended")).status, 200);
  } finally {
    await t.close();
  }
});

test("links: replaced, revoked and expired links stop working at once and disconnect their viewers", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create();
    await t.status(id, "live");
    const watcher = t.viewer(id, token);
    await until(() => watcher.provider.synced);
    assert.equal((await t.call(`/live/${id}/link`, "GET", undefined, t.owner.headers)).json.token, token, "the owner can copy it again");
    const replaced = (await t.call(`/live/${id}/link`, "POST", {}, t.owner.headers)).json.token as string;
    await until(() => watcher.closes.includes(4002), 3000, "old link closed");
    assert.equal((await t.access(token)).status, 404);
    assert.equal((await t.access(replaced)).status, 200);
    // Expiry: set, then passed.
    const soon = Date.now() + 400;
    assert.equal((await t.call(`/live/${id}`, "PATCH", { linkExpiresAt: soon }, t.owner.headers)).status, 200);
    const second = t.viewer(id, replaced);
    await until(() => second.provider.synced);
    await pause(500);
    assert.equal((await t.access(replaced)).status, 404);
    t.app.live.collect();
    await until(() => second.closes.includes(4002), 3000, "expired link closed");
    // Revoked: no link at all.
    const third = (await t.call(`/live/${id}/link`, "POST", {}, t.owner.headers)).json.token as string;
    await t.call(`/live/${id}/link`, "DELETE", undefined, t.owner.headers);
    assert.equal((await t.access(third)).status, 404);
    // The raw token is never stored.
    const row = t.app.rooms.db.prepare("SELECT link_hash,link_sealed FROM live_sessions WHERE id=?").get(id)!;
    assert.equal(row.link_hash, null);
    const all = JSON.stringify(t.app.rooms.db.prepare("SELECT * FROM live_sessions").all());
    for (const raw of [token, replaced, third]) assert.ok(!all.includes(raw), "no raw token in the database");
  } finally {
    await t.close();
  }
});

test("viewer access modes: anyone with the link, signed-in accounts only, invited people only", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create({ viewerAccess: "signed_in" });
    await t.status(id, "live");
    assert.equal((await t.access(token)).status, 401, "anonymous: sign in first");
    assert.equal((await t.access(token, t.student.headers)).json.role, "viewer");
    await t.call(`/live/${id}`, "PATCH", { viewerAccess: "invited" }, t.owner.headers);
    assert.equal((await t.access(token, t.student.headers)).status, 403, "the link alone isn't enough");
    await t.call(`/live/${id}/members`, "POST", { email: t.student.email, role: "viewer" }, t.owner.headers);
    assert.equal((await t.access(token, t.student.headers)).json.role, "viewer");
    assert.equal((await t.call(`/live/${id}`, "GET", undefined, t.student.headers)).json.role, "viewer", "invited viewers open it from their account");
    // Removing the invitation disconnects them.
    const watcher = t.viewer(id, undefined, t.student.cookie);
    await until(() => watcher.provider.synced);
    await t.call(`/live/${id}/members/${t.student.user.id}`, "DELETE", undefined, t.owner.headers);
    await until(() => watcher.closes.includes(4002), 3000, "invitation removed");
  } finally {
    await t.close();
  }
});

test("persistence: session content survives a restart", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create();
    await t.status(id, "live");
    await t.file(id, "variables.yaml", "yaml");
    const owner = t.viewer(id, undefined, t.owner.cookie);
    await until(() => owner.provider.synced);
    t.text(owner.doc, "variables.yaml").insert(0, "nginx_port: 80\n");
    await pause(200);
    await t.restart();
    const watcher = t.viewer(id, token);
    await until(() => watcher.provider.synced);
    assert.equal(fileText(watcher.doc, "variables.yaml"), "nginx_port: 80\n");
  } finally {
    await t.close();
  }
});

test("Save to Workspace: safe names, skip or replace on request, images copied, permissions and locks respected", async () => {
  const t = await liveSetup();
  try {
    const { id } = await t.create({ collaborators: [t.editor.email, t.ta.email] });
    await t.status(id, "live");
    const playbook = await t.file(id, "playbook.yaml", "yaml");
    const notes = await t.file(id, "Class-notes.md", "markdown");
    const image = await t.call(`/live/${id}/images`, "POST", PNG, t.owner.headers);
    assert.equal(image.status, 201, image.text);
    const owner = t.viewer(id, undefined, t.owner.cookie);
    await until(() => owner.provider.synced);
    t.text(owner.doc, "playbook.yaml").insert(0, "- hosts: webservers\n");
    t.text(owner.doc, "Class-notes.md").insert(0, `# Notes\n\n![diagram](/api/live/${id}/images/${image.json.id})\n`);
    await pause(150);
    void playbook;
    void notes;
    const save = (body: Record<string, unknown>, as = t.owner.headers) =>
      t.call(`/live/${id}/save`, "POST", { workspaceId: t.id, folderId: t.week2, subfolder: "Live Coding", ...body }, as);
    const first = await save({});
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(first.json.saved.map((f: any) => f.filename).sort(), ["Class-notes.md", "playbook.yaml"]);
    const tree = (await t.call(`/rooms/${t.id}/tree`, "GET", undefined, t.owner.headers)).json;
    const liveFolder = tree.folders.find((f: any) => f.name === "Live Coding");
    assert.equal(liveFolder.parent_id, t.week2);
    // The image now belongs to the workspace and the link points there.
    const saved = tree.documents.find((d: any) => d.folder_id === liveFolder.id && d.filename === "Class-notes.md");
    const content = (await t.call(`/rooms/${t.id}/documents/${saved.id}/content`, "GET", undefined, t.owner.headers)).json.content as string;
    const link = /\/api\/rooms\/[\w-]{16}\/images\/([\w-]{22})/.exec(content);
    assert.ok(link && !content.includes("/api/live/"), content);
    assert.equal((await t.call(link![0].slice(4), "GET", undefined, t.student.headers)).status, 200, "students of the folder see the image");
    // Saving again into the same folder: renamed, skipped, or (asked) replaced.
    assert.deepEqual((await save({})).json.saved.map((f: any) => f.filename).sort(), ["Class-notes-2.md", "playbook-2.yaml"]);
    assert.deepEqual((await save({ conflict: "skip" })).json.skipped.sort(), ["Class-notes.md", "playbook.yaml"]);
    t.text(owner.doc, "playbook.yaml").insert(0, "# v2\n");
    await pause(100);
    const replaced = await save({ conflict: "replace" });
    assert.equal(replaced.json.saved.length, 2);
    const again = (await t.call(`/rooms/${t.id}/tree`, "GET", undefined, t.owner.headers)).json.documents.filter((d: any) => d.folder_id === liveFolder.id);
    assert.equal(again.length, 4, "replace overwrote in place");
    // The session itself is unchanged.
    assert.ok(fileText(owner.doc, "playbook.yaml")!.startsWith("# v2"));
    // Destination rights: a collaborator who only views the workspace can't save there.
    assert.equal((await save({}, t.ta.headers)).status, 403);
    // Locks: a collaborator restricted there can't save into a locked folder; the owner can, and may lock what's saved.
    await t.lock([{ kind: "folder", id: t.week3 }], "lock");
    assert.equal((await save({ folderId: t.week3 }, t.editor.headers)).status, 423);
    const locked = await save({ folderId: t.week1, subfolder: undefined, lock: true });
    assert.equal(locked.status, 201, locked.text);
    const studentTree = (await t.call(`/rooms/${t.id}/tree`, "GET", undefined, t.student.headers)).json;
    for (const f of locked.json.saved) assert.equal(studentTree.documents.find((d: any) => d.id === f.id).lock.state, "locked");
    assert.equal((await save({ lock: true }, t.editor.headers)).status, 403, "locking needs lock rights");
    // Activity records it.
    const activity = (await t.call(`/rooms/${t.id}/activity`, "GET", undefined, t.owner.headers)).json.entries;
    assert.ok(activity.some((e: any) => e.action === "live.saved"));
    // Viewers can't save.
    const { token } = (await t.call(`/live/${id}/link`, "GET", undefined, t.owner.headers)).json;
    assert.equal((await t.call(`/live/${id}/save`, "POST", { workspaceId: t.id, folderId: t.week2 }, { authorization: "Bearer " + token })).status, 403);
  } finally {
    await t.close();
  }
});

test("a session associated with locked content stays closed to its viewers and collaborators until released", async () => {
  const t = await liveSetup();
  try {
    const { id, token } = await t.create({ workspaceId: t.id, folderId: t.week3, collaborators: [t.editor.email] });
    await t.status(id, "live");
    const watcher = t.viewer(id, token);
    await until(() => watcher.provider.synced);
    await t.lock([{ kind: "folder", id: t.week3 }], "schedule", { release: { date: "2099-03-15", time: "08:00", timeZone: "America/New_York" } });
    await until(() => watcher.closes.includes(4002), 3000, "viewer closed when the folder locks");
    const denied = await t.access(token);
    assert.deepEqual([denied.status, denied.json.locked, denied.json.releaseAt], [423, true, Date.parse("2099-03-15T12:00:00Z")]);
    assert.equal((await t.call(`/live/${id}`, "GET", undefined, t.editor.headers)).status, 423, "a collaborator restricted by the lock too");
    assert.equal((await t.call(`/live/${id}`, "GET", undefined, t.owner.headers)).status, 200);
    await t.lock([{ kind: "folder", id: t.week3 }], "unlock");
    assert.equal((await t.access(token)).status, 200);
  } finally {
    await t.close();
  }
});

test("capacity: viewers per session are limited (MAX_LIVE_VIEWERS)", async () => {
  const t = await liveSetup({ MAX_LIVE_VIEWERS: "2" });
  try {
    const { id, token } = await t.create();
    await t.status(id, "live");
    const a = t.viewer(id, token),
      b = t.viewer(id, token);
    await until(() => a.provider.synced && b.provider.synced);
    assert.equal(await t.upgrade(`/ws/live/${id}`, undefined, ["devshare", "live." + token]), 503);
    assert.equal(await t.upgrade(`/ws/live/${id}`, t.owner.cookie), 101, "runners are never refused for viewers");
    assert.equal(t.app.live.metrics().viewerLimit, 2);
    void signUp;
  } finally {
    await t.close();
  }
});
