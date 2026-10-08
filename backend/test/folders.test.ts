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

test("nested lessons load lazily, retain inactive course data, isolate sessions and authorize folder management", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-lessons-")),
    dbPath = join(dir, "course.sqlite"),
    origin = "http://localhost:5173";
  let app = createApp({ dbPath, origins: [origin] });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (app.server.address() as { port: number }).port;
  const token = randomBytes(32).toString("base64url"),
    hash = createHash("sha256").update(token).digest("hex");
  const request = (path: string, method = "GET", body?: unknown, edit = true) =>
    path === "/rooms" && method === "POST"
      ? createRoom(app, `http://127.0.0.1:${port}`, body as Record<string, unknown>, origin)
      : fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        origin,
        Connection: "close",
        "content-type": "application/json",
        ...(edit ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let student: WebsocketProvider | undefined;
  const until = async (check: () => boolean) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 5000) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    const workspace = (await (
      await request("/rooms", "POST", {
        name: "Six-month course",
        language: "hcl",
        editorTokenHash: hash,
      })
    ).json()) as { id: string };
    const path = "/rooms/" + workspace.id;
    app.rooms.release(app.rooms.get(workspace.id)!);
    const create = async (name: string, parent_id?: string) => {
      const response = await request(path + "/folders", "POST", {
        name,
        parent_id,
      });
      assert.equal(response.status, 201);
      return ((await response.json()) as { id: string }).id;
    };
    const week1 = await create("Week 01 - Linux"),
      week4 = await create("Week 04 - Terraform"),
      nested = await create("Examples", week4);
    await request(path);
    await request(path + "/tree");
    assert.equal(
      app.rooms.active.size,
      0,
      "Directory and access requests must not load lesson content",
    );
    for (const [method, suffix, body] of [
      ["POST", "/folders", { name: "Forbidden" }],
      ["PATCH", "/folders/" + week1, { name: "Attack" }],
      ["DELETE", "/folders/" + week1, undefined],
      ["PATCH", "/folders/order", { ids: [week4, week1] }],
      ["DELETE", "", undefined],
    ] as const)
      assert.equal(
        (await request(path + suffix, method, body, false)).status,
        403,
      );
    const file = (await (
      await request(path + "/documents?folder=" + week4, "POST", {
        filename: "main.tf",
        language: "hcl",
      })
    ).json()) as { id: string };
    assert.equal(app.rooms.active.size, 1);
    const lesson = app.rooms.get(workspace.id, week4)!;
    (
      lesson.doc
        .getMap<Y.Map<unknown>>("documents")
        .get(file.id)!
        .get("content") as Y.Text
    ).insert(0, "# Week 4 live marker");
    const oldFile = (await (
      await request(path + "/documents?folder=" + week1, "POST", {
        filename: "linux.sh",
        language: "shell",
      })
    ).json()) as { id: string };
    (
      app.rooms
        .get(workspace.id, week1)!
        .doc.getMap<Y.Map<unknown>>("documents")
        .get(oldFile.id)!
        .get("content") as Y.Text
    ).insert(0, "# Inactive week 1 secret marker");
    assert.equal(
      (
        await request(
          path + "/documents/" + oldFile.id + "?folder=" + week4,
          "PATCH",
          { filename: "cross-folder.txt" },
        )
      ).status,
      404,
    );
    const blockResponse = await request(
      path + "/blocks?folder=" + week4,
      "POST",
      { title: "Command", language: "shell", content: "terraform init" },
    );
    assert.equal(blockResponse.status, 201);
    class Socket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { origin });
      }
    }
    student = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      workspace.id,
      new Y.Doc(),
      {
        connect: false,
        disableBc: true,
        WebSocketPolyfill: Socket as never,
        protocols: ["devshare"],
        params: { folder: week4 },
      },
    );
    student.awareness.setLocalState({
      user: { name: "Student", color: "#38bdf8" },
    });
    student.connect();
    await until(() => student!.synced);
    assert.match(
      JSON.stringify(student.doc.getMap("documents").toJSON()),
      /Week 4 live marker/,
    );
    assert.ok(
      !JSON.stringify(student.doc.getMap("documents").toJSON()).includes(
        "Inactive week 1 secret marker",
      ),
    );
    await request(path + "/folders/" + week4, "PATCH", {
      name: "Terraform lesson",
    });
    await until(() =>
      JSON.stringify(student!.doc.getMap("catalog").toJSON()).includes(
        "Terraform lesson",
      ),
    );
    await request(path + "/folders/order", "PATCH", {
      ids: [week4, week1],
      parent_id: null,
    });
    assert.equal(
      (
        await request(path + "/folders/order", "PATCH", {
          ids: [nested, week1],
          parent_id: null,
        })
      ).status,
      400,
    );
    student.destroy();
    student.doc.destroy();
    student = undefined;
    await until(() => lesson.peers.size === 0);
    for (const session of app.rooms.active.values())
      session.touched = Date.now() - 31_000;
    app.rooms.collect();
    assert.equal(app.rooms.active.size, 0);
    assert.equal(
      Number(
        app.rooms.db.prepare("SELECT COUNT(*) AS n FROM folders").get()?.n,
      ),
      3,
    );
    assert.equal(
      app.rooms.db
        .prepare("SELECT content FROM documents WHERE id=?")
        .get(file.id)?.content,
      "# Week 4 live marker",
    );
    assert.equal(
      app.rooms.db
        .prepare("SELECT folder_id FROM code_blocks WHERE workspace_id=?")
        .get(workspace.id)?.folder_id,
      week4,
    );
    const tree = await (
      await request(path + "/tree", "GET", undefined, false)
    ).json();
    assert.ok(!JSON.stringify(tree).includes("live marker"));
    assert.equal(app.rooms.active.size, 0);
    await app.close();
    app = createApp({ dbPath, origins: [origin] });
    await new Promise<void>((resolve) =>
      app.server.listen(port, "127.0.0.1", resolve),
    );
    const reloaded = app.rooms.get(workspace.id, week4)!;
    assert.match(JSON.stringify(reloaded.doc.toJSON()), /Week 4 live marker/);
    assert.ok(
      !JSON.stringify(reloaded.doc.toJSON()).includes(
        "Inactive week 1 secret marker",
      ),
    );
    assert.equal(
      (await request(path + "/folders/" + week4, "DELETE")).status,
      200,
    );
    assert.equal(
      Number(
        app.rooms.db.prepare("SELECT COUNT(*) AS n FROM folders").get()?.n,
      ),
      1,
    );
    assert.equal(
      app.rooms.db.prepare("SELECT id FROM documents WHERE id=?").get(file.id),
      undefined,
    );
    assert.ok(
      app.rooms.db
        .prepare("SELECT id FROM documents WHERE id=?")
        .get(oldFile.id),
    );
    assert.equal((await request(path, "DELETE")).status, 200);
    assert.equal(app.rooms.info(workspace.id), undefined);
  } finally {
    student?.destroy();
    student?.doc.destroy();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
