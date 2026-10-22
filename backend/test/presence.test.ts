import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { signUp } from "./helpers.js";

const origin = "http://localhost:5173";
async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
type Presence = {
  total: number;
  users: Array<{ name: string; role: string; you: boolean }>;
  guests: Array<{ name: string; you: boolean }>;
  anonymous: number;
};
type Entry = {
  id: string;
  action: string;
  label: string;
  created_at: number;
  actor: { kind: string; name?: string } | null;
};

test("presence and activity reach Owners and Editors only, with verified attribution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-presence-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const providers: WebsocketProvider[] = [];
  // A client that records every Kodelumi JSON message (type 4) it receives.
  const connect = (
    room: string,
    options: { headers?: Record<string, string>; token?: string; user?: string } = {},
  ) => {
    class Socket extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers: options.headers ?? {} });
      }
    }
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", room, doc, {
      WebSocketPolyfill: Socket as never,
      disableBc: true,
      protocols: options.token ? ["devshare", "editor." + options.token] : ["devshare"],
    });
    const messages: Array<{ presence?: Presence; activity?: Entry }> = [];
    provider.messageHandlers[4] = (_encoder, decoder) => {
      messages.push(JSON.parse(decoding.readVarString(decoder)));
    };
    if (options.user)
      provider.awareness.setLocalStateField("user", { name: options.user, color: "#38bdf8" });
    else provider.awareness.setLocalState({ viewer: true });
    providers.push(provider);
    const latest = () => messages.filter((m) => m.presence).at(-1)?.presence;
    return { provider, messages, latest };
  };
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const text = (p: WebsocketProvider) => {
    const docs = p.doc.getMap<Y.Map<unknown>>("documents");
    return docs.get([...docs.keys()][0])!.get("content") as Y.Text;
  };
  try {
    const owner = await signUp(base, origin, "Olivia Owner");
    const ed = await signUp(base, origin, "Ed Editor");
    const vera = await signUp(base, origin, "Vera Viewer");
    const { id } = (await (
      await call("/rooms", "POST", { name: "Presence course", language: "yaml" }, owner.headers)
    ).json()) as { id: string };
    for (const [person, role] of [
      [ed, "editor"],
      [vera, "viewer"],
    ] as const)
      assert.equal(
        (await call(`/rooms/${id}/shares`, "POST", { email: person.email, role }, owner.headers)).status,
        201,
      );
    const { token } = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as {
      token: string;
    };

    // Two tabs of the owner count once; the share editor, a registered viewer, two anonymous
    // viewers and a private-link guest are all counted.
    const ownerTab = connect(id, { headers: { cookie: owner.cookie }, user: "Olivia Owner" });
    const ownerTab2 = connect(id, { headers: { cookie: owner.cookie }, user: "Olivia Owner" });
    const edTab = connect(id, { headers: { cookie: ed.cookie }, user: "Ed Editor" });
    const veraTab = connect(id, { headers: { cookie: vera.cookie } });
    const anon1 = connect(id);
    const anon2 = connect(id);
    const guest = connect(id, { token, user: "Sam" });
    await until(() => ownerTab.latest()?.total === 6 && ownerTab.latest()?.guests[0]?.name === "Sam");
    const summary = ownerTab.latest()!;
    assert.deepEqual(summary.users, [
      { name: "Olivia Owner", role: "owner", you: true },
      { name: "Ed Editor", role: "editor", you: false },
      { name: "Vera Viewer", role: "viewer", you: false },
    ]);
    assert.deepEqual(summary.guests, [{ name: "Sam", you: false }]);
    assert.equal(summary.anonymous, 2);
    await until(() => edTab.latest()?.total === 6);
    assert.equal(edTab.latest()!.users.find((u) => u.you)?.name, "Ed Editor");
    await until(() => guest.latest()?.guests[0]?.you === true);

    // Viewers never receive presence or activity messages, nor other viewers' awareness.
    await until(() => veraTab.provider.awareness.getStates().size >= 2);
    for (const viewer of [veraTab, anon1, anon2]) {
      for (const state of viewer.provider.awareness.getStates().values())
        if (state !== viewer.provider.awareness.getLocalState()) assert.equal(state.role, "editor");
    }
    // Owners still see viewers' awareness (unchanged classroom behaviour).
    await until(
      () => [...ownerTab.provider.awareness.getStates().values()].filter((s) => s.role === "viewer").length === 3,
    );

    // Leaving and reconnecting update the counts; one closed owner tab keeps the owner online.
    anon2.provider.destroy();
    ownerTab2.provider.destroy();
    await until(() => ownerTab.latest()?.total === 5 && ownerTab.latest()?.anonymous === 1);
    assert.ok(ownerTab.latest()!.users.some((u) => u.role === "owner"));
    const anon3 = connect(id);
    await until(() => ownerTab.latest()?.anonymous === 2);
    anon3.provider.destroy();
    await until(() => ownerTab.latest()?.anonymous === 1);

    // Text edits are attributed to the verified account and coalesced per file and person.
    await until(() => edTab.provider.synced && ownerTab.provider.synced && guest.provider.synced);
    const filename = "config.yaml";
    text(edTab.provider).insert(0, "a");
    await until(() =>
      ownerTab.messages.some((m) => m.activity?.action === "file.edited" && m.activity.actor?.name === "Ed Editor"),
    );
    const firstEdit = ownerTab.messages.find((m) => m.activity?.action === "file.edited")!.activity!;
    assert.equal(firstEdit.label, filename);
    for (const letter of "bcdef") {
      text(edTab.provider).insert(0, letter);
      await new Promise((r) => setTimeout(r, 40));
    }
    text(guest.provider).insert(0, "g");
    text(ownerTab.provider).insert(0, "o");
    await until(() => ownerTab.messages.filter((m) => m.activity?.actor?.kind === "link").length > 0);
    await until(() => ownerTab.messages.some((m) => m.activity?.actor?.name === "Olivia Owner"));

    const activity = async (headers: Record<string, string> = {}, query = "") =>
      call(`/rooms/${id}/activity${query}`, "GET", undefined, headers);
    const page = (await (await activity(owner.headers)).json()) as { entries: Entry[]; hasMore: boolean };
    const edits = page.entries.filter((e) => e.action === "file.edited");
    // One row each for Ed, the guest and the owner, despite many keystrokes.
    assert.equal(edits.length, 3);
    assert.deepEqual(
      edits.map((e) => (e.actor?.kind === "user" ? e.actor.name : e.actor?.kind)).sort(),
      ["Ed Editor", "Olivia Owner", "link"],
    );
    const edRow = edits.find((e) => e.actor?.name === "Ed Editor")!;
    assert.equal(edRow.id, firstEdit.id);
    assert.ok(edRow.created_at >= firstEdit.created_at);
    // The guest's self-entered name is never stored.
    assert.deepEqual(edits.find((e) => e.actor?.kind === "link")!.actor, { kind: "link" });
    assert.equal(
      app.rooms.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE actor_name='Sam'").get()!.n,
      0,
    );

    // REST changes are attributed too; sharing events never reach Editors.
    const created = (await (
      await call(`/rooms/${id}/documents`, "POST", { filename: "kubernetes.yaml", language: "yaml" }, ed.headers)
    ).json()) as { id: string };
    assert.equal(
      (await call(`/rooms/${id}/documents/${created.id}`, "PATCH", { filename: "k8s.yaml" }, ed.headers)).status,
      200,
    );
    assert.equal((await call(`/rooms/${id}/folders`, "POST", { name: "Week 1" }, owner.headers)).status, 201);
    assert.equal((await call(`/rooms/${id}/documents/${created.id}`, "DELETE", undefined, ed.headers)).status, 200);
    await until(() => edTab.messages.some((m) => m.activity?.action === "file.deleted"));
    const edView = (await (await activity(ed.headers)).json()) as { entries: Entry[] };
    assert.deepEqual(
      edView.entries.slice(0, 4).map((e) => [e.action, e.label, e.actor?.kind === "user" ? e.actor.name : null]),
      [
        ["file.deleted", "k8s.yaml", "Ed Editor"],
        ["folder.created", "Week 1", "Olivia Owner"],
        ["file.renamed", "k8s.yaml", "Ed Editor"],
        ["file.created", "kubernetes.yaml", "Ed Editor"],
      ],
    );
    assert.ok(edView.entries.every((e) => !e.action.startsWith("share.") && !e.action.startsWith("link.")));
    assert.ok(edView.entries.every((e) => !("actor_id" in e) && !JSON.stringify(e).includes(ed.user.id)));
    assert.ok(
      edTab.messages.every((m) => !m.activity || (!m.activity.action.startsWith("share.") && !m.activity.action.startsWith("link."))),
    );

    // Paging returns the next entries without overlap.
    const first = (await (await activity(owner.headers, "?limit=2")).json()) as { entries: Entry[]; hasMore: boolean };
    assert.equal(first.entries.length, 2);
    assert.equal(first.hasMore, true);
    const last = first.entries[1];
    const second = (await (
      await activity(owner.headers, `?limit=2&before=${last.created_at}&beforeId=${last.id}`)
    ).json()) as { entries: Entry[] };
    assert.equal(second.entries.length, 2);
    assert.ok(second.entries.every((e) => !first.entries.some((f) => f.id === e.id)));

    // Registered and anonymous viewers are refused, exactly like an unknown endpoint.
    for (const headers of [vera.headers, {}]) {
      const response = await activity(headers);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Endpoint not found." });
    }
    for (const viewer of [veraTab, anon1]) assert.deepEqual(viewer.messages, []);
  } finally {
    // Destroying the doc also stops each client's awareness timer.
    for (const provider of providers) {
      provider.destroy();
      provider.doc.destroy();
    }
    await app.close();
  }
});

