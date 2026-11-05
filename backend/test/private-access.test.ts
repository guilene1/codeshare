import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("new workspaces are private: no API or WebSocket access without a grant, and nothing reveals they exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-private-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const providers: WebsocketProvider[] = [];
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // The HTTP status a raw WebSocket upgrade gets (101 when it is accepted).
  const upgrade = (id: string, headers: Record<string, string> = {}, protocols = ["devshare"]) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, protocols, { origin, headers });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
  const connect = (id: string, headers: Record<string, string> = {}, protocols = ["devshare"]) => {
    class Socket extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers });
      }
    }
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, new Y.Doc(), {
      WebSocketPolyfill: Socket as never,
      disableBc: true,
      protocols,
    });
    providers.push(provider);
    return provider;
  };
  const closed = (p: WebsocketProvider) =>
    new Promise<number>((resolve) =>
      p.on("connection-close", (e: { code: number } | null) => {
        if (e) {
          p.shouldConnect = false;
          resolve(e.code);
        }
      }),
    );
  // New Markdown workspaces start with notes.md, so find the lesson by name.
  const lesson = (p: WebsocketProvider) =>
    [...p.doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === "lesson.md")?.get("content") as Y.Text | undefined;
  const lessonText = (p: WebsocketProvider) => lesson(p)?.toString();
  try {
    const owner = await signUp(base, origin, "Owner"),
      viewer = await signUp(base, origin, "Viewer"),
      editor = await signUp(base, origin, "Editor"),
      outsider = await signUp(base, origin, "Outsider");
    const created = await call("/rooms", "POST", { name: "Secret course", description: "Private notes", language: "markdown" }, owner.headers);
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const info = await (await call("/rooms/" + id, "GET", undefined, owner.headers)).json();
    assert.deepEqual([info.access, info.visibility], ["owner", "private"], "private by default");
    const doc = await call(`/rooms/${id}/documents`, "POST", { filename: "lesson.md", language: "markdown", content: "TOP SECRET lesson" }, owner.headers);
    assert.equal(doc.status, 201);
    const docId = ((await doc.json()) as { id: string }).id;
    const linkToken = ((await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as { token: string }).token;

    // Nobody without a grant can tell it apart from a workspace that doesn't exist.
    const unknown = await call("/rooms/AAAAAAAAAAAAAAAA");
    const unknownBody = await unknown.text();
    assert.equal(unknown.status, 404);
    for (const [who, headers] of [["anonymous student", {}], ["signed-in outsider", outsider.headers]] as const) {
      for (const path of ["", "/tree", "/blocks", "/activity", "/summary", "/shares", "/editor-link", `/documents/${docId}/content`, "/images/00000000-0000-0000-0000-000000000000"]) {
        const r = await call(`/rooms/${id}${path}`, "GET", undefined, headers);
        const body = await r.text();
        assert.equal(r.status, 404, `${who} GET ${path || "/"}`);
        assert.ok(!body.includes("Secret course") && !body.includes("TOP SECRET") && !body.includes("Private notes"), `${who} ${path}: nothing leaks`);
        if (path === "") assert.equal(body, unknownBody, `${who}: identical to an unknown workspace`);
      }
      for (const [path, method, body] of [
        ["/documents", "POST", { filename: "x.md", language: "markdown" }],
        [`/documents/${docId}/content`, "PUT", { content: "overwritten" }],
        ["/folders", "POST", { name: "x" }],
        ["/visibility", "PUT", { visibility: "link" }],
        ["/shares", "POST", { email: outsider.email, role: "editor" }],
        ["", "PATCH", { name: "Taken" }],
        ["", "DELETE", undefined],
      ] as const)
        assert.equal((await call(`/rooms/${id}${path}`, method, body, headers)).status, 404, `${who} ${method} ${path || "/"}`);
      assert.equal(await upgrade(id, headers.cookie ? { cookie: headers.cookie } : {}), 404, `${who}: WebSocket refused like an unknown workspace`);
    }
    assert.equal(await upgrade("AAAAAAAAAAAAAAAA"), 404);
    assert.equal(app.rooms.active.has(id), true, "the owner's own requests loaded it");
    // A refused WebSocket never loads a private lesson into memory.
    app.rooms.release(app.rooms.get(id)!);
    assert.equal(await upgrade(id), 404);
    assert.equal(app.rooms.active.has(id), false);
    // Nothing changed.
    const after = await (await call(`/rooms/${id}/documents/${docId}/content`, "GET", undefined, owner.headers)).json();
    assert.equal(after.content, "TOP SECRET lesson");
    assert.equal((await (await call("/rooms/" + id, "GET", undefined, owner.headers)).json()).name, "Secret course");

    // Grants still work in a private workspace: viewer share, editor share and Edit Link.
    for (const [who, role] of [[viewer, "viewer"], [editor, "editor"]] as const)
      assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: who.email, role }, owner.headers)).status, 201);
    const asViewer = await (await call("/rooms/" + id, "GET", undefined, viewer.headers)).json();
    assert.deepEqual([asViewer.access, asViewer.visibility], ["viewer", "private"]);
    assert.equal((await call(`/rooms/${id}/documents/${docId}/content`, "GET", undefined, viewer.headers)).status, 200);
    assert.equal((await call(`/rooms/${id}/documents`, "POST", { filename: "v.md", language: "markdown" }, viewer.headers)).status, 403);
    assert.equal((await call(`/rooms/${id}/visibility`, "PUT", { visibility: "link" }, viewer.headers)).status, 403);
    assert.equal((await (await call("/rooms/" + id, "GET", undefined, editor.headers)).json()).access, "editor");
    const bearer = { authorization: "Bearer " + linkToken };
    assert.equal((await (await call("/rooms/" + id, "GET", undefined, bearer)).json()).access, "editor", "Edit Links keep working");
    assert.equal((await call(`/rooms/${id}/visibility`, "PUT", { visibility: "link" }, bearer)).status, 403, "link guests can't change access");

    // Live: the share viewer reads but can't write; the Edit Link guest and owner edit.
    const ownerDoc = connect(id, { cookie: owner.cookie });
    const viewerDoc = connect(id, { cookie: viewer.cookie });
    const guestDoc = connect(id, {}, ["devshare", "editor." + linkToken]);
    await until(() => ownerDoc.synced && viewerDoc.synced && guestDoc.synced);
    assert.equal(lessonText(viewerDoc), "TOP SECRET lesson");
    const viewerRefused = closed(viewerDoc);
    lesson(viewerDoc)!.insert(0, "hack ");
    assert.equal(await viewerRefused, 1008);
    lesson(guestDoc)!.insert(0, "Guest: ");
    await until(() => lessonText(ownerDoc) === "Guest: TOP SECRET lesson");

    // General access: the owner turns on "Anyone with the link" and students can view
    // without signing in; switching back closes the anonymous socket and nobody else's.
    assert.equal((await call(`/rooms/${id}/visibility`, "PUT", { visibility: "sideways" }, owner.headers)).status, 400);
    const opened = await call(`/rooms/${id}/visibility`, "PUT", { visibility: "link" }, owner.headers);
    assert.deepEqual([opened.status, (await opened.json()).visibility], [200, "link"]);
    assert.equal((await (await call("/rooms/" + id)).json()).access, "viewer");
    const student = connect(id);
    await until(() => student.synced && lessonText(student) === "Guest: TOP SECRET lesson");
    const studentClosed = closed(student);
    let ownerClosed = false, guestClosed = false;
    ownerDoc.on("connection-close", () => (ownerClosed = true));
    guestDoc.on("connection-close", () => (guestClosed = true));
    assert.equal((await call(`/rooms/${id}/visibility`, "PUT", { visibility: "private" }, editor.headers)).status, 200, "editor shares manage access like sharing");
    assert.equal(await studentClosed, 1008);
    assert.equal(await upgrade(id), 404, "the student can't reconnect");
    assert.equal((await call("/rooms/" + id)).status, 404);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ownerClosed || guestClosed, false, "owner and Edit Link sessions were not interrupted");
    const activity = app.rooms.db.prepare("SELECT action,label FROM activity WHERE workspace_id=? AND action='access.changed' ORDER BY rowid").all(id);
    assert.deepEqual(activity.map((a) => a.label), ["Anyone with the link", "Restricted"]);

    // Removing a viewer's share in a private workspace takes away read access completely.
    const viewerAgain = connect(id, { cookie: viewer.cookie });
    await until(() => viewerAgain.synced);
    const viewerDropped = closed(viewerAgain);
    assert.equal((await call(`/rooms/${id}/shares/${viewer.user.id}`, "DELETE", undefined, owner.headers)).status, 200);
    assert.equal(await viewerDropped, 1008);
    assert.equal((await call("/rooms/" + id, "GET", undefined, viewer.headers)).status, 404);
    assert.equal(await upgrade(id, { cookie: viewer.cookie }), 404);
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing workspaces keep link access after the migration; new ones can opt in to it at creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-visibility-"));
  const dbPath = join(dir, "db.sqlite");
  // A database written before general access existed (the original rooms schema).
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, state BLOB NOT NULL
    )`);
  const legacyDoc = new Y.Doc();
  old.prepare("INSERT INTO rooms (id,name,created_at,updated_at,last_activity,state) VALUES (?,?,?,?,?,?)")
    .run("LegacyRoom000001", "Old class", 1, 2, 3, Y.encodeStateAsUpdate(legacyDoc));
  old.close();
  const app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const row = app.rooms.db.prepare("SELECT visibility,name,created_at,updated_at FROM rooms WHERE id=?").get("LegacyRoom000001");
    assert.deepEqual({ ...row }, { visibility: "link", name: "Old class", created_at: 1, updated_at: 2 });
    const legacy = await (await fetch(base + "/api/rooms/LegacyRoom000001")).json();
    assert.deepEqual([legacy.access, legacy.visibility], ["viewer", "link"], "the student link still works without signing in");
    const owner = await signUp(base, origin);
    const json = { ...owner.headers, "content-type": "application/json" };
    const open = await fetch(base + "/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "Open class", visibility: "link" }) });
    const { id } = (await open.json()) as { id: string };
    assert.equal((await (await fetch(base + "/api/rooms/" + id)).json()).access, "viewer");
    const bad = await fetch(base + "/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "Bad", visibility: "public" }) });
    assert.equal(bad.status, 400);
    const mine = (await (await fetch(base + "/api/me/workspaces", { headers: owner.headers })).json()) as { workspaces: { name: string; visibility: string }[] };
    assert.deepEqual(mine.workspaces.map((w) => [w.name, w.visibility]), [["Open class", "link"]]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
