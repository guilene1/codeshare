import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { hashEditorToken } from "../src/access.js";
import { newToken } from "../src/auth.js";
import { signUp } from "./helpers.js";

const origin = "http://localhost:5173";

test("owners and account editors copy the same active Edit Link again later; nobody else can, and old links are never rotated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-links-")),
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
  const stored = (id: string) => ({
    ...(app.rooms.db.prepare("SELECT editor_token_hash h, editor_token_sealed s FROM rooms WHERE id=?").get(id) as { h: string | null; s: string | null }),
  });
  try {
    const owner = await signUp(base, origin, "Owner"),
      editor = await signUp(base, origin, "Editor"),
      viewer = await signUp(base, origin, "Viewer"),
      outsider = await signUp(base, origin, "Outsider");
    const { id } = (await (await call("/rooms", "POST", { name: "Course", language: "markdown" }, owner.headers)).json()) as { id: string };
    for (const [who, role] of [[editor, "editor"], [viewer, "viewer"]] as const)
      assert.equal((await call(`/rooms/${id}/shares`, "POST", { email: who.email, role }, owner.headers)).status, 201);
    const fetchLink = async (headers: Record<string, string>) => {
      const r = await call(`/rooms/${id}/editor-link`, "GET", undefined, headers);
      return { status: r.status, cache: r.headers.get("cache-control"), token: r.ok ? ((await r.json()) as { token: string | null }).token : undefined };
    };
    const grants = async (token: string) =>
      ((await (await call(`/rooms/${id}`, "GET", undefined, { authorization: "Bearer " + token })).json()) as { access?: string }).access;

    // No link yet.
    assert.deepEqual(await fetchLink(owner.headers), { status: 200, cache: "no-store", token: null });

    // The owner creates a link; returning later (any new request) gives back the very same one.
    const created = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as { token: string };
    const first = stored(id);
    assert.equal(first.h, hashEditorToken(created.token));
    assert.ok(first.s && !first.s.includes(created.token), "the database never holds the link in plain text");
    assert.equal((await fetchLink(owner.headers)).token, created.token);
    assert.equal((await fetchLink(owner.headers)).token, created.token, "stable across repeated returns");
    // An invited account editor (Shared with Me) gets the same active link.
    assert.equal((await fetchLink(editor.headers)).token, created.token);
    assert.deepEqual(stored(id), first, "retrieving never rotates or rewrites the link");
    assert.equal(await grants(created.token), "editor");

    // Nobody else: viewer shares, outsiders, anonymous students and Edit Link guests.
    assert.equal((await fetchLink(viewer.headers)).status, 403);
    assert.equal((await fetchLink(outsider.headers)).status, 403);
    assert.equal((await fetchLink({})).status, 403);
    assert.equal((await fetchLink({ authorization: "Bearer " + created.token })).status, 403);
    // Workspace info still never carries the link, for anyone.
    for (const headers of [owner.headers, editor.headers, viewer.headers, {}, { authorization: "Bearer " + created.token }])
      assert.ok(!(await (await call(`/rooms/${id}`, "GET", undefined, headers)).text()).includes(created.token));

    // A link the editor creates is retrievable by the owner, and survives a server restart.
    const byEditor = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, editor.headers)).json()) as { token: string };
    assert.equal(await grants(created.token), undefined, "replacing still revokes the previous link");
    await app.close();
    app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
    base = await listen();
    assert.equal((await fetchLink(owner.headers)).token, byEditor.token);
    assert.equal((await fetchLink(editor.headers)).token, byEditor.token);

    // Revoking clears both the fingerprint and the stored link.
    assert.equal((await call(`/rooms/${id}/editor-link`, "DELETE", undefined, owner.headers)).status, 200);
    assert.deepEqual(stored(id), { h: null, s: null });
    assert.equal((await fetchLink(owner.headers)).token, null);
    assert.equal(await grants(byEditor.token), undefined);

    // Links from before this change (fingerprint only) keep working, are reported as not
    // retrievable, and are left exactly as they were.
    const legacy = newToken();
    app.rooms.db.prepare("UPDATE rooms SET editor_token_hash=?,editor_token_sealed=NULL WHERE id=?").run(hashEditorToken(legacy), id);
    const before = stored(id);
    assert.equal((await fetchLink(owner.headers)).token, null);
    assert.equal((await fetchLink(editor.headers)).token, null);
    assert.deepEqual(stored(id), before);
    assert.equal(await grants(legacy), "editor");
    const info = (await (await call(`/rooms/${id}`, "GET", undefined, owner.headers)).json()) as { hasEditorLink?: boolean };
    assert.equal(info.hasEditorLink, true);

    // A stored link that is no longer the active one (fingerprint changed outside the API,
    // as scripts/recover-editor.mjs does) is never shown.
    const current = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as { token: string };
    app.rooms.db.prepare("UPDATE rooms SET editor_token_hash=? WHERE id=?").run(hashEditorToken(newToken()), id);
    assert.equal((await fetchLink(owner.headers)).token, null);
    assert.equal(await grants(current.token), undefined);

    // The key lives in its own file beside the database (backups copy only the database).
    const keyFile = join(dir, "edit-link.key");
    assert.ok(existsSync(keyFile));
    assert.ok(!(await readFile(dbPath)).includes(Buffer.from((await readFile(keyFile, "utf8")).trim())));
    // Restored without its key (a new key is generated): links still work but aren't shown.
    const again = (await (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json()) as { token: string };
    await app.close();
    await rm(keyFile);
    app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
    base = await listen();
    assert.equal((await fetchLink(owner.headers)).token, null);
    assert.equal(await grants(again.token), "editor");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