test("an untracked socket is denied presence, activity and viewers' awareness by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-untracked-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const providers: WebsocketProvider[] = [];
  const connect = (room: string, headers: Record<string, string> = {}, user?: string) => {
    class Socket extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers });
      }
    }
    const provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", room, new Y.Doc(), {
      WebSocketPolyfill: Socket as never,
      disableBc: true,
      protocols: ["devshare"],
    });
    const json: unknown[] = [];
    provider.messageHandlers[4] = (_encoder, decoder) => {
      json.push(JSON.parse(decoding.readVarString(decoder)));
    };
    if (user) provider.awareness.setLocalStateField("user", { name: user, color: "#38bdf8" });
    else provider.awareness.setLocalState({ viewer: true });
    providers.push(provider);
    return { provider, json };
  };
  // A raw socket in the room with no tracking entry: it records every frame sent to it.
  const frames: Uint8Array[] = [];
  const untracked = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (data: Uint8Array) => frames.push(data),
    close: () => {},
  } as unknown as WebSocket;
  // Decodes awareness frames (type 1) into their JSON states.
  const awarenessStates = () =>
    frames.flatMap((frame) => {
      const decoder = decoding.createDecoder(frame);
      if (decoding.readVarUint(decoder) !== 1) return [];
      const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
      return Array.from({ length: decoding.readVarUint(update) }, () => {
        decoding.readVarUint(update);
        decoding.readVarUint(update);
        return JSON.parse(decoding.readVarString(update));
      });
    });
  const types = () => frames.map((frame) => decoding.readVarUint(decoding.createDecoder(frame)));
  try {
    const owner = await signUp(base, origin, "Olivia Owner");
    const { id } = (await (
      await fetch(base + "/api/rooms", {
        method: "POST",
        headers: { ...owner.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Untracked check", language: "yaml" }),
      })
    ).json()) as { id: string };
    const ownerTab = connect(id, { cookie: owner.cookie }, "Olivia Owner");
    await until(() => ownerTab.provider.synced && !!app.rooms.active.get(id));
    const room = app.rooms.active.get(id)!;
    room.peers.set(untracked, new Set());
    assert.equal(app.rooms.live.has(untracked), false);
    assert.equal(app.rooms.canSeePresence(untracked), false);
    // The owner's cursor moves after the socket joined, so it is broadcast to the room.
    ownerTab.provider.awareness.setLocalStateField("fileId", "after-join");

    // Presence: a viewer joins, which pushes presence to the owner only.
    const viewer = connect(id);
    await until(() => ownerTab.json.some((m) => (m as { presence?: { anonymous: number } }).presence?.anonymous === 1));
    await until(() =>
      [...ownerTab.provider.awareness.getStates().values()].some((state) => state.role === "viewer"),
    );
    // Activity: an edit and a recorded change, pushed to the owner only.
    const docs = ownerTab.provider.doc.getMap<Y.Map<unknown>>("documents");
    (docs.get([...docs.keys()][0])!.get("content") as Y.Text).insert(0, "x");
    await until(() => ownerTab.json.some((m) => (m as { activity?: { action: string } }).activity?.action === "file.edited"));
    app.rooms.record(id, "file.created", "secret.yaml", { kind: "user", id: owner.user.id, name: "Olivia Owner" });
    await until(() => ownerTab.json.some((m) => (m as { activity?: { label: string } }).activity?.label === "secret.yaml"));
    // Direct calls to the JSON sender are refused for it too.
    app.rooms.sendJson!(untracked, { presence: { total: 99 } });
    app.rooms.schedulePresence(id);
    await new Promise((r) => setTimeout(r, 400));

    // Control: the untracked socket really was in the room and got ordinary traffic.
    assert.ok(types().includes(0), "receives document updates");
    assert.ok(awarenessStates().some((state) => state?.role === "editor"), "receives editor cursors");
    // Denied: no type-4 frame and no viewer awareness state, exactly like a viewer.
    assert.equal(types().filter((type) => type === 4).length, 0);
    assert.ok(awarenessStates().every((state) => state === null || state.role !== "viewer"));
    assert.ok(!frames.some((frame) => Buffer.from(frame).includes("secret.yaml")));
    // Unchanged: tracked viewers still get nothing protected; the owner gets everything.
    assert.deepEqual(viewer.json, []);
    assert.ok(ownerTab.json.length >= 3);
    room.peers.delete(untracked);
  } finally {
    for (const provider of providers) {
      provider.destroy();
      provider.doc.destroy();
    }
    await app.close();
  }
});

