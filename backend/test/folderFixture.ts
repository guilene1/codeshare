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

// Shared fixture for the folder-sharing tests: a Restricted workspace with a parent folder
// that holds the shared folder (with a subfolder), a sibling and an unrelated folder, each
// with a file whose name or text carries a secret that folder-only recipients must never see.

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const MISSING = "AAAAAAAAAAAAAAAA";
export const SECRETS = ["WS-SECRET", "PARENT-SECRET", "SIBLING-SECRET", "UNRELATED-SECRET", "ROOT-SECRET", "PARENT-FILE", "SIBLING-FILE"];
export async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const noSecrets = (text: string, where: string) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} reveals "${s}"`);
};

export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-folder-sharing-"));
  const dbPath = join(dir, "db.sqlite");
  // (These tests sign up a whole cast of accounts; the sign-up limit has its own tests.)
  let app = createApp({ dbPath, origins: [origin], checkpointMs: 30, authLimits: { signupPerHour: 100 } });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  // Stops the server, runs `between` on the stopped database (another release's edits), then
  // starts this release again on the same database and port. Sessions survive.
  const restart = async (between: () => void | Promise<void> = () => {}) => {
    for (const p of providers) {
      p.destroy();
      p.doc.destroy();
    }
    providers.length = 0;
    await app.close();
    await between();
    app = createApp({ dbPath, origins: [origin], checkpointMs: 30, authLimits: { signupPerHour: 100 } });
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
    // After restart() a pooled connection to the stopped server can be reset once.
    const r = await send().catch((e) => (e?.cause?.code === "ECONNRESET" ? send() : Promise.reject(e)));
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json };
  };
  const providers: WebsocketProvider[] = [];
  const connect = (id: string, opts: { folder?: string; cookie?: string; token?: string } = {}) => {
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
    const closes: number[] = [];
    provider.on("connection-close", (e: { code: number } | null) => {
      if (e) closes.push(e.code);
      if (e?.code === 1008) provider.shouldConnect = false;
    });
    providers.push(provider);
    return { provider, frames, closes, notices, doc: provider.doc };
  };
  // The HTTP status of a raw WebSocket upgrade (101 when accepted).
  const upgrade = (id: string, folder?: string, cookie?: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}${folder ? "?folder=" + folder : ""}`, ["devshare"], {
        origin,
        headers: cookie ? { cookie } : {},
      });
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
  const id = (await call("/rooms", "POST", { name: "Interview prep WS-SECRET", language: "markdown" }, owner.headers)).json.id as string;
  const folder = async (name: string, parent_id?: string) => {
    const r = await call(`/rooms/${id}/folders`, "POST", { name, parent_id }, owner.headers);
    assert.equal(r.status, 201);
    return r.json.id as string;
  };
  const parent = await folder("huntington-mlops-lead-prep PARENT-SECRET"),
    shared = await folder("full-detail-backup", parent),
    nested = await folder("nested-notes", shared),
    sibling = await folder("sibling SIBLING-SECRET", parent),
    unrelated = await folder("unrelated UNRELATED-SECRET");
  const image = async (lesson: string | null) => {
    const r = await call(`/rooms/${id}/images${lesson ? "?folder=" + lesson : ""}`, "POST", PNG, owner.headers);
    assert.equal(r.status, 201);
    return r.json.id as string;
  };
  const sharedImage = await image(shared),
    siblingImage = await image(sibling);
  const doc = async (lesson: string | null, filename: string, content: string) => {
    const r = await call(`/rooms/${id}/documents${lesson ? "?folder=" + lesson : ""}`, "POST", { filename, language: "markdown", content }, owner.headers);
    assert.equal(r.status, 201);
    return r.json.id as string;
  };
  const docs = {
    root: await doc(null, "root-ROOT-SECRET.md", "root text ROOT-SECRET"),
    parent: await doc(parent, "p-PARENT-FILE.md", "parent text PARENT-SECRET"),
    shared: await doc(shared, "s-shared.md", `# Shared notes\n\n![diagram](/api/rooms/${id}/images/${sharedImage})\n`),
    nested: await doc(nested, "n-nested.md", "nested text"),
    sibling: await doc(sibling, "sib-SIBLING-FILE.md", `sibling text\n\n![x](/api/rooms/${id}/images/${siblingImage})\n`),
    unrelated: await doc(unrelated, "u.md", "unrelated text UNRELATED-SECRET"),
  };
  const editLink = (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token as string;
  return {
    get app() {
      return app;
    },
    base, call, connect, upgrade, owner, id, parent, shared, nested, sibling, unrelated, docs, sharedImage, siblingImage, editLink, image, doc, folder, dbPath, restart,
    close: async () => {
      for (const p of providers) {
        p.destroy();
        p.doc.destroy();
      }
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
