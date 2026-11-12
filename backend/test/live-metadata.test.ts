import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

// Folder sharing, Phase 1: everyone connected to a lesson receives its whole live document,
// so it must hold only that lesson's own files. The workspace's folder/file tree and its name
// are served over REST, and data-free WebSocket notices (message type 5) say when to re-read.

async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(dbPath: string) {
  const app = createApp({ dbPath, origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text };
  };
  const providers: WebsocketProvider[] = [];
  // A real y-websocket client that also records every raw frame it receives and every notice.
  const connect = (id: string, opts: { folder?: string; token?: string; cookie?: string } = {}) => {
    const frames: Buffer[] = [];
    class Recording extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers: opts.cookie ? { cookie: opts.cookie } : {} });
        this.on("message", (data) => frames.push(Buffer.from(data as Buffer)));
      }
    }
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, new Y.Doc(), {
      WebSocketPolyfill: Recording as never,
      disableBc: true,
      params: opts.folder ? { folder: opts.folder } : {},
      protocols: opts.token ? ["devshare", "editor." + opts.token] : ["devshare"],
    });
    const notices: string[] = [];
    provider.messageHandlers[5] = (_encoder, decoder) => {
      notices.push(decoding.readVarString(decoder));
    };
    providers.push(provider);
    return { provider, frames, notices, doc: provider.doc };
  };
  const close = async () => {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    await app.close();
  };
  return { app, base, call, connect, close };
}
const text = (doc: Y.Doc, filename: string) =>
  ([...doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === filename)?.get("content") as Y.Text | undefined);
// Only Yjs sync and awareness frames (types 0 and 1) form the shared lesson. Type 4 (presence
// and activity) goes to workspace Owners and Editors only and is checked separately.
const lessonBytes = (frames: Buffer[]) => Buffer.concat(frames.filter((f) => f[0] === 0 || f[0] === 1));