test("activity attribution migration is additive and keeps older rows readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-activity-migration-"));
  const path = join(dir, "db.sqlite");
  // The bee7058 schema for rooms/activity, with one existing activity row.
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, state BLOB NOT NULL);
    CREATE TABLE activity (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      action TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO rooms VALUES ('legacyroom000001','Old',1,1,1,x'');
    INSERT INTO activity VALUES ('a1','legacyroom000001','file.renamed','notes.md',5);`);
  old.close();
  const db = openDatabase(path);
  const columns = db.prepare("PRAGMA table_info(activity)").all().map((c) => c.name);
  assert.deepEqual(columns, ["id", "workspace_id", "action", "label", "created_at", "actor_id", "actor_name", "actor_kind"]);
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM activity WHERE id='a1'").get() },
    { id: "a1", workspace_id: "legacyroom000001", action: "file.renamed", label: "notes.md", created_at: 5, actor_id: null, actor_name: null, actor_kind: null },
  );
  // Rollback safety: the previous release's insert (explicit column list) still works.
  db.prepare("INSERT INTO activity(id,workspace_id,action,label,created_at) VALUES (?,?,?,?,?)").run(
    "a2",
    "legacyroom000001",
    "file.created",
    "old.md",
    6,
  );
  db.close();
  // Re-running the migration is a no-op.
  openDatabase(path).close();
});
