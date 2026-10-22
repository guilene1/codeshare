// Large text documents: creation and editing up to 1 MB per file and 2 MB per lesson, across
// REST (as Claude Code uses it, with a private editor link) and WebSocket editing, plus the
// content API's version checks, permissions, line endings and activity attribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { hashEditorToken } from "../src/access.js";
import { createBlock } from "../src/blocks.js";
import { signUp } from "./helpers.js";

const origin = "http://localhost:5173";
const KB = 1024,
  MB = 1024 * KB;
// Realistic code: quotes, indentation and newlines (JSON escaping inflates these).
function code(bytes: number, seed = "") {
  let out = "";
  for (let i = 0; out.length < bytes; i++)
    out += `  const item_${seed}${i} = { name: "value-${i}", path: "/srv/app/${i}" }; // note\n`;
  return out.slice(0, bytes);
}
const version = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
async function until(check: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

type App = ReturnType<typeof createApp>;
async function harness(dbPath: string) {
  const app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, base };
}

test("large documents: REST creation, content API, conflicts, permissions and WebSocket limits", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-upload-"));
  const dbPath = join(dir, "db.sqlite");
  let { app, base } = await harness(dbPath);
  const providers: WebsocketProvider[] = [];
  try {
    const owner = await signUp(base, origin, "Upload Owner");
    const vera = await signUp(base, origin, "Vera Viewer");
    // Created in-process (workspace creation has its own rate limit); every request below
    // still goes through HTTP or the WebSocket with a private editor link, like Claude Code.
    const workspace = (a: App = app) => {
      const token = randomBytes(32).toString("base64url");
      const room = a.rooms.create("Upload test", "markdown", hashEditorToken(token), undefined, "", owner.user.id);
      return { id: room.workspaceId, token };
    };
    const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + "/api" + path, {
        method,
        headers: { origin, ...(typeof body === "string" ? { "content-type": "text/plain" } : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const stored = (id: string) =>
      app.rooms.db.prepare("SELECT content FROM documents WHERE id=?").get(id)?.content as string | undefined;
    const connect = (room: string, options: { token?: string; cookie?: string; user?: string } = {}) => {
      class Socket extends WebSocket {
        constructor(url: string, p?: string | string[]) {
          super(url, p, { origin, headers: options.cookie ? { cookie: options.cookie } : {} });
        }
      }
      const provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", room, new Y.Doc(), {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        protocols: options.token ? ["devshare", "editor." + options.token] : ["devshare"],
      });
      if (options.user) provider.awareness.setLocalStateField("user", { name: options.user, color: "#38bdf8" });
      const closes: string[] = [];
      provider.on("connection-close", (event: CloseEvent | null) => {
        if (event) closes.push(`${event.code} ${event.reason}`);
      });
      providers.push(provider);
      return { provider, closes };
    };
    const text = (p: WebsocketProvider, fileId: string) =>
      p.doc.getMap<Y.Map<unknown>>("documents").get(fileId)?.get("content") as Y.Text | undefined;

    // 1. Creation with content, 8 KB to 1 MB, through the private editor link.
    for (const kb of [8, 16, 32, 64, 128, 256, 512, 1024]) {
      const { id, token } = workspace();
      const content = code(kb * KB);
      const response = await call(`/rooms/${id}/documents`, "POST", { filename: "big.md", language: "markdown", content }, bearer(token));
      assert.equal(response.status, 201, `${kb} KB: ${await response.clone().text()}`);
      const body = (await response.json()) as { id: string; version: string; bytes: number };
      assert.equal(stored(body.id), content, `${kb} KB stored exactly`);
      assert.equal(body.version, version(content));
      assert.equal(body.bytes, kb * KB);
      assert.equal(response.headers.get("etag"), `"${version(content)}"`);
    }

    // 2. Limits: one byte over 1 MB, and a lesson over 2 MB, are refused with clear 413s.
    const limits = workspace();
    const over = await call(`/rooms/${limits.id}/documents`, "POST", { filename: "over.md", language: "markdown", content: code(MB + 1) }, bearer(limits.token));
    assert.equal(over.status, 413);
    assert.deepEqual(await over.json(), { error: "Files can be up to 1 MB (this one would be 1.01 MB)." });
    for (const name of ["a.md", "b.md"])
      assert.equal((await call(`/rooms/${limits.id}/documents`, "POST", { filename: name, language: "markdown", content: code(MB) }, bearer(limits.token))).status, 201);
    const lessonFull = await call(`/rooms/${limits.id}/documents`, "POST", { filename: "c.md", language: "markdown", content: "x" }, bearer(limits.token));
    assert.equal(lessonFull.status, 413);
    assert.match(((await lessonFull.json()) as { error: string }).error, /^Lessons can hold up to 2 MB of files and code blocks \(this would be 2\.01 MB\)\.$/);
    assert.equal(app.rooms.db.prepare("SELECT COUNT(*) n FROM documents WHERE room_id=? AND filename IN ('over.md','c.md')").get(limits.id)!.n, 0);
    // A body far beyond any file is stopped by the parser with the same kind of message.
    const huge = await call(`/rooms/${limits.id}/documents`, "POST", { filename: "huge.md", language: "markdown", content: "a".repeat(3 * MB) }, bearer(limits.token));
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), { error: "Files can be up to 1 MB of text." });
    // Other endpoints keep their small limits; code blocks stay at 64 KB.
    const bigRename = await call(`/rooms/${limits.id}`, "PATCH", { name: "x".repeat(20 * KB) }, owner.headers);
    assert.equal(bigRename.status, 413);
    assert.deepEqual(await bigRename.json(), { error: "Request too large." });
    const bigBlock = await call(`/rooms/${limits.id}/blocks`, "POST", { title: "t", language: "shell", content: "a".repeat(64 * KB + 1) }, bearer(limits.token));
    assert.equal(bigBlock.status, 400);
    assert.deepEqual(await bigBlock.json(), { error: "Enter code up to 64 KB per block." });

    // 3. Content API on an existing file, with a browser editor connected to the same lesson.
    const { id, token } = workspace();
    const created = (await (await call(`/rooms/${id}/documents`, "POST", { filename: "kubernetes.yaml", language: "yaml", content: "kind: Pod\n" }, bearer(token))).json()) as { id: string; version: string };
    const fileId = created.id;
    const browser = connect(id, { cookie: owner.cookie, user: "Upload Owner" });
    await until(() => browser.provider.synced && !!text(browser.provider, fileId));

    // Reading: same access as the editor (anyone who can open the workspace).
    const read = await call(`/rooms/${id}/documents/${fileId}/content`, "GET", undefined, bearer(token));
    assert.equal(read.status, 200);
    const readBody = (await read.json()) as Record<string, unknown>;
    assert.equal(readBody.content, "kind: Pod\n");
    assert.equal(readBody.version, created.version);
    assert.equal(readBody.filename, "kubernetes.yaml");
    assert.equal(readBody.folderId, null);
    assert.equal(read.headers.get("etag"), `"${created.version}"`);
    assert.equal((await call(`/rooms/${id}/documents/${fileId}/content`)).status, 200);
    assert.equal((await call(`/rooms/${id}/documents/not-a-real-file-id-0000000000000000/content`, "GET", undefined, bearer(token))).status, 404);

    // Writing needs the version being replaced: missing → 428, stale → 409, nothing changes.
    const big = code(600 * KB, "v1");
    const missing = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: big }, bearer(token));
    assert.equal(missing.status, 428);
    assert.equal(((await missing.json()) as { version: string }).version, created.version);
    const stale = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: big }, { ...bearer(token), "if-match": `"${version("old")}"` });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: "This file changed since you read it. Fetch the latest content and try again.",
      version: created.version,
    });
    assert.equal(stored(fileId), "kind: Pod\n");

    // A matching version replaces the text in place: same file ID, live in the browser.
    const updated = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: big }, { ...bearer(token), "if-match": `"${created.version}"` });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as { id: string; version: string; changed: boolean; bytes: number };
    assert.deepEqual(updatedBody, { id: fileId, version: version(big), bytes: 600 * KB, changed: true });
    assert.equal(stored(fileId), big);
    await until(() => text(browser.provider, fileId)?.toString() === big);
    assert.equal((app.rooms.tree(id).documents as Array<{ id: string }>).filter((d) => d.id === fileId).length, 1);

    // Concurrent browser edit after the API read: the API's stale write is refused.
    const before = ((await (await call(`/rooms/${id}/documents/${fileId}/content`, "GET", undefined, bearer(token))).json()) as { version: string }).version;
    text(browser.provider, fileId)!.insert(0, "# edited in the browser\n");
    await until(() => (stored(fileId) ?? "").startsWith("# edited in the browser"));
    const conflict = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: "api overwrite" }, { ...bearer(token), "if-match": before });
    assert.equal(conflict.status, 409);
    assert.ok(stored(fileId)!.startsWith("# edited in the browser"), "browser edit kept");
    // Re-reading and retrying succeeds, and the browser converges to it.
    const fresh = (await (await call(`/rooms/${id}/documents/${fileId}/content`, "GET", undefined, bearer(token))).json()) as { version: string; content: string };
    const merged = fresh.content + "# appended by the API\n";
    assert.equal((await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: merged, baseVersion: fresh.version }, bearer(token))).status, 200);
    await until(() => text(browser.provider, fileId)?.toString() === merged);

    // Raw text/plain bodies (curl --data-binary @file) and deliberate overwrite with If-Match: *.
    const plain = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", "line one\r\nline two\rline three\n", { ...bearer(token), "if-match": "*" });
    assert.equal(plain.status, 200);
    assert.equal(stored(fileId), "line one\nline two\nline three\n", "CRLF and CR normalised to LF");
    assert.equal(((await plain.json()) as { version: string }).version, version("line one\nline two\nline three\n"));
    await until(() => text(browser.provider, fileId)?.toString() === "line one\nline two\nline three\n");
    // A file that already uses CRLF keeps CRLF, so editors open on it stay consistent.
    text(browser.provider, fileId)!.delete(0, text(browser.provider, fileId)!.length);
    text(browser.provider, fileId)!.insert(0, "windows\r\nfile\r\n");
    await until(() => stored(fileId) === "windows\r\nfile\r\n");
    assert.equal((await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", "windows\nfile\nmore\n", { ...bearer(token), "if-match": "*" })).status, 200);
    assert.equal(stored(fileId), "windows\r\nfile\r\nmore\r\n");
    // Emoji (surrogate pairs) survive minimal-diff replacement exactly (in an LF file again).
    text(browser.provider, fileId)!.delete(0, text(browser.provider, fileId)!.length);
    text(browser.provider, fileId)!.insert(0, "lf\n");
    await until(() => stored(fileId) === "lf\n");
    const emoji = "deploy 🚀 then 🎉\n";
    assert.equal((await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", "deploy 🚀 then ✅\n", { ...bearer(token), "if-match": "*" })).status, 200);
    assert.equal((await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", emoji, { ...bearer(token), "if-match": "*" })).status, 200);
    assert.equal(stored(fileId), emoji);
    await until(() => text(browser.provider, fileId)?.toString() === emoji);

    // Oversized updates are refused and leave the file untouched.
    const tooBig = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: code(MB + 10) }, { ...bearer(token), "if-match": "*" });
    assert.equal(tooBig.status, 413);
    assert.equal(stored(fileId), emoji);
    for (const name of ["one.md", "two.md"])
      await call(`/rooms/${id}/documents`, "POST", { filename: name, language: "markdown", content: code(900 * KB, name) }, bearer(token));
    const lessonOver = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: code(400 * KB) }, { ...bearer(token), "if-match": "*" });
    assert.equal(lessonOver.status, 413);
    assert.match(((await lessonOver.json()) as { error: string }).error, /^Lessons can hold up to 2 MB/);
    assert.equal(stored(fileId), emoji);

    // Viewers (registered or anonymous) and revoked/invalid links cannot write.
    const share = await call(`/rooms/${id}/shares`, "POST", { email: vera.email, role: "viewer" }, owner.headers);
    assert.equal(share.status, 201);
    for (const headers of [vera.headers, {}, { authorization: "Bearer " + "x".repeat(43) }]) {
      const refused = await call(`/rooms/${id}/documents/${fileId}/content`, "PUT", { content: "hacked" }, { ...headers, "if-match": "*" });
      assert.ok(refused.status === 403, `refused with ${refused.status}`);
    }
    assert.equal(stored(fileId), emoji);

    // Files in a folder are reachable by ID without naming the folder.
    const folder = (await (await call(`/rooms/${id}/folders`, "POST", { name: "Week 1" }, bearer(token))).json()) as { id: string };
    const nested = (await (await call(`/rooms/${id}/documents?folder=${folder.id}`, "POST", { filename: "lab.md", language: "markdown", content: "lab\n" }, bearer(token))).json()) as { id: string; version: string };
    const nestedRead = (await (await call(`/rooms/${id}/documents/${nested.id}/content`, "GET", undefined, bearer(token))).json()) as { folderId: string; content: string };
    assert.deepEqual([nestedRead.folderId, nestedRead.content], [folder.id, "lab\n"]);
    assert.equal((await call(`/rooms/${id}/documents/${nested.id}/content`, "PUT", "lab v2\n", { ...bearer(token), "if-match": nested.version })).status, 200);
    assert.equal(stored(nested.id), "lab v2\n");

    // Activity: API edits are attributed (link guest vs. owner account), coalesced per person.
    assert.equal((await call(`/rooms/${id}/documents/${nested.id}/content`, "PUT", "lab v3\n", { ...owner.headers, "if-match": "*" })).status, 200);
    const activity = (await (await call(`/rooms/${id}/activity`, "GET", undefined, owner.headers)).json()) as {
      entries: Array<{ action: string; label: string; actor: { kind: string; name?: string } | null }>;
    };
    const edits = activity.entries.filter((e) => e.action === "file.edited");
    assert.ok(edits.some((e) => e.label === "lab.md" && e.actor?.kind === "link"));
    assert.ok(edits.some((e) => e.label === "lab.md" && e.actor?.name === "Upload Owner"));
    assert.equal(edits.filter((e) => e.label === "kubernetes.yaml" && e.actor?.kind === "link").length, 1, "coalesced");

    // 4. A private-link client without presence metadata stays connected as "Guest editor".
    const guest = connect(id, { token });
    await until(() => guest.provider.synced && !!text(guest.provider, fileId));
    text(guest.provider, fileId)!.insert(0, "guest ");
    await until(() => stored(fileId) === "guest " + emoji);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(guest.closes, [], "no Invalid presence disconnect");
    const anySocket = [...app.rooms.live.keys()][0];
    assert.deepEqual(app.rooms.presence(id, anySocket).guests.map((g) => g.name), ["Guest editor"]);
    // Anonymous viewers are still refused on WebSocket writes.
    const viewer = connect(id);
    await until(() => viewer.provider.synced);
    text(viewer.provider, fileId)!.insert(0, "viewer ");
    await until(() => viewer.closes.some((c) => c.startsWith("1008 View-only access")));
    assert.equal(stored(fileId), "guest " + emoji);

    // 5. WebSocket limits match REST: 1 MB per file, refused cleanly above it.
    const wsLimits = workspace();
    const empty = (await (await call(`/rooms/${wsLimits.id}/documents`, "POST", { filename: "ws.md", language: "markdown", content: "" }, bearer(wsLimits.token))).json()) as { id: string };
    const editor = connect(wsLimits.id, { token: wsLimits.token, user: "Claude Code" });
    await until(() => editor.provider.synced && !!text(editor.provider, empty.id));
    text(editor.provider, empty.id)!.insert(0, code(MB));
    await until(() => stored(empty.id)?.length === MB);
    text(editor.provider, empty.id)!.insert(0, "x");
    await until(() => editor.closes.some((c) => c.startsWith("1008 Files can be up to 1 MB")));
    assert.equal(stored(empty.id)?.length, MB);

    // 6. Content survives a server restart and reconnect.
    for (const p of providers) p.destroy();
    await app.close();
    ({ app, base } = await harness(dbPath));
    const reread = (await (await call(`/rooms/${id}/documents/${fileId}/content`, "GET", undefined, bearer(token))).json()) as { content: string };
    assert.equal(reread.content, "guest " + emoji);
    const after = connect(id, { token, user: "Reconnected" });
    await until(() => after.provider.synced && text(after.provider, fileId)?.toString() === "guest " + emoji);
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
  }
});

