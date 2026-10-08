import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";
import { createRoom } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const origin = "http://localhost:5173";
class Socket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { origin });
  }
}
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
test("server enforces editor capability across REST, Yjs writes, spoofed roles, reconnect and credential rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-access-")),
    app = createApp({
      dbPath: join(directory, "room.sqlite"),
      origins: [origin],
      checkpointMs: 30,
    });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("base64url"),
    hash = createHash("sha256").update(token).digest("hex"),
    clients: WebsocketProvider[] = [];
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    credential?: string,
  ) =>
    path === "/rooms" && method === "POST"
      ? createRoom(app, base, body as Record<string, unknown>, origin)
      : fetch(base + "/api" + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(credential ? { Authorization: "Bearer " + credential } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const client = (id: string, credential?: string) => {
    const p = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      id,
      new Y.Doc(),
      {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        connect: false,
        protocols: credential
          ? ["devshare", "editor." + credential]
          : ["devshare"],
      },
    );
    p.awareness.setLocalState({
      user: {
        name: credential ? "Instructor" : "Student",
        color: credential ? "#a78bfa" : "#38bdf8",
        role: "editor",
      },
      role: "editor",
    });
    clients.push(p);
    p.connect();
    return p;
  };
  try {
    const response = await request("/rooms", "POST", {
      name: "Class",
      language: "hcl",
      editorTokenHash: hash,
    });
    assert.equal(response.status, 201);
    const raw = await response.text();
    assert.ok(!raw.includes(token));
    assert.ok(!raw.includes(hash));
    const room = JSON.parse(raw) as { id: string };
    assert.equal(
      (
        (await (await request("/rooms/" + room.id)).json()) as {
          access: string;
        }
      ).access,
      "viewer",
    );
    assert.equal(
      (
        (await (
          await request("/rooms/" + room.id, "GET", undefined, token)
        ).json()) as { access: string }
      ).access,
      "editor",
    );
    assert.equal(
      (
        await request(
          "/rooms/" + room.id,
          "GET",
          undefined,
          randomBytes(32).toString("base64url"),
        )
      ).status,
      403,
    );
    assert.equal(
      app.rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(room.id)?.editor_token_hash,
      hash,
    );
    const owner = client(room.id, token),
      viewer = client(room.id);
    await until(() => owner.synced && viewer.synced);
    assert.equal(owner.ws?.protocol, "devshare");
    await until(() =>
      [...owner.awareness.getStates()].some(
        ([id, state]) => id === viewer.doc.clientID && state.role === "viewer",
      ),
    );
    assert.deepEqual(owner.awareness.getStates().get(viewer.doc.clientID), {
      viewer: true,
      role: "viewer",
    });
    viewer.awareness.setLocalState({ viewer: true });
    await until(
      () =>
        owner.awareness.getStates().get(viewer.doc.clientID)?.viewer === true,
    );
    const document = [
        ...owner.doc.getMap<Y.Map<unknown>>("documents").values(),
      ][0],
      id = document.get("id") as string,
      text = document.get("content") as Y.Text;
    const viewerText = viewer.doc
      .getMap<Y.Map<unknown>>("documents")
      .get(id)!
      .get("content") as Y.Text;
    text.insert(0, "# Instructor update\n");
    await until(() => viewerText.toString() === text.toString());
    for (const [path, method, body] of [
      [
        `/rooms/${room.id}/documents`,
        "POST",
        { filename: "fake.tf", language: "hcl", role: "editor" },
      ],
      [
        `/rooms/${room.id}/documents/${id}`,
        "PATCH",
        { filename: "fake.tf", language: "python" },
      ],
      [`/rooms/${room.id}/documents/${id}`, "DELETE", undefined],
      [`/rooms/${room.id}`, "PATCH", { name: "Fake" }],
      [`/rooms/${room.id}/checkpoint`, "POST", {}],
    ] as const)
      assert.equal((await request(path, method, body)).status, 403);
    const closed = new Promise<number>((resolve) =>
      viewer.on("connection-close", (event: { code: number } | null) => {
        if (event) {
          viewer.shouldConnect = false;
          resolve(event.code);
        }
      }),
    );
    viewerText.insert(0, "# Unauthorized edit\n");
    assert.equal(await closed, 1008);
    assert.ok(!text.toString().includes("Unauthorized edit"));
    const deleting = client(room.id);
    await until(() => deleting.synced);
    const rejected = new Promise<number>((resolve) =>
      deleting.on("connection-close", (event: { code: number } | null) => {
        if (event) {
          deleting.shouldConnect = false;
          resolve(event.code);
        }
      }),
    );
    (
      deleting.doc
        .getMap<Y.Map<unknown>>("documents")
        .get(id)!
        .get("content") as Y.Text
    ).delete(0, 5);
    assert.equal(await rejected, 1008);
    assert.ok(text.toString().startsWith("# Instructor update"));
    const reconnect = client(room.id);
    await until(() => reconnect.synced);
    reconnect.disconnect();
    text.insert(0, "# While disconnected\n");
    reconnect.connect();
    await until(
      () =>
        reconnect.synced &&
        (
          reconnect.doc
            .getMap<Y.Map<unknown>>("documents")
            .get(id)!
            .get("content") as Y.Text
        ).toString() === text.toString(),
    );
    assert.equal(
      (
        await request(
          "/rooms/" + room.id,
          "PATCH",
          { name: "Updated class" },
          token,
        )
      ).status,
      200,
    );
    await until(
      () => reconnect.doc.getMap("workspace").get("name") === "Updated class",
    );
    const dump = JSON.stringify(
      app.rooms.db.prepare("SELECT * FROM rooms WHERE id=?").get(room.id),
    );
    assert.ok(!dump.includes(token));
    assert.ok(!JSON.stringify(owner.doc.toJSON()).includes(hash));
    const revoked = new Promise<number>((resolve) =>
      owner.on("connection-close", (event: { code: number } | null) => {
        if (event) {
          owner.shouldConnect = false;
          resolve(event.code);
        }
      }),
    );
    app.rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=? WHERE id=?")
      .run(createHash("sha256").update("replacement").digest("hex"), room.id);
    text.insert(0, "# Revoked edit\n");
    assert.equal(await revoked, 1008);
    assert.ok(
      !(
        app.rooms
          .get(room.id)!
          .doc.getMap<Y.Map<unknown>>("documents")
          .get(id)!
          .get("content") as Y.Text
      )
        .toString()
        .includes("Revoked edit"),
    );
  } finally {
    for (const p of clients) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy SQLite migration preserves code and grants public links viewer access only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-legacy-")),
    path = join(directory, "legacy.sqlite"),
    old = new DatabaseSync(path),
    doc = new Y.Doc(),
    id = "legacyroomcode01";
  const documents = doc.getMap<Y.Map<unknown>>("documents"),
    file = new Y.Map<unknown>();
  file.set("id", "legacy-file");
  file.set("filename", "notes.md");
  file.set("language", "markdown");
  file.set("content", new Y.Text("Original lesson"));
  file.set("createdAt", 1);
  file.set("updatedAt", 1);
  documents.set("legacy-file", file);
  old.exec(
    "CREATE TABLE rooms(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER,updated_at INTEGER,last_activity INTEGER,state BLOB)",
  );
  old
    .prepare("INSERT INTO rooms VALUES(?,?,?,?,?,?)")
    .run(id, "Old classroom", 1, 1, Date.now(), Y.encodeStateAsUpdate(doc));
  old.close();
  doc.destroy();
  const app = createApp({ dbPath: path });
  try {
    assert.equal(
      app.rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(id)?.editor_token_hash,
      null,
    );
    assert.equal(
      app.rooms.canEditHash(id, createHash("sha256").update(id).digest("hex")),
      false,
    );
    assert.equal(
      (
        app.rooms
          .get(id)!
          .doc.getMap<Y.Map<unknown>>("documents")
          .get("legacy-file")!
          .get("content") as Y.Text
      ).toString(),
      "Original lesson",
    );
    const execute = promisify(execFile);
    const recover = (...args: string[]) =>
      execute(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../scripts/recover-editor.mjs", import.meta.url),
          ),
          id,
          "https://class.example",
          ...args,
        ],
        { env: { ...process.env, DB_PATH: path } },
      );
    const recovered = new URL((await recover()).stdout.trim());
    const token = recovered.pathname.split("/").at(-1)!;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      app.rooms.canEditHash(
        id,
        createHash("sha256").update(token).digest("hex"),
      ),
      true,
    );
    assert.ok(
      !JSON.stringify(
        app.rooms.db.prepare("SELECT * FROM rooms WHERE id=?").get(id),
      ).includes(token),
    );
    await assert.rejects(recover(), /already has editor access/);
    await recover("--rotate");
    assert.equal(
      app.rooms.canEditHash(
        id,
        createHash("sha256").update(token).digest("hex"),
      ),
      false,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
