import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import { createApp } from "../src/app.js";
import { lessonLimit, type Room } from "../src/rooms.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

// Lesson capacity: at most N lessons (default 16, MAX_ACTIVE_LESSONS) are in memory. When a
// new one is needed at the limit, the least recently used lesson that nobody is connected to
// and nothing is using is saved and unloaded. A lesson whose save fails stays loaded. When every
// lesson is in use, the new one is refused as before.

const CAPACITY = "The server is at active lesson capacity. Try again shortly.";
const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup(options: { maxLessons?: number; checkpointMs?: number; folders: number }) {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-capacity-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: options.checkpointMs ?? 30, maxLessons: options.maxLessons });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  // A setup failure must not leave the server running (the test would hang, not fail).
  try {
    return await prepare(app, dir, options);
  } catch (error) {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
async function prepare(app: ReturnType<typeof createApp>, dir: string, options: { folders: number }) {
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api" + path, { method, headers: { origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json };
  };
  const owner = await signUp(base, origin, "Instructor");
  const as = owner.headers;
  const id = (await call("/rooms", "POST", { name: "Capacity course", language: "markdown", visibility: "link" }, as)).json.id as string;
  // One lesson per folder, each with one file; creating them loads more lessons than the limit.
  const lessons: { folder: string; file: string }[] = [];
  for (let i = 0; i < options.folders; i++) {
    const folder = (await call(`/rooms/${id}/folders`, "POST", { name: `Week ${i}` }, as)).json.id as string;
    const r = await call(`/rooms/${id}/documents?folder=${folder}`, "POST", { filename: `week-${i}.md`, language: "markdown", content: `lesson ${i}` }, as);
    assert.equal(r.status, 201, `lesson ${i} created`);
    lessons.push({ folder, file: r.json.id });
  }
  const providers: WebsocketProvider[] = [];
  const connect = (folder?: string, cookie?: string) => {
    const status = { code: 0 };
    class Client extends WebSocket {
      constructor(url: string, p?: string | string[]) {
        super(url, p, { origin, headers: cookie ? { cookie } : {} });
        this.on("upgrade", () => (status.code = 101));
        this.on("unexpected-response", (_q, r) => (status.code = r.statusCode!));
      }
    }
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, id, new Y.Doc(), {
      WebSocketPolyfill: Client as never,
      disableBc: true,
      params: folder ? { folder } : {},
      protocols: ["devshare"],
    });
    const closes: number[] = [];
    provider.on("connection-close", (e: { code: number } | null) => e && closes.push(e.code));
    providers.push(provider);
    return { provider, status, closes, doc: provider.doc };
  };
  const loaded = (folder: string | null) => app.rooms.active.has(folder ? `${id}:${folder}` : id);
  const room = (folder: string) => app.rooms.active.get(`${id}:${folder}`) as Room;
  const read = (l: { folder: string; file: string }) => call(`/rooms/${id}/documents/${l.file}/content?folder=${l.folder}`, "GET", undefined, as);
  const saved = (file: string) => String(app.rooms.db.prepare("SELECT content FROM documents WHERE id=?").get(file)?.content);
  return {
    app, base, port, call, owner, id, lessons, connect, loaded, room, read, saved,
    close: async () => {
      for (const p of providers) {
        p.shouldConnect = false;
        p.destroy();
        p.doc.destroy();
      }
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const text = (doc: Y.Doc) => [...doc.getMap<Y.Map<unknown>>("documents").values()][0]?.get("content") as Y.Text;

test("the lesson limit is configurable (MAX_ACTIVE_LESSONS), 16 by default; bad values fall back to 16", async () => {
  assert.deepEqual(
    [undefined, "", "4", " 8 ", "256", "0", "257", "-3", "2.5", "abc", "16x"].map((v) => lessonLimit(v)),
    [16, 16, 4, 8, 256, 16, 16, 16, 16, 16, 16],
  );
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-capacity-"));
  const before = process.env.MAX_ACTIVE_LESSONS;
  try {
    delete process.env.MAX_ACTIVE_LESSONS;
    let app = createApp({ dbPath: join(dir, "a.sqlite") });
    assert.equal(app.rooms.maxRooms, 16);
    await app.close();
    process.env.MAX_ACTIVE_LESSONS = "5";
    app = createApp({ dbPath: join(dir, "b.sqlite") });
    assert.equal(app.rooms.maxRooms, 5);
    await app.close();
  } finally {
    if (before === undefined) delete process.env.MAX_ACTIVE_LESSONS;
    else process.env.MAX_ACTIVE_LESSONS = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("at the default limit: 30 students share one lesson, 16 occupied lessons refuse a 17th, a freed lesson makes space at once, and reconnecting reloads it intact", async () => {
  const s = await setup({ folders: 17 });
  const token = process.env.METRICS_TOKEN;
  process.env.METRICS_TOKEN = "capacity-metrics-token";
  try {
    assert.equal(s.app.rooms.maxRooms, 16);
    // 17 lessons were created through the API with a limit of 16: idle ones made space.
    assert.ok(s.app.rooms.capacity.evictions >= 1, "creating 17 lessons unloaded idle ones instead of failing");
    // Thirty students (anonymous, the course is open to anyone with the link) in the root lesson.
    const students = Array.from({ length: 30 }, () => s.connect());
    await until(() => students.every((c) => c.provider.synced));
    // The instructor in fifteen folder lessons: 16 lessons in use.
    const instructor = s.lessons.slice(0, 15).map((l) => s.connect(l.folder, s.owner.cookie));
    await until(() => instructor.every((c) => c.provider.synced));
    assert.equal(s.app.rooms.active.size, 16);
    assert.equal(s.app.rooms.active.get(s.id)!.peers.size, 30, "thirty students, one lesson");
    // Every lesson is in use: the 17th is refused, live and over REST, and counted.
    const refusals = s.app.rooms.capacity.refusals;
    const last = s.lessons[16];
    const refused = s.connect(last.folder, s.owner.cookie);
    await until(() => refused.status.code !== 0);
    assert.equal(refused.status.code, 503);
    refused.provider.shouldConnect = false;
    refused.provider.disconnect();
    const rest = await s.read(last);
    assert.deepEqual([rest.status, rest.json.error], [400, CAPACITY]);
    assert.ok(s.app.rooms.capacity.refusals >= refusals + 2);
    // Week 0 is edited, then its last connection closes: it becomes idle (and is saved).
    text(instructor[0].doc).insert(0, "edited before unload ");
    await until(() => s.saved(s.lessons[0].file).startsWith("edited before unload "));
    instructor[0].provider.shouldConnect = false;
    instructor[0].provider.disconnect();
    await until(() => !s.room(s.lessons[0].folder)?.peers.size);
    // Now the 17th opens at once (no 30-45 s wait): week 0 was unloaded to make space.
    const evictions = s.app.rooms.capacity.evictions;
    const opened = s.connect(last.folder, s.owner.cookie);
    await until(() => opened.provider.synced);
    assert.equal(text(opened.doc).toString(), "lesson 16");
    assert.equal(s.app.rooms.capacity.evictions, evictions + 1);
    assert.ok(!s.loaded(s.lessons[0].folder) && s.app.rooms.active.size === 16);
    // Reconnecting to week 0 after week 16 is closed: it reloads from the database, intact.
    opened.provider.shouldConnect = false;
    opened.provider.disconnect();
    await until(() => !s.room(last.folder)?.peers.size);
    const again = s.connect(s.lessons[0].folder, s.owner.cookie);
    await until(() => again.provider.synced);
    assert.equal(text(again.doc).toString(), "edited before unload lesson 0");
    // The students were never disturbed, and the metrics report capacity.
    assert.ok(students.every((c) => c.provider.wsconnected && !c.closes.length), "no student was disconnected");
    const metrics = await s.call("/metrics", "GET", undefined, { authorization: "Bearer capacity-metrics-token" });
    assert.equal(metrics.status, 200);
    assert.equal(metrics.json.lessonLimit, 16);
    assert.ok(metrics.json.lessonEvictions >= 2 && metrics.json.lessonRefusals >= 2 && metrics.json.lessonEvictionFailures === 0);
  } finally {
    if (token === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = token;
    await s.close();
  }
});

test("pending changes are saved before an idle lesson is unloaded; a lesson that can't be saved stays loaded with its changes", async () => {
  // A long checkpoint keeps changes pending (unsaved) until something saves them.
  const s = await setup({ maxLessons: 2, checkpointMs: 60_000, folders: 3 });
  const [a, b, c] = s.lessons;
  try {
    await s.read(a);
    text(s.room(a.folder).doc).insert(0, "pending A ");
    assert.ok(s.room(a.folder).dirty && !s.saved(a.file).includes("pending A"), "A has unsaved changes");
    await s.read(b);
    await s.read(c); // needs space: A is the least recently used idle lesson
    assert.ok(!s.loaded(a.folder), "A was unloaded");
    assert.equal(s.saved(a.file), "pending A lesson 0", "...after its pending change was saved");
    assert.equal((await s.read(a)).json.content, "pending A lesson 0", "reloading A shows the saved change");
    // Saving fails for B (a full disk, say). B has a pending change and is the oldest idle lesson.
    await s.read(b);
    text(s.room(b.folder).doc).insert(0, "pending B ");
    s.room(b.folder).touched = 0;
    const save = s.app.rooms.save.bind(s.app.rooms);
    let failing = true;
    s.app.rooms.save = (room: Room) => {
      if (failing && room.folderId === b.folder) throw new Error("disk full");
      save(room);
    };
    const failures = s.app.rooms.capacity.evictionFailures;
    assert.equal((await s.read(c)).status, 200, "C opens: the next idle lesson made space instead");
    assert.ok(s.loaded(b.folder) && s.room(b.folder).dirty, "B stays loaded, unsaved changes intact");
    assert.equal(s.app.rooms.capacity.evictionFailures, failures + 1);
    assert.ok(!s.saved(b.file).includes("pending B"));
    // B can't be saved and C is in use (a connection): A is refused, safely.
    const live = s.connect(c.folder, s.owner.cookie);
    await until(() => live.provider.synced);
    const refused = await s.read(a);
    assert.deepEqual([refused.status, refused.json.error], [400, CAPACITY]);
    assert.equal(text(s.room(b.folder).doc).toString(), "pending B lesson 1", "B's change is still in memory");
    // The periodic sweep doesn't crash on a failing save either.
    s.room(b.folder).touched = 0;
    s.app.rooms.collect();
    assert.ok(s.loaded(b.folder));
    // Saving works again: B is saved, then unloaded to make space.
    failing = false;
    assert.equal((await s.read(a)).status, 200);
    assert.ok(!s.loaded(b.folder));
    assert.equal(s.saved(b.file), "pending B lesson 1");
  } finally {
    await s.close();
  }
});

test("concurrent requests: a lesson a request is still using is never unloaded; parallel reads across more lessons than the limit lose nothing", async () => {
  const s = await setup({ maxLessons: 2, folders: 5 });
  const [a, b, c, d, e] = s.lessons;
  try {
    // A slow upload into A: the lesson is loaded for the request, whose body is still arriving.
    const body = JSON.stringify({ filename: "slow.md", language: "markdown", content: "uploaded slowly" });
    const response = new Promise<number>((resolve, reject) => {
      const req = request(`${s.base}/api/rooms/${s.id}/documents?folder=${a.folder}`, {
        method: "POST",
        headers: { ...s.owner.headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.write(body.slice(0, 10));
      (async () => {
        await until(() => s.loaded(a.folder) && s.room(a.folder).holds > 0);
        s.room(a.folder).touched = 0; // the least recently used, but in use
        await s.read(b);
        await s.read(c); // must unload B, not A
        assert.ok(s.loaded(a.folder) && !s.loaded(b.folder), "A (in use) kept; B unloaded");
        await s.read(d); // unloads C
        assert.ok(s.loaded(a.folder) && !s.loaded(c.folder));
        const live = s.connect(d.folder, s.owner.cookie);
        await until(() => live.provider.synced);
        const refused = await s.read(e); // A in use, D connected: refused
        assert.deepEqual([refused.status, refused.json.error], [400, CAPACITY]);
        live.provider.shouldConnect = false;
        live.provider.disconnect();
        await until(() => !s.room(d.folder)?.peers.size);
        req.end(body.slice(10));
      })().catch(reject);
    });
    assert.equal(await response, 201, "the slow upload completed");
    const created = s.app.rooms.db.prepare("SELECT id,content FROM documents WHERE filename='slow.md'").get();
    assert.equal(created?.content, "uploaded slowly", "...and was saved");
    // Forty parallel reads over five lessons with room for two: each one either reads the right
    // text or is refused with the capacity message; nothing fails otherwise.
    const reads = await Promise.all(Array.from({ length: 40 }, (_, i) => s.lessons[i % 5]).map(async (l) => [l, await s.read(l)] as const));
    let ok = 0;
    for (const [l, r] of reads) {
      if (r.status === 200) {
        ok++;
        assert.equal(r.json.content, `lesson ${s.lessons.indexOf(l)}`);
      } else assert.deepEqual([r.status, r.json.error], [400, CAPACITY]);
    }
    assert.ok(ok >= 10, `${ok} of 40 parallel reads served`);
    // Afterwards every lesson's text is intact.
    for (const [i, l] of s.lessons.entries()) assert.equal((await s.read(l)).json.content, `lesson ${i}`);
    assert.ok(s.app.rooms.active.size <= 2);
  } finally {
    await s.close();
  }
});
