import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as decoding from "lib0/decoding";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

// Fixture for the content-lock tests: "March 2027 DevOps Class" with weekly folders. Week 01
// holds a public introduction and lab solutions whose text carries SOLUTION-SECRET; Week 03 has
// a nested "Labs" folder. The workspace is "Anyone with the link" (anonymous students), with an
// Edit Link (guest editor), a workspace Editor share and a Viewer share (a TA).
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const SECRET = "SOLUTION-SECRET";
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => boolean, ms = 5000, label = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out waiting for " + label);
    await pause(20);
  }
}
export const fileNames = (doc: Y.Doc) =>
  [...doc.getMap<Y.Map<unknown>>("documents").values()].map((f) => f.get("filename") as string).sort();
export const fileText = (doc: Y.Doc, name: string) => {
  for (const f of doc.getMap<Y.Map<unknown>>("documents").values())
    if (f.get("filename") === name) return (f.get("content") as Y.Text).toString();
  return undefined;
};

export async function lockSetup(options: { env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-locks-"));
  const dbPath = join(dir, "db.sqlite");
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(options.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const make = () => createApp({ dbPath, origins: [origin], checkpointMs: 30, authLimits: { signupPerHour: 100 } });
  let app = make();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const providers: WebsocketProvider[] = [];
  const restart = async (between: () => void | Promise<void> = () => {}) => {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    providers.length = 0;
    await app.close();
    await between();
    app = make();
    await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
  };
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const raw = Buffer.isBuffer(body);
    const send = () =>
      fetch(base + "/api" + path, {
        method,
        headers: { origin, "content-type": raw ? "image/png" : "application/json", ...headers },
        body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
      });
    const r = await send().catch((e) => (["ECONNRESET", "UND_ERR_SOCKET"].includes(e?.cause?.code) ? send() : Promise.reject(e)));
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json };
  };
  // A live connection that behaves like the current web client: it starts with doc=new, then
  // remembers which copy it holds ({doc} notice) and sends it on every reconnect. On 4001 it
  // starts over with a fresh document (as the app does); `resets` counts those.
  const connect = (
    id: string,
    opts: { folder?: string; cookie?: string; token?: string; legacy?: boolean; path?: string; protocols?: string[] } = {},
  ) => {
    const frames: Buffer[] = [];
    const state = {
      provider: undefined as unknown as WebsocketProvider,
      closes: [] as number[],
      reasons: [] as string[],
      notices: [] as any[],
      resets: 0,
      get doc() {
        return state.provider.doc;
      },
    };
    const open = () => {
      class Recording extends WebSocket {
        constructor(url: string, p?: string | string[]) {
          super(url, p, { origin, headers: opts.cookie ? { cookie: opts.cookie } : {} });
          this.on("message", (data) => frames.push(Buffer.from(data as Buffer)));
        }
      }
      const provider = new WebsocketProvider(`ws://127.0.0.1:${port}${opts.path ?? "/ws"}`, id, new Y.Doc(), {
        WebSocketPolyfill: Recording as never,
        disableBc: true,
        params: { ...(opts.folder ? { folder: opts.folder } : {}), ...(opts.legacy ? {} : { doc: "new" }) },
        protocols: opts.protocols ?? (opts.token ? ["devshare", "editor." + opts.token] : ["devshare"]),
      });
      provider.messageHandlers[5] = (_encoder, decoder) => {
        const notice = JSON.parse(decoding.readVarString(decoder));
        state.notices.push(notice);
        if (typeof notice.doc === "string") provider.params = { ...provider.params, doc: notice.doc };
      };
      provider.on("connection-close", (e: { code: number; reason: string } | null) => {
        if (!e) return;
        state.closes.push(e.code);
        state.reasons.push(e.reason);
        if (e.code === 1008 || e.code === 4002) provider.shouldConnect = false;
        if (e.code === 4001 && provider === state.provider) {
          provider.shouldConnect = false;
          state.resets++;
          setTimeout(() => {
            provider.destroy();
            provider.doc.destroy();
            open();
          }, 10);
        }
      });
      providers.push(provider);
      state.provider = provider;
    };
    open();
    return Object.assign(state, { frames });
  };
  // The HTTP status of a raw WebSocket upgrade (101 when accepted).
  const upgrade = (path: string, cookie?: string, protocols = ["devshare"]) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { origin, headers: cookie ? { cookie } : {} });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("unexpected-response", (_q, r) => {
        resolve(r.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
  const owner = await signUp(base, origin, "Owner");
  const editor = await signUp(base, origin, "Editor");
  const ta = await signUp(base, origin, "Teaching Assistant");
  const student = await signUp(base, origin, "Student");
  const id = (await call("/rooms", "POST", { name: "March 2027 DevOps Class", language: "markdown", visibility: "link" }, owner.headers)).json
    .id as string;
  await call(`/rooms/${id}/shares`, "POST", { email: editor.email, role: "editor" }, owner.headers);
  await call(`/rooms/${id}/shares`, "POST", { email: ta.email, role: "viewer" }, owner.headers);
  await call(`/rooms/${id}/shares`, "POST", { email: student.email, role: "viewer" }, owner.headers);
  const folder = async (name: string, parent_id?: string) => {
    const r = await call(`/rooms/${id}/folders`, "POST", { name, parent_id }, owner.headers);
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };
  const doc = async (lesson: string | null, filename: string, content: string, language = "markdown") => {
    const r = await call(`/rooms/${id}/documents${lesson ? "?folder=" + lesson : ""}`, "POST", { filename, language, content }, owner.headers);
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };
  const week1 = await folder("Week 01 - Linux"),
    week2 = await folder("Week 02 - Networking"),
    week3 = await folder("Week 03 - Git"),
    labs = await folder("Labs", week3);
  const files = {
    intro: await doc(week1, "Introduction.md", "# Linux\nWelcome to week 1."),
    solutions: await doc(week1, "Lab-solutions.sh", `#!/bin/bash\necho ${SECRET}\n`, "shell"),
    networking: await doc(week2, "Networking.md", "# Networking"),
    git: await doc(week3, "Git.md", "# Git"),
    lab: await doc(labs, "Lab.md", "# Lab"),
    root: await doc(null, "Syllabus.md", "# Syllabus"),
  };
  const editLink = (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token as string;
  const lock = (targets: Array<{ kind: string; id?: string }>, action: string, extra: Record<string, unknown> = {}, as = owner.headers) =>
    call(`/rooms/${id}/locks`, "PUT", { targets, action, ...extra }, as);
  return {
    get app() {
      return app;
    },
    base,
    port,
    call,
    connect,
    upgrade,
    restart,
    lock,
    owner,
    editor,
    ta,
    student,
    id,
    week1,
    week2,
    week3,
    labs,
    files,
    editLink,
    doc,
    folder,
    dbPath,
    close: async () => {
      for (const p of providers) {
        p.destroy();
        p.doc.destroy();
      }
      await app.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