test("live lessons carry only their own files: no workspace tree, folder names, other lessons' files or workspace name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-live-metadata-"));
  const s = await start(join(dir, "db.sqlite"));
  try {
    const owner = await signUp(s.base, origin, "Owner");
    const created = await s.call("/rooms", "POST", { name: "Interview prep WS-SECRET", language: "markdown", visibility: "link" }, owner.headers);
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    const folder = async (name: string, parent_id?: string) => (await s.call(`/rooms/${id}/folders`, "POST", { name, parent_id }, owner.headers)).json.id as string;
    const a = await folder("huntington FOLDER-A-SECRET"),
      b = await folder("full-detail FOLDER-B-SECRET", a),
      c = await folder("unrelated FOLDER-C-SECRET");
    const file = async (lesson: string | null, filename: string, content: string) =>
      assert.equal((await s.call(`/rooms/${id}/documents${lesson ? "?folder=" + lesson : ""}`, "POST", { filename, language: "markdown", content }, owner.headers)).status, 201);
    await file(null, "root-FILE-ROOT.md", "root text");
    await file(a, "a-FILE-A.md", "lesson A text");
    await file(b, "b-FILE-B.md", "lesson B text");
    await file(c, "c-FILE-C.md", "lesson C text");
    const token = (await s.call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token as string;
    const tree = await s.call(`/rooms/${id}/tree`);
    assert.equal(tree.status, 200);
    assert.equal(tree.json.folders.length, 3, "the tree is still served over REST");

    const lessons: [string, string | undefined, string][] = [
      ["root", undefined, "root-FILE-ROOT.md"],
      ["A", a, "a-FILE-A.md"],
      ["B", b, "b-FILE-B.md"],
      ["C", c, "c-FILE-C.md"],
    ];
    const secrets = ["WS-SECRET", "FOLDER-A-SECRET", "FOLDER-B-SECRET", "FOLDER-C-SECRET", "FILE-ROOT", "FILE-A", "FILE-B", "FILE-C"];
    for (const [label, lesson, own] of lessons)
      for (const [who, opts] of [["anonymous viewer", {}], ["Edit Link editor", { token }], ["owner", { cookie: owner.cookie }]] as const) {
        const client = s.connect(id, { folder: lesson, ...opts });
        await until(() => client.provider.synced);
        await pause(150);
        assert.ok(text(client.doc, own), `${label}/${who}: its own file is there`);
        assert.deepEqual(client.doc.getMap("catalog").toJSON(), {}, `${label}/${who}: no catalog`);
        assert.deepEqual(client.doc.getMap("workspace").toJSON(), {}, `${label}/${who}: no workspace metadata`);
        const bytes = who === "anonymous viewer" ? Buffer.concat(client.frames) : lessonBytes(client.frames);
        const ownMarker = own.split("-").slice(1).join("-").replace(".md", "");
        for (const secret of secrets.filter((x) => x !== ownMarker))
          assert.ok(!bytes.includes(secret), `${label}/${who}: received "${secret}"`);
        client.provider.destroy();
      }
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lessons saved by earlier releases are served without their embedded tree and name, with no rewrite until edited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-legacy-metadata-"));
  const dbPath = join(dir, "db.sqlite");
  let s = await start(dbPath);
  let id = "",
    a = "",
    token = "";
  try {
    const owner = await signUp(s.base, origin, "Owner");
    id = (await s.call("/rooms", "POST", { name: "Old class", language: "markdown", visibility: "link" }, owner.headers)).json.id;
    a = (await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 1" }, owner.headers)).json.id;
    assert.equal((await s.call(`/rooms/${id}/documents?folder=${a}`, "POST", { filename: "lesson.md", language: "markdown", content: "Original lesson text" }, owner.headers)).status, 201);
    token = (await s.call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token;
  } finally {
    await s.close();
  }
  // Rewrite both stored states the way the previous release saved them: with the whole
  // workspace tree ("catalog") and the workspace name ("workspace") inside the lesson.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const legacy = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    doc.getMap("catalog").set("tree", { folders: [{ id: "x", name: "LEGACY-FOLDER-SECRET" }], documents: [{ filename: "LEGACY-FILE-SECRET.md" }] });
    doc.getMap("workspace").set("name", "LEGACY-WORKSPACE-SECRET");
    return Y.encodeStateAsUpdate(doc);
  };
  db.prepare("UPDATE rooms SET state=? WHERE id=?").run(legacy(db.prepare("SELECT state FROM rooms WHERE id=?").get(id)!.state as Uint8Array), id);
  db.prepare("UPDATE folders SET state=? WHERE id=?").run(legacy(db.prepare("SELECT state FROM folders WHERE id=?").get(a)!.state as Uint8Array), a);
  const stored = () => ({
    room: db.prepare("SELECT state, updated_at FROM rooms WHERE id=?").get(id) as { state: Uint8Array; updated_at: number },
    folder: db.prepare("SELECT state, updated_at FROM folders WHERE id=?").get(a) as { state: Uint8Array; updated_at: number },
    docs: JSON.stringify(db.prepare("SELECT id, filename, content, updated_at FROM documents WHERE room_id=? ORDER BY id").all(id)),
  });
  const before = stored();
  assert.ok(Buffer.from(before.folder.state).includes("LEGACY-FOLDER-SECRET"), "the legacy state really holds the tree");
  db.close();

  s = await start(dbPath);
  try {
    for (const lesson of [undefined, a]) {
      const viewer = s.connect(id, { folder: lesson });
      await until(() => viewer.provider.synced);
      await pause(150);
      const bytes = Buffer.concat(viewer.frames);
      for (const secret of ["LEGACY-FOLDER-SECRET", "LEGACY-FILE-SECRET", "LEGACY-WORKSPACE-SECRET"])
        assert.ok(!bytes.includes(secret), `lesson ${lesson ?? "root"}: received "${secret}"`);
      assert.deepEqual([viewer.doc.getMap("catalog").toJSON(), viewer.doc.getMap("workspace").toJSON()], [{}, {}]);
      if (lesson) assert.equal(text(viewer.doc, "lesson.md")?.toString(), "Original lesson text", "saved lesson content is intact");
    }
    await pause(200); // longer than the checkpoint interval
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const loaded = {
      room: check.prepare("SELECT state, updated_at FROM rooms WHERE id=?").get(id) as { state: Uint8Array; updated_at: number },
      folder: check.prepare("SELECT state, updated_at FROM folders WHERE id=?").get(a) as { state: Uint8Array; updated_at: number },
      docs: JSON.stringify(check.prepare("SELECT id, filename, content, updated_at FROM documents WHERE room_id=? ORDER BY id").all(id)),
    };
    assert.deepEqual([Buffer.from(loaded.folder.state), loaded.folder.updated_at, Buffer.from(loaded.room.state), loaded.room.updated_at, loaded.docs], [Buffer.from(before.folder.state), before.folder.updated_at, Buffer.from(before.room.state), before.room.updated_at, before.docs], "viewing alone rewrites nothing");
    check.close();
    // The first real edit saves the lesson without the legacy metadata.
    const editor = s.connect(id, { folder: a, token });
    await until(() => editor.provider.synced);
    text(editor.doc, "lesson.md")!.insert(0, "Edited. ");
    await pause(300);
    const after = new DatabaseSync(dbPath, { readOnly: true });
    const saved = after.prepare("SELECT state FROM folders WHERE id=?").get(a)!.state as Uint8Array;
    assert.ok(!Buffer.from(saved).includes("LEGACY-FOLDER-SECRET") && !Buffer.from(saved).includes("LEGACY-WORKSPACE-SECRET"), "saved without the legacy tree");
    const content = after.prepare("SELECT content FROM documents WHERE folder_id=?").get(a)!.content;
    assert.equal(content, "Edited. Original lesson text");
    after.close();
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clients cannot write a tree or workspace name into a lesson", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-metadata-write-"));
  const s = await start(join(dir, "db.sqlite"));
  try {
    const owner = await signUp(s.base, origin, "Owner");
    const id = (await s.call("/rooms", "POST", { name: "Class", language: "markdown", visibility: "link" }, owner.headers)).json.id;
    const token = (await s.call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token;
    for (const [map, key, value] of [["catalog", "tree", { folders: [{ name: "INJECTED-TREE" }] }], ["workspace", "name", "INJECTED-NAME"]] as const) {
      const viewer = s.connect(id);
      const editor = s.connect(id, { token });
      await until(() => viewer.provider.synced && editor.provider.synced);
      const closed = new Promise<number>((resolve) =>
        editor.provider.on("connection-close", (e: { code: number } | null) => {
          if (e) {
            editor.provider.shouldConnect = false;
            resolve(e.code);
          }
        }),
      );
      editor.doc.getMap(map).set(key, value);
      assert.equal(await closed, 1008, `writing ${map} is refused`);
      await pause(150);
      assert.ok(!Buffer.concat(viewer.frames).includes(typeof value === "string" ? value : "INJECTED-TREE"), `${map}: other clients never receive it`);
      viewer.provider.destroy();
    }
    const stored = s.app.rooms.db.prepare("SELECT state FROM rooms WHERE id=?").get(id)!.state as Uint8Array;
    assert.ok(!Buffer.from(stored).includes("INJECTED"));
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tree and rename notices reach every socket of the workspace, and no other workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-notices-"));
  const s = await start(join(dir, "db.sqlite"));
  try {
    const owner = await signUp(s.base, origin, "Owner");
    const make = async (name: string) => (await s.call("/rooms", "POST", { name, language: "markdown", visibility: "link" }, owner.headers)).json.id as string;
    const id = await make("Course"),
      other = await make("Other course");
    const lesson = (await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 1" }, owner.headers)).json.id as string;
    const token = (await s.call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token;
    const root = s.connect(id),
      inLesson = s.connect(id, { folder: lesson }),
      editor = s.connect(id, { folder: lesson, token }),
      elsewhere = s.connect(other);
    await until(() => [root, inLesson, editor, elsewhere].every((c) => c.provider.synced));
    const inWorkspace = [root, inLesson, editor];
    const expectNotice = async (label: string, notice: string, action: () => Promise<{ status: number }>) => {
      const counts = inWorkspace.map((c) => c.notices.filter((n) => n === notice).length);
      const r = await action();
      assert.ok(r.status < 300, `${label}: ${r.status}`);
      await until(() => inWorkspace.every((c, i) => c.notices.filter((n) => n === notice).length > counts[i]));
    };
    let folderId = "",
      docId = "";
    await expectNotice("folder created", '{"tree":true}', async () => {
      const r = await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 2" }, owner.headers);
      folderId = r.json.id;
      return r;
    });
    await expectNotice("folder renamed", '{"tree":true}', () => s.call(`/rooms/${id}/folders/${folderId}`, "PATCH", { name: "Week Two" }, owner.headers));
    await expectNotice("folders reordered", '{"tree":true}', () => s.call(`/rooms/${id}/folders/order`, "PATCH", { ids: [folderId, lesson], parent_id: null }, owner.headers));
    await expectNotice("file created", '{"tree":true}', async () => {
      const r = await s.call(`/rooms/${id}/documents?folder=${lesson}`, "POST", { filename: "a.md", language: "markdown" }, owner.headers);
      docId = r.json.id;
      return r;
    });
    await expectNotice("file renamed", '{"tree":true}', () => s.call(`/rooms/${id}/documents/${docId}?folder=${lesson}`, "PATCH", { filename: "b.md" }, owner.headers));
    const ids = [...editor.doc.getMap<Y.Map<unknown>>("documents").keys()].reverse();
    await expectNotice("files reordered", '{"tree":true}', () => s.call(`/rooms/${id}/documents/order?folder=${lesson}`, "PATCH", { ids }, owner.headers));
    await expectNotice("file deleted", '{"tree":true}', () => s.call(`/rooms/${id}/documents/${docId}?folder=${lesson}`, "DELETE", undefined, owner.headers));
    await expectNotice("folder deleted", '{"tree":true}', () => s.call(`/rooms/${id}/folders/${folderId}`, "DELETE", undefined, owner.headers));
    await expectNotice("workspace renamed", '{"workspace":true}', () => s.call(`/rooms/${id}`, "PATCH", { name: "Renamed course" }, owner.headers));
    // Edit Link editors' own folder changes notify too.
    await expectNotice("folder created by an Edit Link editor", '{"tree":true}', () => s.call(`/rooms/${id}/folders`, "POST", { name: "Week 3" }, { authorization: "Bearer " + token }));
    await pause(150);
    assert.deepEqual(elsewhere.notices, [], "another workspace hears nothing");
    for (const c of inWorkspace) assert.ok(c.notices.every((n) => n === '{"tree":true}' || n === '{"workspace":true}'), "notices carry no data");
    assert.equal((await s.call(`/rooms/${id}`)).json.name, "Renamed course", "the name is read over REST");
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("several people edit and navigate lessons at once while the tree changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-multi-user-"));
  const s = await start(join(dir, "db.sqlite"));
  try {
    const owner = await signUp(s.base, origin, "Owner");
    const id = (await s.call("/rooms", "POST", { name: "Course", language: "markdown", visibility: "link" }, owner.headers)).json.id as string;
    const week1 = (await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 1" }, owner.headers)).json.id as string,
      week2 = (await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 2" }, owner.headers)).json.id as string;
    for (const lesson of [week1, week2])
      await s.call(`/rooms/${id}/documents?folder=${lesson}`, "POST", { filename: "notes.md", language: "markdown", content: "" }, owner.headers);
    const token = (await s.call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token;
    const ann = s.connect(id, { folder: week1, token }),
      ben = s.connect(id, { folder: week1, token }),
      ownerDoc = s.connect(id, { folder: week2, cookie: owner.cookie });
    let student = s.connect(id, { folder: week1 });
    await until(() => [ann, ben, ownerDoc, student].every((c) => c.provider.synced));
    const typing = async (who: typeof ann, prefix: string) => {
      for (let i = 0; i < 25; i++) {
        const t = text(who.doc, "notes.md")!;
        t.insert(t.length, `${prefix}${i} `);
        await pause(5);
      }
    };
    // Two editors type in the same file, the owner types in another lesson, and the tree
    // changes (new folder, rename) in the middle of it.
    await Promise.all([
      typing(ann, "A"),
      typing(ben, "B"),
      typing(ownerDoc, "O"),
      (async () => {
        await pause(30);
        await s.call(`/rooms/${id}/folders`, "POST", { name: "Week 3" }, owner.headers);
        await s.call(`/rooms/${id}/folders/${week2}`, "PATCH", { name: "Week 2 - Terraform" }, owner.headers);
      })(),
    ]);
    const week1Text = () => text(ann.doc, "notes.md")!.toString();
    await until(() => week1Text() === text(ben.doc, "notes.md")!.toString() && week1Text() === text(student.doc, "notes.md")!.toString());
    for (let i = 0; i < 25; i++) assert.ok(week1Text().includes(`A${i} `) && week1Text().includes(`B${i} `), `edit ${i} survived`);
    assert.ok(ann.notices.length >= 2 && student.notices.length >= 2, "everyone in the workspace was told the tree changed");
    // The student navigates: Week 2 (renamed meanwhile), then back to Week 1.
    student.provider.destroy();
    student = s.connect(id, { folder: week2 });
    await until(() => student.provider.synced && text(student.doc, "notes.md")?.toString() === text(ownerDoc.doc, "notes.md")!.toString());
    assert.ok(text(student.doc, "notes.md")!.toString().includes("O24 "));
    student.provider.destroy();
    student = s.connect(id, { folder: week1 });
    await until(() => student.provider.synced && text(student.doc, "notes.md")?.toString() === week1Text());
    const tree = (await s.call(`/rooms/${id}/tree`)).json as { folders: { name: string }[] };
    assert.deepEqual(tree.folders.map((f) => f.name).sort(), ["Week 1", "Week 2 - Terraform", "Week 3"]);
    // Everything is saved.
    await pause(300);
    const saved = s.app.rooms.db.prepare("SELECT folder_id, content FROM documents WHERE room_id=? AND folder_id IS NOT NULL").all(id) as { folder_id: string; content: string }[];
    assert.equal(saved.find((d) => d.folder_id === week1)!.content, week1Text());
    assert.equal(saved.find((d) => d.folder_id === week2)!.content, text(ownerDoc.doc, "notes.md")!.toString());
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
