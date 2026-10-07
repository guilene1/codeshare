import { test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";

async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout)
      throw new Error("Timed out waiting for synchronization");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const origin = "http://localhost:5173";
const editorToken = randomBytes(32).toString("base64url"),
  editorTokenHash = createHash("sha256").update(editorToken).digest("hex");
class Socket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { origin });
  }
}
test("real clients converge, presence clears, metadata syncs, reconnect and SQLite restart preserve CRDT state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-test-")),
    dbPath = join(dir, "rooms.sqlite");
  let app = createApp({ dbPath, checkpointMs: 30, origins: [origin] });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  let port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const clients: WebsocketProvider[] = [];
  const request = async (path: string, method = "GET", body?: unknown) =>
    fetch(base + "/api" + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin,
        Authorization: "Bearer " + editorToken,
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(
              path === "/rooms"
                ? { ...(body as Record<string, unknown>), editorTokenHash }
                : body,
            ),
    });
  const client = (id: string, name: string) => {
    const doc = new Y.Doc(),
      p = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, doc, {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        connect: false,
        protocols: ["devshare", "editor." + editorToken],
      });
    p.awareness.setLocalStateField("user", {
      name,
      color: name === "Alex" ? "#a78bfa" : "#38bdf8",
    });
    clients.push(p);
    p.connect();
    return p;
  };
  try {
    const create = await request("/rooms", "POST", {
      name: "Terraform class",
      language: "hcl",
    });
    assert.equal(create.status, 201);
    const room = (await create.json()) as { id: string };
    assert.match(room.id, /^[\w-]{16}$/);
    const a = client(room.id, "Alex"),
      b = client(room.id, "Sam");
    await until(() => a.synced && b.synced);
    const files = a.doc.getMap<Y.Map<unknown>>("documents"),
      id = [...files.keys()][0];
    const ta = files.get(id)!.get("content") as Y.Text,
      tb = b.doc
        .getMap<Y.Map<unknown>>("documents")
        .get(id)!
        .get("content") as Y.Text;
    a.doc.transact(() => ta.insert(0, "# Alex\n"));
    b.doc.transact(() => tb.insert(0, "# Sam\n"));
    await until(
      () =>
        ta.toString() === tb.toString() &&
        ta.toString().includes("# Alex") &&
        ta.toString().includes("# Sam"),
    );
    await until(
      () =>
        a.awareness.getStates().size === 2 &&
        b.awareness.getStates().size === 2,
    );
    const before = ta.toString();
    assert.equal(
      (
        await request(`/rooms/${room.id}/documents/${id}`, "PATCH", {
          language: "python",
        })
      ).status,
      200,
    );
    await until(
      () =>
        b.doc.getMap<Y.Map<unknown>>("documents").get(id)!.get("language") ===
        "python",
    );
    assert.equal(tb.toString(), before);
    for (const filename of ["variables.tf", "outputs.tf", "notes.md"])
      assert.equal(
        (
          await request(`/rooms/${room.id}/documents`, "POST", {
            filename,
            language: filename.endsWith(".md") ? "markdown" : "hcl",
          })
        ).status,
        201,
      );
    await until(() => b.doc.getMap("documents").size === 4);
    const note = [...files.values()].find(
      (d) => d.get("filename") === "notes.md",
    )!;
    const noteId = note.get("id") as string;
    assert.equal(
      (
        await request(`/rooms/${room.id}/documents/${noteId}`, "PATCH", {
          filename: "lesson.md",
        })
      ).status,
      200,
    );
    await until(() => note.get("filename") === "lesson.md");
    assert.equal(
      (await request(`/rooms/${room.id}/documents/${noteId}`, "DELETE")).status,
      200,
    );
    await until(() => files.size === 3);
    b.disconnect();
    await until(() => a.awareness.getStates().size === 1);
    tb.insert(0, "# Offline edit\n");
    b.connect();
    await until(
      () =>
        a.synced &&
        b.synced &&
        ta.toString() === tb.toString() &&
        ta.toString().includes("Offline edit"),
    );
    const durable = ta.toString();
    await request(`/rooms/${room.id}/checkpoint`, "POST");
    a.destroy();
    b.destroy();
    await new Promise((r) => setTimeout(r, 60));
    await app.close();
    app = createApp({ dbPath, checkpointMs: 30, origins: [origin] });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    port = (app.server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    const fresh = client(room.id, "Alex");
    await until(() => fresh.synced);
    const restored = fresh.doc.getMap<Y.Map<unknown>>("documents").get(id)!;
    assert.equal((restored.get("content") as Y.Text).toString(), durable);
    assert.equal(restored.get("language"), "python");
    assert.equal(fresh.doc.getMap("documents").size, 3);
    assert.equal(
      app.rooms.db
        .prepare("SELECT count(*) AS n FROM documents WHERE room_id=?")
        .get(room.id)?.n,
      3,
    );
  } finally {
    for (const p of clients) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("validation, request limits, origin checks, malicious metadata rejection and active-room retention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-security-")),
    app = createApp({ dbPath: join(dir, "rooms.sqlite"), origins: [origin] });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const request = (path: string, body: unknown, source = origin) =>
    fetch(base + "/api" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: source,
        Authorization: "Bearer " + editorToken,
      },
      body: JSON.stringify(
        path === "/rooms"
          ? { ...(body as Record<string, unknown>), editorTokenHash }
          : body,
      ),
    });
  let p: WebsocketProvider | undefined;
  try {
    assert.equal(
      (await request("/rooms", { name: "x", language: "exe" })).status,
      400,
    );
    assert.equal(
      (await request("/rooms", { name: "x" }, "https://evil.example")).status,
      403,
    );
    assert.equal(
      (await request("/rooms", { name: "x".repeat(20000) })).status,
      413,
    );
    const room = (await (
      await request("/rooms", { name: "Test", language: "hcl" })
    ).json()) as { id: string };
    assert.equal(
      (
        await request(`/rooms/${room.id}/documents`, {
          filename: "../../etc/passwd",
          language: "plaintext",
        })
      ).status,
      400,
    );
    const rejected = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${room.id}`, {
        origin: "https://evil.example",
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
    assert.equal(rejected, 403);
    p = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      room.id,
      new Y.Doc(),
      {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        connect: false,
        protocols: ["devshare", "editor." + editorToken],
      },
    );
    p.awareness.setLocalStateField("user", {
      name: "Student",
      color: "#38bdf8",
    });
    p.connect();
    await until(() => p!.synced);
    app.rooms.db
      .prepare("UPDATE rooms SET last_activity=0 WHERE id=?")
      .run(room.id);
    app.rooms.collect();
    assert.ok(
      app.rooms.db.prepare("SELECT id FROM rooms WHERE id=?").get(room.id),
    );
    const closed = new Promise<number>((resolve) =>
      p!.on("connection-close", (e: { code: number } | null) => {
        if (e) {
          p!.shouldConnect = false;
          resolve(e.code);
        }
      }),
    );
    const file = [...p.doc.getMap<Y.Map<unknown>>("documents").values()][0];
    file.set("filename", "injected.tf");
    assert.equal(await closed, 1008);
    const serverFile = [
      ...app.rooms
        .get(room.id)!
        .doc.getMap<Y.Map<unknown>>("documents")
        .values(),
    ][0];
    assert.notEqual(serverFile.get("filename"), "injected.tf");
    app.rooms.release(app.rooms.get(room.id)!);
    app.rooms.db
      .prepare("UPDATE rooms SET last_activity=0 WHERE id=?")
      .run(room.id);
    app.rooms.collect();
    assert.ok(
      app.rooms.db.prepare("SELECT id FROM rooms WHERE id=?").get(room.id),
    );
    assert.equal(app.rooms.active.size, 0);
    assert.ok(app.rooms.get(room.id));
    const health = await fetch(base + "/api/health");
    assert.ok(health.headers.get("content-security-policy"));
    assert.equal(health.headers.get("x-powered-by"), null);
  } finally {
    p?.destroy();
    p?.doc.destroy();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