test("review: isolation between workspaces, refused writes change nothing, no extra rights", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-upload-review-"));
  const { app, base } = await harness(join(dir, "db.sqlite"));
  const providers: WebsocketProvider[] = [];
  try {
    const owner = await signUp(base, origin, "Review Owner");
    const vera = await signUp(base, origin, "Vera Viewer");
    const workspace = () => {
      const token = randomBytes(32).toString("base64url");
      const room = app.rooms.create("Review", "markdown", hashEditorToken(token), undefined, "", owner.user.id);
      return { id: room.workspaceId, token };
    };
    const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + "/api" + path, {
        method,
        headers: {
          origin,
          ...(typeof body === "string" ? { "content-type": "text/plain" } : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const stored = (id: string) =>
      app.rooms.db.prepare("SELECT content FROM documents WHERE id=?").get(id)?.content as string | undefined;
    const activityRows = () => Number(app.rooms.db.prepare("SELECT COUNT(*) n FROM activity").get()!.n);
    const connect = (
      room: string,
      options: { token?: string; presence?: Record<string, unknown> } = {},
    ) => {
      class Socket extends WebSocket {
        constructor(url: string, p?: string | string[]) {
          super(url, p, { origin });
        }
      }
      const provider = new WebsocketProvider(base.replace("http", "ws") + "/ws", room, new Y.Doc(), {
        WebSocketPolyfill: Socket as never,
        disableBc: true,
        protocols: options.token ? ["devshare", "editor." + options.token] : ["devshare"],
      });
      if (options.presence) provider.awareness.setLocalState(options.presence);
      const closes: string[] = [];
      provider.on("connection-close", (event: CloseEvent | null) => {
        if (event) closes.push(`${event.code} ${event.reason}`);
      });
      providers.push(provider);
      return { provider, closes };
    };
    const text = (p: WebsocketProvider, fileId: string) =>
      p.doc.getMap<Y.Map<unknown>>("documents").get(fileId)?.get("content") as Y.Text | undefined;
    const create = async (ws: { id: string; token: string }, filename: string, content: string) =>
      (await (
        await call(`/rooms/${ws.id}/documents`, "POST", { filename, language: "markdown", content }, bearer(ws.token))
      ).json()) as { id: string; version: string };
    const presence = (workspaceId: string) => app.rooms.presence(workspaceId, [...app.rooms.live.keys()][0]);

    // 1. Another workspace's file can be neither read nor changed.
    const a = workspace(),
      b = workspace();
    const fileB = await create(b, "secret.md", "workspace B only\n");
    const folderA = (await (await call(`/rooms/${a.id}/folders`, "POST", { name: "Week 1" }, bearer(a.token))).json()) as { id: string };
    for (const path of [
      `/rooms/${a.id}/documents/${fileB.id}/content`,
      `/rooms/${a.id}/documents/${fileB.id}/content?folder=${folderA.id}`,
    ]) {
      assert.equal((await call(path, "GET", undefined, bearer(a.token))).status, 404);
      assert.equal((await call(path, "PUT", "taken over", { ...bearer(a.token), "if-match": "*" })).status, 404);
    }
    // A's link presented on B's workspace is refused outright, for reading and writing.
    assert.equal((await call(`/rooms/${b.id}/documents/${fileB.id}/content`, "GET", undefined, bearer(a.token))).status, 403);
    assert.equal(
      (await call(`/rooms/${b.id}/documents/${fileB.id}/content`, "PUT", "taken over", { ...bearer(a.token), "if-match": "*" })).status,
      403,
    );
    assert.equal(stored(fileB.id), "workspace B only\n");

    // 2. Revoked and invalid links can neither read with the link nor write.
    const c = workspace();
    const fileC = await create(c, "lesson-c.md", "original\n");
    assert.equal((await call(`/rooms/${c.id}/editor-link`, "DELETE", undefined, owner.headers)).status, 200);
    for (const token of [c.token, "y".repeat(43)]) {
      assert.equal((await call(`/rooms/${c.id}/documents/${fileC.id}/content`, "GET", undefined, bearer(token))).status, 403);
      assert.equal(
        (await call(`/rooms/${c.id}/documents/${fileC.id}/content`, "PUT", "x", { ...bearer(token), "if-match": "*" })).status,
        403,
      );
    }
    assert.equal(stored(fileC.id), "original\n");

    // 3. Unauthorised clients are refused before any large body is parsed (403, not 413).
    const d = workspace();
    const fileD = await create(d, "doc.md", "start\n");
    assert.equal((await call(`/rooms/${d.id}/shares`, "POST", { email: vera.email, role: "viewer" }, owner.headers)).status, 201);
    const huge = "a".repeat(1536 * KB);
    for (const headers of [{}, vera.headers]) {
      const post = await call(`/rooms/${d.id}/documents`, "POST", { filename: "big.md", language: "markdown", content: huge }, headers);
      assert.equal(post.status, 403);
      const put = await call(`/rooms/${d.id}/documents/${fileD.id}/content`, "PUT", { content: huge }, { ...headers, "if-match": "*" });
      assert.equal(put.status, 403);
    }
    // Proof the body is never parsed for them: malformed JSON would give a parser 400, and a
    // body over the parser limit a 413, if parsing happened before authorisation.
    for (const body of ['{"content": "' + "a".repeat(1536 * KB), "a".repeat(3 * MB)])
      for (const [method, path] of [
        ["POST", `/rooms/${d.id}/documents`],
        ["PUT", `/rooms/${d.id}/documents/${fileD.id}/content`],
      ])
        assert.equal(
          (
            await fetch(base + "/api" + path, {
              method,
              headers: { origin, "content-type": "application/json", "if-match": "*" },
              body,
            })
          ).status,
          403,
          `${method} ${body.length} bytes`,
        );
    // Viewers get no version information from PUT (refused before the version check).
    const viewerPut = await call(`/rooms/${d.id}/documents/${fileD.id}/content`, "PUT", "x", vera.headers);
    assert.equal(viewerPut.status, 403);
    assert.equal("version" in ((await viewerPut.json()) as object), false);

    // 4. Two API writers using the same version: the second is refused (409), nothing lost.
    const first = await call(`/rooms/${d.id}/documents/${fileD.id}/content`, "PUT", "writer one\n", { ...bearer(d.token), "if-match": fileD.version });
    const second = await call(`/rooms/${d.id}/documents/${fileD.id}/content`, "PUT", "writer two\n", { ...bearer(d.token), "if-match": fileD.version });
    assert.deepEqual([first.status, second.status], [200, 409]);
    assert.equal(stored(fileD.id), "writer one\n");

    // 5. Refused writes leave SQLite, the server's Yjs state, other editors and activity unchanged.
    const e = workspace();
    const fileE = await create(e, "main.md", "stable content\n");
    // Two 1,000 KB files put the lesson at about 1.95 MB of its 2 MB.
    await create(e, "filler.md", code(1000 * KB, "f"));
    await create(e, "filler-2.md", code(1000 * KB, "g"));
    const watcher = connect(e.id, { token: e.token, presence: { user: { name: "Watcher", color: "#38bdf8" } } });
    const sender = connect(e.id, { token: e.token, presence: { user: { name: "Sender", color: "#a78bfa" } } });
    await until(
      () =>
        watcher.provider.synced && sender.provider.synced && !!text(watcher.provider, fileE.id) && !!text(sender.provider, fileE.id),
    );
    const room = app.rooms.active.get(e.id)!;
    await new Promise((r) => setTimeout(r, 300));
    const snapshot = () => ({
      sqlite: stored(fileE.id),
      yjs: Buffer.from(Y.encodeStateVector(room.doc)).toString("base64"),
      text: (room.doc.getMap<Y.Map<unknown>>("documents").get(fileE.id)!.get("content") as Y.Text).toString(),
      watcher: text(watcher.provider, fileE.id)!.toString(),
      activity: activityRows(),
    });
    const before = snapshot();
    const put = (body: string, headers: Record<string, string>) =>
      call(`/rooms/${e.id}/documents/${fileE.id}/content`, "PUT", body, headers);
    const refusals = [
      await put(code(MB + 1), { ...bearer(e.token), "if-match": "*" }),
      await put(code(100 * KB), { ...bearer(e.token), "if-match": "*" }),
      await put("stale", { ...bearer(e.token), "if-match": version("old") }),
      await put("unversioned", bearer(e.token)),
      await put("viewer", { "if-match": "*" }),
      await call(`/rooms/${e.id}/documents`, "POST", { filename: "huge.md", language: "markdown", content: code(MB + 1) }, bearer(e.token)),
      await call(`/rooms/${e.id}/documents`, "POST", { filename: "over.md", language: "markdown", content: code(100 * KB) }, bearer(e.token)),
    ];
    assert.deepEqual(refusals.map((r) => r.status), [413, 413, 409, 428, 403, 413, 413]);
    // An oversized WebSocket edit is refused: the sender is disconnected, nobody else sees it.
    text(sender.provider, fileE.id)!.insert(0, code(MB + 1, "ws"));
    await until(() => sender.closes.some((x) => x.startsWith("1008 Files can be up to 1 MB")));
    sender.provider.shouldConnect = false;
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(snapshot(), before);
    assert.equal(
      app.rooms.db.prepare("SELECT COUNT(*) n FROM documents WHERE room_id=? AND filename IN ('huge.md','over.md')").get(e.id)!.n,
      0,
    );

    // 6. "Guest editor" is only a label. A viewer sending forged presence stays an anonymous viewer.
    const forged = connect(e.id, { presence: { user: { name: "Review Owner", color: "#a78bfa" } } });
    await until(() => forged.provider.synced && presence(e.id).anonymous === 1);
    assert.ok(!presence(e.id).users.some((u) => u.name === "Review Owner"));
    assert.ok([...room.awareness.getStates().values()].every((s) => s.role !== "viewer" || !("user" in s)));
    text(forged.provider, fileE.id)?.insert(0, "forged ");
    await until(() => forged.closes.some((x) => x.startsWith("1008 View-only access")));
    // A link client without presence gets the label and exactly the link's (editor) rights.
    const plain = connect(e.id, { token: e.token });
    await until(() => plain.provider.synced && presence(e.id).guests.some((g) => g.name === "Guest editor"));
    assert.ok(!presence(e.id).users.some((u) => u.name === "Guest editor"));
    assert.equal(stored(fileE.id), "stable content\n");

    // 7. Moving snippets into a lesson file respects the 1 MB file limit as well.
    const f = workspace();
    const lesson = app.rooms.get(f.id)!;
    for (let i = 0; i < 1000; i++)
      createBlock(lesson, { title: `Block ${String(i).padStart(4, "0")}`, language: "shell", content: "x".repeat(1027) });
    app.rooms.save(lesson);
    const migrate = await call(`/rooms/${f.id}/migrate-snippets`, "POST", {}, bearer(f.token));
    assert.equal(migrate.status, 413);
    assert.match(((await migrate.json()) as { error: string }).error, /^Files can be up to 1 MB/);
    assert.equal(lesson.doc.getMap("migrations").get("snippetsToMarkdown"), undefined);
    assert.equal(lesson.doc.getMap("documents").size, 1, "only the starter file");
  } finally {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
  }
});
