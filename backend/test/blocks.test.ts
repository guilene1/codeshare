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
import type { CodeBlock } from "../src/blocks.js";

test("independent blocks broadcast, enforce permissions, validate order and survive SQLite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-blocks-"));
  const dbPath = join(directory, "blocks.sqlite");
  const origin = "http://localhost:5173";
  let app = createApp({ dbPath, origins: [origin] });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (app.server.address() as { port: number }).port;
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    editor = true,
  ) =>
    fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: {
        origin,
        Connection: "close",
        "content-type": "application/json",
        ...(editor ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  class Socket extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { origin });
    }
  }
  const clients: WebsocketProvider[] = [];
  const until = async (check: () => boolean) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 5000) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    const room = (await (
      await request("/rooms", "POST", {
        name: "Teaching snippets",
        language: "hcl",
        editorTokenHash: hash,
      })
    ).json()) as { id: string };
    const path = "/rooms/" + room.id + "/blocks";
    const student = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      room.id,
      new Y.Doc(),
      {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        connect: false,
        protocols: ["devshare"],
      },
    );
    student.awareness.setLocalState({
      user: { name: "Student", color: "#38bdf8" },
    });
    student.connect();
    clients.push(student);
    await until(() => student.synced);
    const content = 'provider "aws" {\n  region = "us-east-1"\n}';
    const firstResponse = await request(path, "POST", {
      title: "Terraform Provider",
      language: "hcl",
      content,
    });
    assert.equal(firstResponse.status, 201);
    const first = (await firstResponse.json()) as { id: string };
    const second = (await (
      await request(path, "POST", {
        language: "shell",
        content: "terraform init",
      })
    ).json()) as { id: string };
    await until(() => student.doc.getMap<CodeBlock>("codeBlocks").size === 2);
    assert.equal(
      student.doc.getMap<CodeBlock>("codeBlocks").get(first.id)?.content,
      content,
    );
    assert.equal(
      student.doc.getMap<CodeBlock>("codeBlocks").get(second.id)?.content,
      "terraform init",
    );
    for (const [method, suffix, body] of [
      ["POST", "", { language: "shell", content: "attack" }],
      ["PATCH", "/" + first.id, { content: "attack" }],
      ["DELETE", "/" + first.id, undefined],
      ["PATCH", "/order", { ids: [second.id, first.id] }],
    ] as const)
      assert.equal(
        (await request(path + suffix, method, body, false)).status,
        403,
      );
    assert.equal(
      (await request(path, "POST", { language: "exe", content: "x" })).status,
      400,
    );
    assert.equal(
      (await request(path, "POST", { language: "shell", content: " " })).status,
      400,
    );
    assert.equal(
      (
        await request(path, "POST", {
          language: "shell",
          content: "x".repeat(65537),
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(path + "/order", "PATCH", { ids: [first.id, first.id] }))
        .status,
      400,
    );
    assert.equal(
      (await request(path + "/order", "PATCH", { ids: [first.id] })).status,
      400,
    );
    assert.equal(
      (
        await request(path + "/" + first.id, "PATCH", {
          title: "Updated",
          language: "python",
          content: 'print("hello")',
          id: "forged",
          workspace_id: "forged",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(path + "/order", "PATCH", { ids: [second.id, first.id] }))
        .status,
      200,
    );
    await until(
      () =>
        student.doc.getMap<CodeBlock>("codeBlocks").get(first.id)?.title ===
        "Updated",
    );
    assert.equal(
      student.doc.getMap<CodeBlock>("codeBlocks").get(first.id)?.id,
      first.id,
    );
    assert.equal(
      student.doc.getMap<CodeBlock>("codeBlocks").get(first.id)?.workspace_id,
      room.id,
    );
    const editor = new WebsocketProvider(
      `ws://127.0.0.1:${port}/ws`,
      room.id,
      new Y.Doc(),
      {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        connect: false,
        protocols: ["devshare", "editor." + token],
      },
    );
    editor.awareness.setLocalState({
      user: { name: "Instructor", color: "#a78bfa" },
    });
    editor.connect();
    clients.push(editor);
    await until(() => editor.synced);
    for (const client of [student, editor]) {
      const closed = new Promise<number>((resolve) =>
        client.on("connection-close", (event) => {
          if (event) {
            client.shouldConnect = false;
            resolve(event.code);
          }
        }),
      );
      client.doc.getMap<CodeBlock>("codeBlocks").set(first.id, {
        ...client.doc.getMap<CodeBlock>("codeBlocks").get(first.id)!,
        content: "WS attack",
      });
      assert.equal(await closed, 1008);
    }
    assert.equal(
      (await request("/rooms/" + room.id + "/checkpoint", "POST")).status,
      200,
    );
    const rows = app.rooms.db
      .prepare(
        "SELECT * FROM code_blocks WHERE workspace_id=? ORDER BY position",
      )
      .all(room.id);
    assert.deepEqual(
      rows.map((row) => row.id),
      [second.id, first.id],
    );
    assert.equal(rows[1].content, 'print("hello")');
    for (const client of clients) {
      client.destroy();
      client.doc.destroy();
    }
    await app.close();
    app = createApp({ dbPath, origins: [origin] });
    const blocks = [
      ...app.rooms.get(room.id)!.doc.getMap<CodeBlock>("codeBlocks").values(),
    ].sort((a, b) => a.position - b.position);
    assert.deepEqual(
      blocks.map((block) => block.id),
      [second.id, first.id],
    );
    assert.equal(blocks[1].content, 'print("hello")');
    await new Promise<void>((resolve) =>
      app.server.listen(port, "127.0.0.1", resolve),
    );
    assert.equal((await request(path + "/" + second.id, "DELETE")).status, 200);
    const remaining = (await (
      await request(path, "GET", undefined, false)
    ).json()) as { blocks: CodeBlock[] };
    assert.equal(remaining.blocks.length, 1);
    assert.equal(remaining.blocks[0].position, 0);
  } finally {
    for (const client of clients) {
      client.destroy();
      client.doc.destroy();
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
