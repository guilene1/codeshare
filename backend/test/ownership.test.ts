import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { createBlock } from "../src/blocks.js";
import { PASSWORD, signUp } from "./helpers.js";

const origin = "http://localhost:5173";
async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("workspaces are owned: other users and anonymous viewers are read-only over REST and Yjs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-owner-")),
    dbPath = join(dir, "db.sqlite");
  let app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  const listen = async () => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  let base = await listen();
  const providers: WebsocketProvider[] = [];
  const connect = (room: string, headers: Record<string, string> = {}, protocols = ["devshare"]) => {
    class Socket extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers });
      }
    }
    const provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", room, new Y.Doc(), {
      WebSocketPolyfill: Socket as never,
      disableBc: true,
      protocols,
    });
    providers.push(provider);
    return provider;
  };
  const text = (p: WebsocketProvider) => {
    const docs = p.doc.getMap<Y.Map<unknown>>("documents");
    return docs.get([...docs.keys()][0])!.get("content") as Y.Text;
  };
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    // Creating a workspace requires an account.
    assert.equal((await call("/rooms", "POST", { name: "Anonymous" })).status, 401);
    const alice = await signUp(base, origin, "Alice Instructor");
    const bob = await signUp(base, origin, "Bob Other");
    const created = await call("/rooms", "POST", { name: "Alice course", language: "shell" }, alice.headers);
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const info = async (headers: Record<string, string> = {}) =>
      (await (await call("/rooms/" + id, "GET", undefined, headers)).json()) as Record<string, unknown>;
    assert.equal((await info(alice.headers)).access, "owner");
    assert.equal((await info(bob.headers)).access, "viewer");
    assert.equal((await info()).access, "viewer");
    assert.equal((await info()).hasEditorLink, undefined);
    // Dashboards list only the caller's own workspaces and never credentials.
    const mine = await (await call("/me/workspaces", "GET", undefined, alice.headers)).text();
    assert.ok(mine.includes(id));
    assert.ok(!/token|hash/i.test(mine.replace(/hasEditorLink/g, "")));
    assert.deepEqual(
      ((await (await call("/me/workspaces", "GET", undefined, bob.headers)).json()) as { workspaces: unknown[] }).workspaces,
      [],
    );
    assert.equal((await call("/me/workspaces")).status, 401);
    // Another signed-in user cannot change, delete, claim or inspect it.
    for (const [path, method, body] of [
      [`/rooms/${id}`, "PATCH", { name: "Taken" }],
      [`/rooms/${id}`, "DELETE", undefined],
      [`/rooms/${id}/documents`, "POST", { filename: "x.sh", language: "shell" }],
      [`/rooms/${id}/folders`, "POST", { name: "Lesson" }],
      [`/rooms/${id}/claim`, "POST", {}],
      [`/rooms/${id}/editor-link`, "POST", {}],
      [`/rooms/${id}/migrate-snippets`, "POST", {}],
    ] as const)
      assert.equal((await call(path, method, body, bob.headers)).status, 403, `${method} ${path}`);
    assert.equal((await call(`/rooms/${id}/summary`, "GET", undefined, bob.headers)).status, 404);
    assert.equal((await call(`/rooms/${id}/summary`, "GET", undefined, alice.headers)).status, 200);
    // Anonymous Student Link: readable immediately, no credential.
    assert.equal((await call(`/rooms/${id}/tree`)).status, 200);

    // Live Yjs: the owner edits through the session cookie; others only watch.
    const owner = connect(id, { cookie: alice.cookie });
    const student = connect(id);
    const signedInViewer = connect(id, { cookie: bob.cookie });
    await until(() => owner.synced && student.synced && signedInViewer.synced);
    text(owner).insert(0, "terraform init\n");
    await until(() => text(student).toString().startsWith("terraform init"));
    await until(() => text(signedInViewer).toString().startsWith("terraform init"));
    const closed = new Promise<number>((resolve) =>
      signedInViewer.ws!.addEventListener("close", (event) => resolve((event as CloseEvent).code)),
    );
    signedInViewer.shouldConnect = false;
    text(signedInViewer).insert(0, "rm -rf /\n");
    assert.equal(await closed, 1008);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!text(owner).toString().includes("rm -rf"));
    assert.ok(!app.rooms.get(id)!.doc.getMap<Y.Map<unknown>>("documents").toJSON().toString().includes("rm -rf"));
    // Presence uses the verified account name, not the browser-supplied one.
    owner.awareness.setLocalStateField("user", { name: "Spoofed", color: "#a78bfa" });
    await until(() =>
      [...student.awareness.getStates().values()].some((s) => s.user?.name === "Alice Instructor"),
    );

    // Private co-editor links: created by the owner, returned once, revocable.
    assert.equal((await call(`/rooms/${id}/editor-link`, "POST", {})).status, 403);
    const link = await call(`/rooms/${id}/editor-link`, "POST", {}, alice.headers);
    assert.equal(link.status, 201);
    const { token } = (await link.json()) as { token: string };
    const bearer = { authorization: "Bearer " + token };
    assert.equal((await info(bearer)).access, "editor");
    assert.equal((await info(alice.headers)).hasEditorLink, true);
    assert.equal((await call(`/rooms/${id}/documents`, "POST", { filename: "notes.md", language: "markdown" }, bearer)).status, 201);
    assert.equal((await call(`/rooms/${id}`, "PATCH", { name: "Renamed by link" }, bearer)).status, 403);
    assert.equal((await call(`/rooms/${id}`, "DELETE", undefined, bearer)).status, 403);
    const coEditor = connect(id, {}, ["devshare", "editor." + token]);
    coEditor.awareness.setLocalStateField("user", { name: "Co-teacher", color: "#38bdf8" });
    await until(() => coEditor.synced);
    const dropped = new Promise<number>((resolve) =>
      coEditor.ws!.addEventListener("close", (event) => resolve((event as CloseEvent).code)),
    );
    coEditor.shouldConnect = false;
    const replaced = await call(`/rooms/${id}/editor-link`, "POST", {}, alice.headers);
    assert.equal(await dropped, 1008);
    assert.equal((await call(`/rooms/${id}`, "GET", undefined, bearer)).status, 403);
    const second = ((await replaced.json()) as { token: string }).token;
    assert.equal((await call(`/rooms/${id}/editor-link`, "DELETE", undefined, alice.headers)).status, 200);
    assert.equal((await call(`/rooms/${id}`, "GET", undefined, { authorization: "Bearer " + second })).status, 403);

    // Signing out disconnects that session's live sockets.
    const ownerClosed = new Promise<number>((resolve) =>
      owner.ws!.addEventListener("close", (event) => resolve((event as CloseEvent).code)),
    );
    owner.shouldConnect = false;
    const relogin = await call("/auth/signin", "POST", { email: alice.email, password: PASSWORD });
    const fresh = {
      origin,
      cookie: relogin.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": ((await relogin.json()) as { csrfToken: string }).csrfToken,
    };
    await call("/auth/signout", "POST", {}, alice.headers);
    assert.equal(await ownerClosed, 1008);
    assert.equal((await info(alice.headers)).access, "viewer");
    assert.equal((await info(fresh)).access, "owner");

    // Sessions, ownership and content survive a restart.
    for (const p of providers.splice(0)) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
    base = await listen();
    assert.equal((await info(fresh)).access, "owner");
    const reloaded = connect(id);
    await until(() => reloaded.synced);
    assert.ok(text(reloaded).toString().startsWith("terraform init"));
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy workspaces keep their editor links and can be claimed exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-claim-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin] });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const token = randomBytes(32).toString("base64url");
    const legacy = app.rooms.create(
      "v1 course",
      "hcl",
      createHash("sha256").update(token).digest("hex"),
    );
    const bearer = { authorization: "Bearer " + token };
    const room = await (await call("/rooms/" + legacy.workspaceId, "GET", undefined, bearer)).json();
    assert.deepEqual([room.access, room.owned, room.claimable], ["editor", false, true]);
    // v1 behaviour is preserved for unclaimed workspaces.
    assert.equal((await call("/rooms/" + legacy.workspaceId, "PATCH", { name: "Still v1" }, bearer)).status, 200);
    assert.equal((await call("/rooms/" + legacy.workspaceId + "/claim", "POST", {}, bearer)).status, 401);
    const carol = await signUp(base, origin, "Carol Claimer");
    const dave = await signUp(base, origin, "Dave Late");
    assert.equal((await call("/rooms/" + legacy.workspaceId + "/claim", "POST", {}, carol.headers)).status, 403);
    assert.equal(
      (await call("/rooms/" + legacy.workspaceId + "/claim", "POST", {}, { ...carol.headers, ...bearer })).status,
      200,
    );
    assert.equal(
      (await call("/rooms/" + legacy.workspaceId + "/claim", "POST", {}, { ...dave.headers, ...bearer })).status,
      409,
    );
    assert.equal((await (await call("/rooms/" + legacy.workspaceId, "GET", undefined, carol.headers)).json()).access, "owner");
    // The original editor link keeps working for content after the claim…
    assert.equal(
      (await call(`/rooms/${legacy.workspaceId}/documents`, "POST", { filename: "after.tf", language: "hcl" }, bearer)).status,
      201,
    );
    // …but workspace management now belongs to the owner.
    assert.equal((await call("/rooms/" + legacy.workspaceId, "DELETE", undefined, bearer)).status, 403);
    const listed = (await (await call("/me/workspaces", "GET", undefined, carol.headers)).json()) as {
      workspaces: Array<{ id: string; hasEditorLink: boolean }>;
    };
    assert.deepEqual(listed.workspaces.map((w) => [w.id, w.hasEditorLink]), [[legacy.workspaceId, true]]);
    assert.equal((await call("/rooms/" + legacy.workspaceId, "DELETE", undefined, carol.headers)).status, 200);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone snippets migrate into a Markdown lesson only on request, without losing originals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-migrate-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin] });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const token = randomBytes(32).toString("base64url");
    const legacy = app.rooms.create("Snippets", "hcl", createHash("sha256").update(token).digest("hex"));
    createBlock(legacy, { title: "Initialize", language: "shell", content: "terraform init" });
    createBlock(legacy, { title: "Fence inside", language: "markdown", content: "```bash\nls\n```" });
    createBlock(legacy, { title: "", language: "hcl", content: 'provider "aws" {}\n' });
    app.rooms.save(legacy);
    const before = Y.encodeStateAsUpdate(legacy.doc).byteLength;
    assert.ok(before > 0);
    // Nothing migrates by itself.
    assert.equal(legacy.doc.getMap("documents").size, 1);
    assert.equal(
      (await call(`/rooms/${legacy.workspaceId}/migrate-snippets`, "POST", {})).status,
      403,
    );
    const bearer = { authorization: "Bearer " + token };
    const result = await (await call(`/rooms/${legacy.workspaceId}/migrate-snippets`, "POST", {}, bearer)).json();
    assert.equal(result.migrated, 3);
    const docs = [...legacy.doc.getMap<Y.Map<unknown>>("documents").values()];
    const lesson = docs.find((d) => d.get("filename") === "code-blocks.md")!;
    assert.equal(lesson.get("language"), "markdown");
    const markdown = (lesson.get("content") as Y.Text).toString();
    assert.ok(markdown.indexOf("## Initialize") < markdown.indexOf("## Fence inside"));
    assert.ok(markdown.includes("```shell\nterraform init\n```"));
    // Code containing a fence gets a longer fence so it stays one block.
    assert.ok(markdown.includes("````markdown\n```bash\nls\n```\n````"));
    assert.ok(markdown.includes('```hcl\nprovider "aws" {}\n```'));
    // Originals are retained (hidden) for rollback, and the migration is idempotent.
    assert.equal(legacy.doc.getMap("codeBlocks").size, 3);
    assert.equal(
      Number(app.rooms.db.prepare("SELECT COUNT(*) AS n FROM code_blocks").get()!.n),
      3,
    );
    const again = await (await call(`/rooms/${legacy.workspaceId}/migrate-snippets`, "POST", {}, bearer)).json();
    assert.equal(again.migrated, 0);
    assert.equal(
      [...legacy.doc.getMap<Y.Map<unknown>>("documents").values()].filter((d) =>
        String(d.get("filename")).startsWith("code-blocks"),
      ).length,
      1,
    );
    // Persisted to SQLite.
    const row = app.rooms.db
      .prepare("SELECT content FROM documents WHERE filename='code-blocks.md'")
      .get() as { content: string };
    assert.equal(row.content, markdown);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
