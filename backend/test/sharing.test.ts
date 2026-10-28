import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { signUp } from "./helpers.js";

const origin = "http://localhost:5173";
async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("owners share workspaces with registered users as Viewer or Editor; anonymous links are unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-share-")),
    dbPath = join(dir, "db.sqlite");
  let app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  const listen = async () => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  let base = await listen();
  const providers: WebsocketProvider[] = [];
  const connect = (room: string, headers: Record<string, string> = {}) => {
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
    providers.push(provider);
    return provider;
  };
  const text = (p: WebsocketProvider) => {
    const docs = p.doc.getMap<Y.Map<unknown>>("documents");
    return docs.get([...docs.keys()][0])!.get("content") as Y.Text;
  };
  const closeCode = (p: WebsocketProvider) =>
    new Promise<number>((resolve) =>
      p.ws!.addEventListener("close", (event) => resolve((event as CloseEvent).code)),
    );
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const owner = await signUp(base, origin, "Olivia Owner");
    const vera = await signUp(base, origin, "Vera Viewer");
    const ed = await signUp(base, origin, "Ed Editor");
    const outsider = await signUp(base, origin, "Oscar Outsider");
    const created = await call("/rooms", "POST", { name: "Shared course", language: "shell" }, owner.headers);
    const { id } = (await created.json()) as { id: string };
    const info = async (headers: Record<string, string> = {}) =>
      (await (await call("/rooms/" + id, "GET", undefined, headers)).json()) as Record<string, unknown>;
    const shared = async (headers: Record<string, string>) =>
      ((await (await call("/me/shared", "GET", undefined, headers)).json()) as {
        workspaces: Array<Record<string, unknown>>;
      }).workspaces;

    // Anonymous viewer link: no account, no invitation.
    assert.equal((await info()).access, "viewer");
    assert.equal((await call(`/rooms/${id}/tree`)).status, 200);
    assert.equal((await call("/me/shared")).status, 401);
    assert.deepEqual(await shared(vera.headers), []);

    // Students and outsiders never manage sharing or the Edit Link.
    for (const headers of [{}, vera.headers, outsider.headers]) {
      assert.equal((await call(`/rooms/${id}/shares`, "GET", undefined, headers)).status, 403);
      assert.equal(
        (await call(`/rooms/${id}/shares`, "POST", { email: outsider.email, role: "editor" }, headers)).status,
        403,
      );
      assert.equal((await call(`/rooms/${id}/editor-link`, "POST", {}, headers)).status, 403);
      assert.equal((await info(headers)).canShare, false);
    }
    // Recipients must already be registered; no pending invitations are created.
    const unknown = await call(`/rooms/${id}/shares`, "POST", { email: "nobody@example.test" }, owner.headers);
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { error: string }).error, /No Kodelumi account/);
    assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: owner.email }, owner.headers)).status, 400);
    assert.equal(
      (await call(`/rooms/${id}/shares`, "POST", { email: vera.email, role: "admin" }, owner.headers)).status,
      400,
    );
    assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: "not-an-email" }, owner.headers)).status, 400);

    // Share by email (case-insensitive), as Viewer and as Editor.
    const v = await call(`/rooms/${id}/shares`, "POST", { email: vera.email.toUpperCase(), role: "viewer" }, owner.headers);
    assert.equal(v.status, 201);
    assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: ed.email, role: "editor" }, owner.headers)).status, 201);
    const list = ((await (await call(`/rooms/${id}/shares`, "GET", undefined, owner.headers)).json()) as {
      shares: Array<{ userId: string; role: string; displayName: string }>;
    }).shares;
    assert.deepEqual(
      list.map((s) => [s.displayName, s.role]),
      [
        ["Vera Viewer", "viewer"],
        ["Ed Editor", "editor"],
      ],
    );

    // Shared with Me lists it for the recipients only, without credentials.
    const veraList = await shared(vera.headers);
    assert.deepEqual(
      veraList.map((w) => [w.id, w.role, w.ownerName, w.name]),
      [[id, "viewer", "Olivia Owner", "Shared course"]],
    );
    assert.ok(!/token|hash|email/i.test(JSON.stringify(veraList)));
    assert.equal((await shared(ed.headers))[0].role, "editor");
    assert.deepEqual(await shared(outsider.headers), []);
    // Sharing never moves the workspace into the recipient's own list.
    assert.deepEqual(
      ((await (await call("/me/workspaces", "GET", undefined, ed.headers)).json()) as { workspaces: unknown[] }).workspaces,
      [],
    );

    // Viewer share: read-only exactly like an anonymous viewer.
    assert.equal((await info(vera.headers)).access, "viewer");
    assert.equal((await info(vera.headers)).sharedRole, "viewer");
    assert.equal(
      (await call(`/rooms/${id}/documents`, "POST", { filename: "x.sh", language: "shell" }, vera.headers)).status,
      403,
    );
    // Editor share: edits content and manages sharing (tested below), but cannot rename or
    // delete the workspace.
    assert.equal((await info(ed.headers)).access, "editor");
    assert.equal((await info(ed.headers)).canShare, true);
    assert.equal(
      (await call(`/rooms/${id}/documents`, "POST", { filename: "notes.md", language: "markdown" }, ed.headers)).status,
      201,
    );
    for (const [path, method, body] of [
      [`/rooms/${id}`, "PATCH", { name: "Taken" }],
      [`/rooms/${id}`, "DELETE", undefined],
    ] as const)
      assert.equal((await call(path, method, body, ed.headers)).status, 403, `${method} ${path}`);
    assert.equal((await call(`/rooms/${id}/summary`, "GET", undefined, ed.headers)).status, 404);

    // Live Yjs: the editor share writes; the viewer share and anonymous students only watch.
    const ownerDoc = connect(id, { cookie: owner.cookie });
    const editorDoc = connect(id, { cookie: ed.cookie });
    const student = connect(id);
    await until(() => ownerDoc.synced && editorDoc.synced && student.synced);
    text(editorDoc).insert(0, "kubectl apply\n");
    await until(() => text(student).toString().startsWith("kubectl apply"));
    const viewerDoc = connect(id, { cookie: vera.cookie });
    await until(() => viewerDoc.synced);
    const viewerClosed = closeCode(viewerDoc);
    viewerDoc.shouldConnect = false;
    text(viewerDoc).insert(0, "rm -rf /\n");
    assert.equal(await viewerClosed, 1008);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!text(ownerDoc).toString().includes("rm -rf"));

    // Downgrading the editor disconnects their live socket and removes write access.
    const editorClosed = closeCode(editorDoc);
    editorDoc.shouldConnect = false;
    const edId = list[1].userId;
    const changed = await call(`/rooms/${id}/shares/${edId}`, "PATCH", { role: "viewer" }, owner.headers);
    assert.equal(changed.status, 200);
    assert.equal(await editorClosed, 1008);
    assert.equal((await info(ed.headers)).access, "viewer");
    assert.equal(
      (await call(`/rooms/${id}/documents`, "POST", { filename: "y.sh", language: "shell" }, ed.headers)).status,
      403,
    );
    assert.equal((await call(`/rooms/${id}/shares/${edId}`, "PATCH", { role: "owner" }, owner.headers)).status, 400);
    // Revoking removes it from Shared with Me; the public link still works for them.
    assert.equal((await call(`/rooms/${id}/shares/${edId}`, "DELETE", undefined, owner.headers)).status, 200);
    assert.deepEqual(await shared(ed.headers), []);
    assert.equal((await info(ed.headers)).access, "viewer");
    assert.equal((await info(ed.headers)).sharedRole, undefined);
    // Recipients can remove a workspace from their own list.
    assert.equal((await call(`/me/shared/${id}`, "DELETE", undefined, vera.headers)).status, 200);
    assert.deepEqual(await shared(vera.headers), []);
    assert.equal((await info()).access, "viewer");

    // Shares survive restarts and are removed with the workspace.
    await call(`/rooms/${id}/shares`, "POST", { email: vera.email, role: "editor" }, owner.headers);
    for (const p of providers.splice(0)) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
    base = await listen();
    assert.equal((await info(vera.headers)).access, "editor");
    assert.equal((await call(`/rooms/${id}`, "DELETE", undefined, owner.headers)).status, 200);
    assert.deepEqual(await shared(vera.headers), []);
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("signed-in editors manage the Edit Link and sharing like the owner; the owner stays protected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-share-editors-")),
    dbPath = join(dir, "db.sqlite");
  const app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const status = async (...args: Parameters<typeof call>) => (await call(...args)).status;
  try {
    const owner = await signUp(base, origin, "Olivia Owner");
    const ed = await signUp(base, origin, "Ed Editor");
    const eve = await signUp(base, origin, "Eve Editor");
    const vera = await signUp(base, origin, "Vera Viewer");
    const outsider = await signUp(base, origin, "Oscar Outsider");
    const { id } = (await (await call("/rooms", "POST", { name: "Team course", language: "shell" }, owner.headers)).json()) as {
      id: string;
    };
    const info = async (headers: Record<string, string> = {}) =>
      (await (await call("/rooms/" + id, "GET", undefined, headers)).json()) as Record<string, unknown>;
    const shares = async (headers: Record<string, string>) =>
      ((await (await call(`/rooms/${id}/shares`, "GET", undefined, headers)).json()) as {
        shares: Array<{ userId: string; displayName: string; role: string }>;
      }).shares.map((s) => [s.displayName, s.role]);
    const storedHash = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return db.prepare("SELECT editor_token_hash AS h FROM rooms WHERE id=?").get(id)?.h;
      } finally {
        db.close();
      }
    };
    assert.equal(await status(`/rooms/${id}/shares`, "POST", { email: ed.email, role: "editor" }, owner.headers), 201);
    assert.equal(await status(`/rooms/${id}/shares`, "POST", { email: vera.email, role: "viewer" }, owner.headers), 201);

    // Owner and editor share see sharing; students, viewer shares and outsiders don't.
    assert.deepEqual([(await info(owner.headers)).canShare, (await info(owner.headers)).hasEditorLink], [true, false]);
    assert.deepEqual([(await info(ed.headers)).canShare, (await info(ed.headers)).hasEditorLink], [true, false]);
    for (const headers of [{}, vera.headers, outsider.headers]) {
      const room = await info(headers);
      assert.equal(room.canShare, false);
      assert.ok(!("hasEditorLink" in room));
    }

    // The editor creates, replaces and revokes the Edit Link; each token is returned once.
    const first = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, ed.headers)).json()) as { token: string };
    assert.equal((await info(owner.headers)).hasEditorLink, true);
    const guest = { authorization: "Bearer " + first.token };
    assert.equal((await info(guest)).access, "editor");
    // Edit Link guests edit, but never manage sharing or the link.
    assert.equal((await info(guest)).canShare, false);
    for (const [path, method, body] of [
      [`/rooms/${id}/editor-link`, "POST", {}],
      [`/rooms/${id}/editor-link`, "DELETE", undefined],
      [`/rooms/${id}/shares`, "GET", undefined],
      [`/rooms/${id}/shares`, "POST", { email: outsider.email, role: "editor" }],
    ] as const)
      assert.equal(await status(path, method, body, guest), 403, `guest ${method} ${path}`);
    const second = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, ed.headers)).json()) as { token: string };
    assert.notEqual(second.token, first.token);
    assert.equal(await status("/rooms/" + id, "GET", undefined, guest), 403);
    assert.equal(await status(`/rooms/${id}/editor-link`, "DELETE", undefined, ed.headers), 200);
    assert.equal((await info(ed.headers)).hasEditorLink, false);
    assert.equal(await status("/rooms/" + id, "GET", undefined, { authorization: "Bearer " + second.token }), 403);
    const kept = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, ed.headers)).json()) as { token: string };
    // Never exposed afterwards: not in workspace info, shares or Shared with Me.
    for (const body of [
      await info(ed.headers),
      await info(owner.headers),
      await shares(ed.headers),
      await (await call("/me/shared", "GET", undefined, ed.headers)).json(),
    ]) {
      assert.ok(!JSON.stringify(body).includes(kept.token));
      assert.ok(!JSON.stringify(body).includes(String(storedHash())));
    }

    // The editor invites, downgrades, upgrades and removes other people.
    assert.equal(await status(`/rooms/${id}/shares`, "POST", { email: eve.email, role: "editor" }, ed.headers), 201);
    const eveId = eve.user.id;
    assert.equal(await status(`/rooms/${id}/shares/${eveId}`, "PATCH", { role: "viewer" }, ed.headers), 200);
    assert.equal((await info(eve.headers)).canShare, false);
    assert.equal(await status(`/rooms/${id}/shares/${eveId}`, "PATCH", { role: "editor" }, ed.headers), 200);
    assert.equal(await status(`/rooms/${id}/shares/${vera.user.id}`, "DELETE", undefined, ed.headers), 200);
    assert.deepEqual(await shares(owner.headers), [
      ["Ed Editor", "editor"],
      ["Eve Editor", "editor"],
    ]);

    // The owner can't be added, downgraded or removed through sharing.
    const ownerId = owner.user.id;
    assert.equal(await status(`/rooms/${id}/shares`, "POST", { email: owner.email, role: "viewer" }, ed.headers), 400);
    assert.equal(await status(`/rooms/${id}/shares/${ownerId}`, "PATCH", { role: "viewer" }, ed.headers), 403);
    assert.equal(await status(`/rooms/${id}/shares/${ownerId}`, "DELETE", undefined, ed.headers), 403);
    assert.equal(await status(`/rooms/${id}/shares/${ownerId}`, "DELETE", undefined, owner.headers), 403);
    assert.equal((await info(owner.headers)).access, "owner");
    assert.equal((await info(owner.headers)).canShare, true);
    // Rename and delete stay owner-only.
    assert.equal(await status(`/rooms/${id}`, "PATCH", { name: "Taken" }, ed.headers), 403);
    assert.equal(await status(`/rooms/${id}`, "DELETE", undefined, ed.headers), 403);

    // Viewers, students and outsiders still can't touch sharing or the link.
    for (const headers of [{}, vera.headers, outsider.headers])
      for (const [path, method, body] of [
        [`/rooms/${id}/editor-link`, "POST", {}],
        [`/rooms/${id}/editor-link`, "DELETE", undefined],
        [`/rooms/${id}/shares`, "GET", undefined],
        [`/rooms/${id}/shares/${eveId}`, "PATCH", { role: "viewer" }],
        [`/rooms/${id}/shares/${eveId}`, "DELETE", undefined],
      ] as const)
        assert.equal(await status(path, method, body, headers), 403, `${method} ${path}`);

    // An editor can downgrade or remove themselves; the next request is refused.
    assert.equal(await status(`/rooms/${id}/shares/${eveId}`, "PATCH", { role: "viewer" }, eve.headers), 200);
    assert.equal(await status(`/rooms/${id}/shares`, "GET", undefined, eve.headers), 403);
    assert.equal(await status(`/rooms/${id}/shares`, "POST", { email: eve.email, role: "editor" }, eve.headers), 403);
    assert.equal(await status(`/rooms/${id}/shares/${eveId}`, "PATCH", { role: "editor" }, owner.headers), 200);
    assert.equal(await status(`/rooms/${id}/shares/${eveId}`, "DELETE", undefined, eve.headers), 200);
    assert.deepEqual([(await info(eve.headers)).access, (await info(eve.headers)).canShare], ["viewer", false]);
    assert.equal(await status(`/rooms/${id}/editor-link`, "POST", {}, eve.headers), 403);

    // Removing the editor who created the Edit Link leaves the link working, and the
    // removed editor can make no further sharing changes.
    const hash = storedHash();
    assert.equal(await status(`/rooms/${id}/shares/${ed.user.id}`, "DELETE", undefined, owner.headers), 200);
    for (const [path, method, body] of [
      [`/rooms/${id}/editor-link`, "POST", {}],
      [`/rooms/${id}/editor-link`, "DELETE", undefined],
      [`/rooms/${id}/shares`, "GET", undefined],
      [`/rooms/${id}/shares`, "POST", { email: ed.email, role: "editor" }],
      [`/rooms/${id}/shares/${eveId}`, "DELETE", undefined],
    ] as const)
      assert.equal(await status(path, method, body, ed.headers), 403, `removed editor ${method} ${path}`);
    assert.equal(storedHash(), hash);
    assert.equal((await info({ authorization: "Bearer " + kept.token })).access, "editor");
    assert.equal((await info(owner.headers)).hasEditorLink, true);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("adding sharing to an existing database preserves workspaces, owners and links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-share-migrate-")),
    dbPath = join(dir, "db.sqlite");
  let app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  const listen = async () => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  let base = await listen();
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const owner = await signUp(base, origin, "Legacy Owner");
    const { id } = (await (await call("/rooms", "POST", { name: "Before sharing", template: "terraform" }, owner.headers)).json()) as { id: string };
    const { token } = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as { token: string };
    const tree = await (await call(`/rooms/${id}/tree`)).text();
    await app.close();
    // Simulate the production schema from before this release.
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE workspace_shares");
    const before = raw.prepare("SELECT id,name,owner_id,editor_token_hash FROM rooms").all();
    raw.close();

    app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
    base = await listen();
    const check = new DatabaseSync(dbPath);
    assert.deepEqual(check.prepare("SELECT id,name,owner_id,editor_token_hash FROM rooms").all(), before);
    assert.equal(Number(check.prepare("SELECT COUNT(*) AS n FROM workspace_shares").get()?.n), 0);
    check.close();
    assert.equal(await (await call(`/rooms/${id}/tree`)).text(), tree);
    assert.equal(
      ((await (await call(`/rooms/${id}`, "GET", undefined, { authorization: "Bearer " + token })).json()) as { access: string }).access,
      "editor",
    );
    assert.equal(
      ((await (await call(`/rooms/${id}`, "GET", undefined, owner.headers)).json()) as { access: string }).access,
      "owner",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
