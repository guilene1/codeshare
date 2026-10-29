import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket, type ClientOptions } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN, signUp } from "./helpers.js";

async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for synchronization");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("the lesson sync is compressed on the wire, uncompressed clients still work, and size limits apply after decompression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-deflate-"));
  const app = createApp({ dbPath: join(dir, "rooms.sqlite"), checkpointMs: 30, origins: [DEFAULT_ORIGIN] });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const providers: WebsocketProvider[] = [];
  try {
    const owner = await signUp(base);
    const json = { ...owner.headers, "content-type": "application/json" };
    const { id } = (await (
      await fetch(base + "/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "Course", language: "markdown" }) })
    ).json()) as { id: string };
    const content = Array.from({ length: 3000 }, (_, i) => `## Step ${i}\n\nApply the module and review the plan output.\n`).join("");
    const created = await fetch(`${base}/api/rooms/${id}/documents`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ filename: "lesson.md", language: "markdown", content }),
    });
    assert.equal(created.status, 201);

    // Syncs one client and reports what the server negotiated and how many bytes arrived.
    const open = async (perMessageDeflate: boolean) => {
      let extensions = "", socket: WebSocket | undefined;
      class Socket extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { origin: DEFAULT_ORIGIN, headers: { cookie: owner.cookie }, perMessageDeflate } as ClientOptions);
          socket = this;
          this.on("upgrade", (res) => (extensions = String(res.headers["sec-websocket-extensions"] ?? "")));
        }
      }
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, doc, {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        protocols: ["devshare"],
      });
      providers.push(provider);
      await until(() => provider.synced);
      const file = [...doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === "lesson.md");
      return { extensions, bytesRead: (socket as unknown as { _socket: { bytesRead: number } })._socket.bytesRead, text: (file?.get("content") as Y.Text | undefined)?.toString(), doc, provider };
    };

    const compressed = await open(true);
    assert.equal(compressed.text, content, "the compressed sync delivers the exact document");
    assert.match(compressed.extensions, /permessage-deflate/);
    assert.match(compressed.extensions, /server_no_context_takeover/);
    assert.match(compressed.extensions, /client_no_context_takeover/);
    const plain = await open(false);
    assert.equal(plain.text, content, "a client that does not offer compression still syncs");
    assert.equal(plain.extensions, "");
    assert.ok(plain.bytesRead > content.length, `uncompressed sync carries the full lesson (${plain.bytesRead} bytes)`);
    assert.ok(compressed.bytesRead < plain.bytesRead / 2, `compressed ${compressed.bytesRead} vs uncompressed ${plain.bytesRead} bytes`);

    // Live edits still flow both ways between a compressed and an uncompressed client.
    const lesson = (doc: Y.Doc) => [...doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === "lesson.md")!.get("content") as Y.Text;
    lesson(compressed.doc).insert(0, "From the compressed client\n");
    await until(() => lesson(plain.doc).toString().startsWith("From the compressed client\n"));
    lesson(plain.doc).insert(0, "x".repeat(4000) + "\n");
    await until(() => lesson(compressed.doc).toString().startsWith("x".repeat(4000)));

    // Cursors (awareness, small uncompressed frames) still reach the other editor.
    compressed.provider.awareness.setLocalStateField("user", { name: "Compressed", color: "#38bdf8" });
    compressed.provider.awareness.setLocalStateField("selection", { anchor: 3, head: 9 });
    const seen = () =>
      [...plain.provider.awareness.getStates().values()].find((s) => s.selection?.head === 9) as
        | { user: { name: string }; role: string }
        | undefined;
    await until(() => !!seen());
    assert.equal(seen()!.user.name, owner.user.displayName, "the server still names editors by their verified account");
    assert.equal(seen()!.role, "editor");

    // A tiny compressed frame that inflates past maxPayload is refused (1009), not applied.
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, ["devshare"], { origin: DEFAULT_ORIGIN, headers: { cookie: owner.cookie } });
      ws.on("open", () => ws.send(new Uint8Array(6 * 1024 * 1024), { compress: true }));
      ws.on("close", (closeCode) => resolve(closeCode));
      ws.on("error", () => {});
    });
    assert.equal(code, 1009);
    assert.equal(lesson(app.rooms.get(id)!.doc).toString().length, content.length + 27 + 4001);
  } finally {
    // Destroying the doc also stops its awareness timer, which otherwise keeps the process alive.
    for (const provider of providers) {
      provider.destroy();
      provider.doc.destroy();
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
