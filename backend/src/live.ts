import express from "express";
import rateLimit from "express-rate-limit";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";
import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canEditAccess, equalHash, hashEditorToken, lessonAccess, TOKEN_PATTERN } from "./access.js";
import { newToken, validEmail, type Accounts, type Session } from "./auth.js";
import { vouchImages } from "./database.js";
import { Images, LIVE_IMAGE_TABLES, MAX_IMAGE_BYTES } from "./images.js";
import type { Channel } from "./lessonView.js";
import type { LinkVault } from "./linkVault.js";
import type { Locks } from "./locks.js";
import { validateLessonCapacity } from "./blocks.js";
import {
  addDocument,
  fileTooLarge,
  filename,
  language,
  MAX_CONTENT,
  MAX_DOCUMENT,
  normalizeNewlines,
  type Rooms,
} from "./rooms.js";
import { acceptAwareness, checkUpdate, MESSAGE_JSON, noticeMessage, send, wireChannel } from "./websocket.js";

// Live Coding sessions: an instructor (and invited collaborators) write code and notes that
// viewers watch arrive in real time, through an unguessable, revocable link.
//
// A session has its own live document (files like a lesson, same limits and editor protocol) and
// its own images; it is never part of a workspace. It may be associated with a workspace folder:
// then that folder's locks apply to everyone but the session's managers, and "Save to Workspace"
// copies the session's files there, under the destination's own sharing and lock rules.
//
// States: draft (only the owner and collaborators), live, paused (viewers keep what they had at
// the pause; nothing new reaches them until it resumes, then they catch up exactly), ended
// (read-only; viewers keep access only if the owner allowed it) and archived (owner and
// collaborators only). Content survives restarts (saved like lessons, every 1.5 s while edited).
export type LiveStatus = "draft" | "live" | "paused" | "ended" | "archived";
export type ViewerAccess = "anyone" | "signed_in" | "invited";
type Role = "owner" | "editor" | "viewer";
const STATUSES = ["draft", "live", "paused", "ended", "archived"] as const;
const ACCESS = ["anyone", "signed_in", "invited"] as const;
const SESSION_ID = /^[A-Za-z0-9_-]{16}$/;
const FILE_ID = /^[\w-]{36}$/;
const LIVE_IMAGE = /\/api\/live\/([A-Za-z0-9_-]{16})\/images\/([A-Za-z0-9_-]{22})/g;
// Allowed status changes (anything else is refused).
const TRANSITIONS: Record<LiveStatus, LiveStatus[]> = {
  draft: ["live", "archived"],
  live: ["paused", "ended"],
  paused: ["live", "ended"],
  ended: ["live", "paused", "archived"],
  archived: ["ended"],
};
type Row = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  workspace_id: string | null;
  folder_id: string | null;
  status: LiveStatus;
  viewer_access: ViewerAccess;
  after_end: "closed" | "available";
  allow_download: number;
  link_hash: string | null;
  link_sealed: string | null;
  link_expires_at: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
};
type Grant = { role: Role; via: "owner" | "member" | "link" };
export type Denied = { status: number; error: string; state?: LiveStatus; locked?: boolean; releaseAt?: number | null };
type Peer = { role: Role; via: Grant["via"]; userId?: string; name?: string; tokenHash?: string; sessionHash?: string };
const httpError = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });

export class LiveRoom implements Channel {
  lineage = "main";
  doc: Y.Doc;
  awareness: Awareness;
  peers = new Map<WebSocket, Set<number>>();
  awarenessOwners = new Map<number, WebSocket>();
  viewerIds = new Set<number>();
  dispose?: () => void;
  who = new Map<WebSocket, Peer>();
  dirty = false;
  touched = Date.now();
  holds = 0;
  timer?: ReturnType<typeof setTimeout>;
  // While paused: what viewers have (they are answered from it and catch up on resume).
  frozen?: Y.Doc;
  presenceTimer?: ReturnType<typeof setTimeout>;
  constructor(
    public id: string,
    state: Uint8Array,
    public status: LiveStatus,
  ) {
    this.doc = new Y.Doc();
    Y.applyUpdate(this.doc, state);
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null);
  }
  // A viewer receives live changes only while the session is live.
  broadcasts(peer: WebSocket) {
    const who = this.who.get(peer);
    return !!who && (who.role !== "viewer" || this.status === "live");
  }
  // The document a peer is synced from (viewers: the frozen copy while paused).
  source(peer: WebSocket) {
    return this.who.get(peer)?.role === "viewer" && this.frozen ? this.frozen : this.doc;
  }
}

export class LiveSessions {
  active = new Map<string, LiveRoom>();
  images: Images;
  refusals = 0;
  constructor(
    public db: DatabaseSync,
    private accounts: Accounts,
    private links: LinkVault,
    private locks: Locks,
    public options: { maxSessions: number; maxViewers: number; checkpointMs: number },
  ) {
    this.images = new Images(db, LIVE_IMAGE_TABLES);
  }
  row(id: string) {
    return SESSION_ID.test(id) ? (this.db.prepare("SELECT * FROM live_sessions WHERE id=?").get(id) as Row | undefined) : undefined;
  }
  memberRole(id: string, userId: string | undefined) {
    if (!userId) return undefined;
    return this.db.prepare("SELECT role FROM live_session_members WHERE session_id=? AND user_id=?").get(id, userId)?.role as
      | "editor"
      | "viewer"
      | undefined;
  }
  tokenHashOf(token: string | undefined) {
    return token && TOKEN_PATTERN.test(token) ? hashEditorToken(token) : undefined;
  }
  linkValid(row: Row, tokenHash: string | undefined, now = Date.now()) {
    return !!tokenHash && equalHash(row.link_hash, tokenHash) && (!row.link_expires_at || now < row.link_expires_at);
  }
  // Who may open a session, and as what: the owner; an invited collaborator (Editor); a viewer
  // through the link (as the session's viewer access allows) or an invitation. Then the session's
  // state and the associated folder's locks decide whether there is anything to see.
  access(row: Row, auth: { userId?: string; sessionHash?: string; tokenHash?: string }): Grant | Denied {
    const signedIn = !!auth.userId && !!auth.sessionHash && this.accounts.sessionValid(auth.sessionHash, auth.userId);
    const userId = signedIn ? auth.userId : undefined;
    if (userId && row.owner_id === userId) return { role: "owner", via: "owner" };
    const member = this.memberRole(row.id, userId);
    const link = this.linkValid(row, auth.tokenHash);
    let grant: Grant | undefined;
    if (member === "editor") grant = { role: "editor", via: "member" };
    else if (member === "viewer") grant = { role: "viewer", via: "member" };
    else if (link && (row.viewer_access === "anyone" || (row.viewer_access === "signed_in" && userId)))
      grant = { role: "viewer", via: "link" };
    if (!grant) {
      if (link && row.viewer_access === "signed_in")
        return { status: 401, error: "Sign in to your Kodelumi account to watch this session." };
      if (link && row.viewer_access === "invited")
        return { status: 403, error: "This session is only for invited people. Sign in with the account you were invited with." };
      return { status: 404, error: "Live session not found. The link may have been replaced, revoked or expired." };
    }
    // The associated folder's locks: nobody but the managers opens a session for locked content.
    if (row.workspace_id && this.locks.any(row.workspace_id)) {
      const snapshot = this.locks.snapshot(row.workspace_id);
      const folder = row.folder_id && snapshot.parents.has(row.folder_id) ? row.folder_id : null;
      const state = snapshot.folderState(folder);
      const owner =
        !!userId && this.db.prepare("SELECT 1 FROM rooms WHERE id=? AND owner_id=?").get(row.workspace_id, userId) !== undefined;
      if (state.locked && !this.locks.exempt(snapshot, { userId, owner }, folder))
        return {
          status: 423,
          error: "This session belongs to content that is still locked. It opens when your instructor releases it.",
          locked: true,
          releaseAt: state.own?.releaseAt ?? null,
        };
    }
    if (grant.role === "viewer") {
      if (row.status === "draft")
        return { status: 409, error: "This session hasn't started yet. It opens when your instructor goes live.", state: "draft" };
      if (row.status === "archived" || (row.status === "ended" && row.after_end !== "available"))
        return { status: 410, error: "This session has ended.", state: row.status };
    }
    return grant;
  }
  canWrite(row: Row, grant: Grant) {
    return grant.role !== "viewer" && row.status !== "ended" && row.status !== "archived";
  }
  // ---- Loading and saving (like lessons: bounded, idle sessions unloaded, saves debounced).
  load(id: string) {
    const existing = this.active.get(id);
    if (existing) {
      existing.touched = Date.now();
      return existing;
    }
    const row = this.db.prepare("SELECT state,status,paused_state FROM live_sessions WHERE id=?").get(id);
    if (!row) return undefined;
    if (this.active.size >= this.options.maxSessions && !this.makeSpace()) {
      this.refusals++;
      throw httpError("The server is at live session capacity. Try again shortly.", 503);
    }
    const room = new LiveRoom(id, row.state as Uint8Array, row.status as LiveStatus);
    // Paused: viewers get what they had at the pause, kept across restarts.
    if (room.status === "paused") {
      room.frozen = new Y.Doc();
      Y.applyUpdate(room.frozen, (row.paused_state as Uint8Array | null) ?? Y.encodeStateAsUpdate(room.doc));
    }
    room.doc.on("update", () => {
      room.dirty = true;
      room.touched = Date.now();
      if (!room.timer)
        room.timer = setTimeout(() => {
          room.timer = undefined;
          try {
            this.save(room);
          } catch (error) {
            console.error("Live session checkpoint failed", error);
          }
        }, this.options.checkpointMs);
    });
    this.active.set(id, room);
    return room;
  }
  private makeSpace() {
    const idle = [...this.active.values()].filter((r) => !r.peers.size && !r.holds).sort((a, b) => a.touched - b.touched);
    for (const room of idle) {
      try {
        this.release(room);
        return true;
      } catch (error) {
        console.error("An idle live session could not be saved, so it stays loaded.", error);
      }
    }
    return false;
  }
  save(room: LiveRoom) {
    this.db
      .prepare("UPDATE live_sessions SET state=?,updated_at=? WHERE id=?")
      .run(Y.encodeStateAsUpdate(room.doc), Date.now(), room.id);
    room.dirty = false;
  }
  release(room: LiveRoom) {
    if (room.dirty) this.save(room);
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
    clearTimeout(room.presenceTimer);
    room.dispose?.();
    room.awareness.destroy();
    room.frozen?.destroy();
    room.doc.destroy();
    this.active.delete(room.id);
  }
  collect() {
    const now = Date.now();
    for (const room of [...this.active.values()]) {
      // Links that expired meanwhile: their viewers are disconnected.
      if (room.peers.size) {
        room.touched = now;
        const row = this.row(room.id);
        if (row) this.revalidate(row, "This session link has expired.");
        continue;
      }
      if (now - room.touched > 30_000 && !room.holds)
        try {
          this.release(room);
        } catch (error) {
          console.error("Could not save an idle live session; it stays loaded.", error);
        }
    }
  }
  close() {
    for (const room of [...this.active.values()]) {
      for (const peer of room.peers.keys()) peer.close(1001, "Server restarting");
      try {
        this.release(room);
      } catch (error) {
        console.error("Could not save a live session while shutting down.", error);
      }
    }
  }
  // Re-checks every socket of a session (link replaced or revoked, member removed, settings or
  // state changed, locks changed) and closes those whose access changed.
  revalidate(row: Row, reason: string) {
    const room = this.active.get(row.id);
    if (!room) return;
    for (const [peer, who] of room.who) {
      const now = this.access(row, { userId: who.userId, sessionHash: who.sessionHash, tokenHash: who.tokenHash });
      if (!("role" in now) || now.role !== who.role)
        peer.close(4002, ("error" in now ? now.error : reason).slice(0, 120));
    }
  }
  // A workspace's locks changed (or it was deleted): sessions associated with it re-check.
  workspaceChanged(workspaceId: string) {
    for (const room of this.active.values()) {
      const row = this.row(room.id);
      if (row && row.workspace_id === workspaceId) this.revalidate(row, "This session's content was locked.");
    }
  }
  workspaceDeleted(workspaceId: string) {
    void workspaceId;
  }
  notifyAll(room: LiveRoom, notice: unknown) {
    const message = noticeMessage(notice);
    for (const peer of room.peers.keys()) send(peer, message);
  }
  // Viewer counts and collaborators, for the owner and collaborators only (coalesced).
  schedulePresence(room: LiveRoom) {
    if (room.presenceTimer) return;
    room.presenceTimer = setTimeout(() => {
      room.presenceTimer = undefined;
      let viewers = 0;
      const editors = new Map<string, { name: string; role: Role }>();
      for (const who of room.who.values()) {
        if (who.role === "viewer") viewers++;
        else editors.set(who.userId ?? Math.random().toString(), { name: who.name ?? "Collaborator", role: who.role });
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_JSON);
      encoding.writeVarString(enc, JSON.stringify({ live: { viewers, editors: [...editors.values()], status: room.status } }));
      const message = encoding.toUint8Array(enc);
      for (const [peer, who] of room.who) if (who.role !== "viewer") send(peer, message);
    }, 250);
  }
  // Status changes reach every socket at once; viewers that may no longer watch are closed.
  setStatus(row: Row, next: LiveStatus) {
    const room = this.active.get(row.id);
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE live_sessions SET status=?,updated_at=?,started_at=COALESCE(started_at, CASE WHEN ?='live' THEN ? END),ended_at=CASE WHEN ?='ended' THEN ? WHEN ?='live' THEN NULL ELSE ended_at END WHERE id=?",
      )
      .run(next, now, next, now, next, now, next, row.id);
    if (!room) {
      // Not loaded: nothing changes while unloaded, so the pause snapshot is the stored state.
      this.db
        .prepare(next === "paused" ? "UPDATE live_sessions SET paused_state=state WHERE id=? AND paused_state IS NULL" : "UPDATE live_sessions SET paused_state=NULL WHERE id=?")
        .run(row.id);
      return;
    }
    const was = room.status;
    room.status = next;
    if (next === "paused" && !room.frozen) {
      room.frozen = cloneDoc(room.doc);
      this.db.prepare("UPDATE live_sessions SET paused_state=? WHERE id=?").run(Y.encodeStateAsUpdate(room.frozen), row.id);
    }
    if (next !== "paused" && room.frozen) {
      // Viewers catch up with exactly what changed while paused.
      const missed = Y.encodeStateAsUpdate(room.doc, Y.encodeStateVector(room.frozen));
      room.frozen.destroy();
      room.frozen = undefined;
      this.db.prepare("UPDATE live_sessions SET paused_state=NULL WHERE id=?").run(row.id);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      sync.writeUpdate(enc, missed);
      const message = encoding.toUint8Array(enc);
      for (const [peer, who] of room.who) if (who.role === "viewer") send(peer, message);
    }
    this.notifyAll(room, { live: { status: next, was } });
    this.revalidate({ ...row, status: next }, "This session has ended.");
    this.schedulePresence(room);
  }
  metrics() {
    return {
      loaded: this.active.size,
      limit: this.options.maxSessions,
      refusals: this.refusals,
      connections: [...this.active.values()].reduce((sum, room) => sum + room.peers.size, 0),
      viewerLimit: this.options.maxViewers,
    };
  }
  // ---- Live connection: /ws/live/<id>. The session cookie, and the link as a subprotocol
  // ("live.<token>") for link viewers. Viewers never write; changes are checked like lessons.
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer) {
    const match = /^\/ws\/live\/([A-Za-z0-9_-]{16})$/.exec((req.url ?? "").split("?")[0]);
    if (!match) return false;
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((v) => v.trim());
      const token = protocols.find((p) => p.startsWith("live."))?.slice(5);
      const session = this.accounts.session(this.accounts.tokenFrom(req));
      const auth = { userId: session?.user.id, sessionHash: session?.tokenHash, tokenHash: this.tokenHashOf(token) };
      const row = this.row(match[1]);
      const grant = row ? this.access(row, auth) : undefined;
      if (!row || !grant || !("role" in grant)) {
        refuse("404 Not Found");
        return true;
      }
      const room = this.load(row.id);
      if (!room) {
        refuse("404 Not Found");
        return true;
      }
      if (grant.role === "viewer" && [...room.who.values()].filter((w) => w.role === "viewer").length >= this.options.maxViewers) {
        refuse("503 Service Unavailable");
        return true;
      }
      room.holds++;
      let held = true;
      const unhold = () => {
        if (held) room.holds--;
        held = false;
      };
      socket.once("close", unhold);
      wss.handleUpgrade(req, socket, head, (peer) => {
        unhold();
        this.join(room, peer, {
          role: grant.role,
          via: grant.via,
          userId: session?.user.id,
          name: session?.user.displayName.slice(0, 40),
          tokenHash: auth.tokenHash,
          sessionHash: session?.tokenHash,
        });
      });
    } catch {
      refuse("503 Service Unavailable");
    }
    return true;
  }
  private join(room: LiveRoom, peer: WebSocket, who: Peer) {
    wireChannel(room, (p) => room.who.get(p)?.role !== "viewer", (p) => room.broadcasts(p));
    room.peers.set(peer, new Set());
    room.who.set(peer, who);
    room.touched = Date.now();
    this.schedulePresence(room);
    send(peer, noticeMessage({ live: { status: room.status } }));
    let alive = true,
      count = 0,
      frames = 0,
      windowStart = Date.now();
    peer.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return peer.terminate();
      alive = false;
      peer.ping();
    }, 30_000);
    peer.on("message", (raw, isBinary) => {
      try {
        if (!isBinary) throw new Error("Binary messages required");
        if (Date.now() - windowStart > 1000) {
          windowStart = Date.now();
          count = 0;
          frames = 0;
        }
        if (++frames > 2000) throw new Error("Too many messages");
        const row = this.row(room.id);
        const now = row ? this.access(row, { userId: who.userId, sessionHash: who.sessionHash, tokenHash: who.tokenHash }) : undefined;
        if (!row || !now || !("role" in now) || now.role !== who.role) throw new Error("Your access to this session changed.");
        const dec = decoding.createDecoder(new Uint8Array(raw as Buffer)),
          type = decoding.readVarUint(dec);
        if (type !== 1 && ++count > 120) throw new Error("Too many updates");
        if (type === 0) {
          const subtype = decoding.readVarUint(dec);
          if (subtype === 0) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 0);
            sync.writeSyncStep2(enc, room.source(peer), decoding.readVarUint8Array(dec));
            send(peer, encoding.toUint8Array(enc));
          } else if (subtype === 1 || subtype === 2) {
            if (!this.canWrite(row, now)) throw new Error("View-only access: session changes are not permitted");
            const data = decoding.readVarUint8Array(dec);
            const { changed } = checkUpdate(room.doc, data);
            Y.applyUpdate(room.doc, data, peer);
            const files = room.doc.getMap<Y.Map<unknown>>("documents");
            room.doc.transact(() => {
              for (const id of changed) files.get(id)?.set("updatedAt", Date.now());
            });
          } else throw new Error("Unsupported sync message");
        } else if (type === 1) {
          if (acceptAwareness(room, peer, decoding.readVarUint8Array(dec), who.role !== "viewer", who.name) && ++count > 120)
            throw new Error("Too many updates");
        } else if (type === 3) {
          const ids = [...room.awareness.getStates().keys()].filter(
            (id) => who.role !== "viewer" || !room.viewerIds.has(id) || room.awarenessOwners.get(id) === peer,
          );
          if (ids.length) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 1);
            encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids));
            send(peer, encoding.toUint8Array(enc));
          }
        }
      } catch (error) {
        console.warn("Rejected live session update:", (error as Error).message);
        peer.close(1008, (error as Error).message.slice(0, 100));
      }
    });
    peer.on("error", () => peer.terminate());
    peer.on("close", () => {
      clearInterval(heartbeat);
      const ids = room.peers.get(peer);
      for (const id of ids ?? []) room.awarenessOwners.delete(id);
      room.peers.delete(peer);
      room.who.delete(peer);
      awarenessProtocol.removeAwarenessStates(room.awareness, [...(ids ?? [])], null);
      room.touched = Date.now();
      this.schedulePresence(room);
      if (!room.peers.size && room.dirty)
        try {
          this.save(room);
        } catch (error) {
          console.error("Could not save a live session after its last connection closed.", error);
        }
    });
    // Editors are asked for their state (offline edits); viewers only pull.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    sync.writeSyncStep1(enc, room.source(peer));
    if (who.role !== "viewer") send(peer, encoding.toUint8Array(enc));
    const states = [...room.awareness.getStates().keys()].filter((id) => who.role !== "viewer" || !room.viewerIds.has(id));
    if (states.length) {
      const msg = encoding.createEncoder();
      encoding.writeVarUint(msg, 1);
      encoding.writeVarUint8Array(msg, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(peer, encoding.toUint8Array(msg));
    }
  }
  // ---- Links. Shown again to the owner from its sealed copy (never logged or stored in clear).
  newLink(id: string, expiresAt: number | null) {
    const token = newToken();
    this.db
      .prepare("UPDATE live_sessions SET link_hash=?,link_sealed=?,link_expires_at=?,updated_at=? WHERE id=?")
      .run(hashEditorToken(token), this.links.seal("live:" + id, token), expiresAt, Date.now(), id);
    return token;
  }
  openLink(row: Row) {
    return this.links.open("live:" + row.id, row.link_sealed, row.link_hash) ?? null;
  }
}

function cloneDoc(doc: Y.Doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

// ---- REST API.
export function liveRoutes(
  app: express.Express,
  live: LiveSessions,
  deps: {
    rooms: Rooms;
    accounts: Accounts;
    workspaceImages: Images;
    locks: Locks;
    record: (workspaceId: string, action: string, label: string, actor: { kind: "user"; id: string; name: string }) => void;
  },
) {
  const db = live.db;
  const changes = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many changes right now. Wait a moment and try again." },
  });
  const sessionOf = (res: express.Response) => res.locals.session as Session | undefined;
  const bearer = (req: express.Request) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const files = (room: LiveRoom) =>
    [...room.doc.getMap<Y.Map<unknown>>("documents").values()]
      .map((item) => ({
        id: item.get("id") as string,
        filename: item.get("filename") as string,
        language: item.get("language") as string,
        position: (item.get("position") as number) ?? 0,
        content: (item.get("content") as Y.Text).toString(),
      }))
      .sort((a, b) => a.position - b.position);
  const summary = (row: Row, role: Role) => {
    const workspace = row.workspace_id
      ? (db.prepare("SELECT id,name FROM rooms WHERE id=?").get(row.workspace_id) as { id: string; name: string } | undefined)
      : undefined;
    const folder = row.folder_id
      ? (db.prepare("SELECT id,name FROM folders WHERE id=?").get(row.folder_id) as { id: string; name: string } | undefined)
      : undefined;
    const manager = role !== "viewer";
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      role,
      allowDownload: row.allow_download === 1,
      ownerName: (db.prepare("SELECT display_name FROM users WHERE id=?").get(row.owner_id)?.display_name as string) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      // Workspace details only for the people who run the session.
      ...(manager
        ? {
            viewerAccess: row.viewer_access,
            afterEnd: row.after_end,
            hasLink: !!row.link_hash,
            linkExpiresAt: row.link_expires_at,
            workspace: workspace ?? null,
            folder: folder ?? null,
          }
        : {}),
    };
  };
  // Resolves the session and the caller's access, or answers the refusal.
  const resolve = (req: express.Request, res: express.Response, need: "view" | "write" | "owner" = "view") => {
    const row = live.row(String(req.params.sessionId));
    const session = sessionOf(res);
    const auth = { userId: session?.user.id, sessionHash: session?.tokenHash, tokenHash: live.tokenHashOf(bearer(req)) };
    const grant = row ? live.access(row, auth) : undefined;
    if (!row || !grant || !("role" in grant)) {
      const denied = grant && !("role" in grant) ? grant : undefined;
      res
        .status(denied?.status ?? 404)
        .json({ error: denied?.error ?? "Live session not found.", ...(denied?.state ? { state: denied.state } : {}), ...(denied?.locked ? { locked: true, releaseAt: denied.releaseAt } : {}) });
      return undefined;
    }
    if (need === "owner" && grant.role !== "owner") {
      res.status(403).json({ error: "Only the session's owner can do that." });
      return undefined;
    }
    if (need === "write" && !live.canWrite(row, grant)) {
      res.status(403).json({
        error: grant.role === "viewer" ? "This session is view-only." : "This session has ended. Reopen it to make changes.",
      });
      return undefined;
    }
    return { row, grant, session };
  };
  const withRoom = <T>(row: Row, use: (room: LiveRoom) => T) => {
    const room = live.load(row.id)!;
    room.holds++;
    try {
      return use(room);
    } finally {
      room.holds--;
      room.touched = Date.now();
    }
  };
  const validName = (value: unknown, label: string, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw httpError(`${label} must be 1–${max} characters.`);
    return value.trim();
  };
  // A workspace folder the caller may associate with (or save into): they must be able to edit
  // it, through their own account.
  const destination = (session: Session, workspaceId: unknown, folderId: unknown) => {
    if (typeof workspaceId !== "string" || !/^[\w-]{16}$/.test(workspaceId)) throw httpError("Choose a workspace.", 400);
    if (folderId !== null && folderId !== undefined && (typeof folderId !== "string" || !FILE_ID.test(folderId)))
      throw httpError("Choose a folder.", 400);
    const folder = (folderId as string | null | undefined) ?? null;
    if (folder && !db.prepare("SELECT 1 FROM folders WHERE id=? AND workspace_id=?").get(folder, workspaceId))
      throw httpError("Folder not found.", 404);
    const rights = lessonAccess(
      db,
      (hash, user) => deps.accounts.sessionValid(hash, user),
      workspaceId,
      folder,
      { userId: session.user.id, sessionHash: session.tokenHash },
    );
    if (rights.access === "none") throw httpError("Workspace not found.", 404);
    if (!canEditAccess(rights.access)) throw httpError("You can only use workspaces and folders you can edit.", 403);
    return { workspaceId, folderId: folder, owner: rights.workspace === "owner" };
  };
  app.use("/api/live", (req, res, next) => {
    if (req.path === "/" || req.path === "") return next();
    const id = req.path.split("/")[1];
    if (id && id !== "access" && !SESSION_ID.test(id)) {
      res.status(404).json({ error: "Live session not found." });
      return;
    }
    next();
  });
  // My sessions (owned) and the ones I collaborate on or was invited to.
  app.get("/api/live", (_req, res) => {
    const session = sessionOf(res);
    if (!session) {
      res.status(401).json({ error: "Sign in to see your live sessions." });
      return;
    }
    const rows = db
      .prepare(
        `SELECT s.*, CASE WHEN s.owner_id=? THEN 'owner' ELSE m.role END AS my_role FROM live_sessions s
         LEFT JOIN live_session_members m ON m.session_id=s.id AND m.user_id=?
         WHERE s.owner_id=? OR m.user_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 200`,
      )
      .all(session.user.id, session.user.id, session.user.id) as Array<Row & { my_role: Role }>;
    res.json({
      sessions: rows.map((row) => ({
        ...summary(row, row.my_role === "owner" ? "owner" : row.my_role === "editor" ? "editor" : "viewer"),
        viewers: [...(live.active.get(row.id)?.who.values() ?? [])].filter((w) => w.role === "viewer").length,
      })),
    });
  });
  app.post(
    "/api/live",
    rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }),
    (req, res) => {
      const session = sessionOf(res);
      if (!session) {
        res.status(401).json({ error: "Sign in to create a live session." });
        return;
      }
      const body = (req.body ?? {}) as Record<string, any>;
      const name = validName(body.name, "Session names", 80);
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 400) : "";
      const viewerAccess = body.viewerAccess ?? "anyone";
      if (!ACCESS.includes(viewerAccess)) throw httpError("Choose who can watch this session.");
      let workspaceId: string | null = null,
        folderId: string | null = null;
      if (body.workspaceId) ({ workspaceId, folderId } = destination(session, body.workspaceId, body.folderId));
      const collaborators: string[] = Array.isArray(body.collaborators) ? body.collaborators.slice(0, 20) : [];
      const people = collaborators.map((email) => {
        const user = db.prepare("SELECT id FROM users WHERE email=?").get(validEmail(email));
        if (!user) throw httpError(`No Kodelumi account uses ${String(email).slice(0, 80)}.`, 404);
        return user.id as string;
      });
      const id = randomBytes(12).toString("base64url"),
        now = Date.now(),
        doc = new Y.Doc();
      doc.getMap("documents");
      db.prepare(
        "INSERT INTO live_sessions (id,owner_id,name,description,workspace_id,folder_id,status,viewer_access,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'draft',?,?,?,?)",
      ).run(id, session.user.id, name, description, workspaceId, folderId, viewerAccess, Y.encodeStateAsUpdate(doc), now, now);
      doc.destroy();
      for (const userId of people)
        if (userId !== session.user.id)
          db.prepare("INSERT OR IGNORE INTO live_session_members (session_id,user_id,role,created_by,created_at) VALUES (?,?,'editor',?,?)").run(
            id,
            userId,
            session.user.id,
            now,
          );
      const token = live.newLink(id, null);
      res.status(201).json({ id, token });
    },
  );
  // A viewer's way in: the link alone (Bearer), which says which session it opens.
  app.get("/api/live/access", (req, res) => {
    const tokenHash = live.tokenHashOf(bearer(req));
    const row = tokenHash ? (db.prepare("SELECT * FROM live_sessions WHERE link_hash=?").get(tokenHash) as Row | undefined) : undefined;
    const session = sessionOf(res);
    const grant = row ? live.access(row, { userId: session?.user.id, sessionHash: session?.tokenHash, tokenHash }) : undefined;
    if (!row || !grant || !("role" in grant)) {
      const denied = grant && !("role" in grant) ? grant : undefined;
      res.status(denied?.status ?? 404).json({
        error: denied?.error ?? "Live session not found. The link may have been replaced, revoked or expired.",
        ...(denied?.state && row ? { state: denied.state, name: row.name } : {}),
        ...(denied?.locked ? { locked: true, releaseAt: denied.releaseAt } : {}),
      });
      return;
    }
    res.json(summary(row, grant.role));
  });
  app.get("/api/live/:sessionId", (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    const extra =
      found.grant.role === "owner"
        ? {
            members: db
              .prepare(
                "SELECT m.user_id AS userId,u.display_name AS displayName,u.email,m.role FROM live_session_members m JOIN users u ON u.id=m.user_id WHERE m.session_id=? ORDER BY m.created_at",
              )
              .all(found.row.id),
          }
        : {};
    res.json({ ...summary(found.row, found.grant.role), ...extra });
  });
  app.patch("/api/live/:sessionId", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    const body = (req.body ?? {}) as Record<string, any>;
    const row = found.row;
    const next = {
      name: body.name !== undefined ? validName(body.name, "Session names", 80) : row.name,
      description: body.description !== undefined ? String(body.description).trim().slice(0, 400) : row.description,
      viewer_access: body.viewerAccess ?? row.viewer_access,
      after_end: body.afterEnd ?? row.after_end,
      allow_download: body.allowDownload !== undefined ? (body.allowDownload ? 1 : 0) : row.allow_download,
      workspace_id: row.workspace_id,
      folder_id: row.folder_id,
      link_expires_at: row.link_expires_at,
    };
    if (!ACCESS.includes(next.viewer_access)) throw httpError("Choose who can watch this session.");
    if (next.after_end !== "closed" && next.after_end !== "available") throw httpError("Choose what viewers see after the session ends.");
    if (body.workspaceId !== undefined) {
      if (body.workspaceId === null) {
        next.workspace_id = null;
        next.folder_id = null;
      } else {
        const dest = destination(found.session!, body.workspaceId, body.folderId);
        next.workspace_id = dest.workspaceId;
        next.folder_id = dest.folderId;
      }
    }
    if (body.linkExpiresAt !== undefined) {
      if (body.linkExpiresAt !== null && (!Number.isSafeInteger(body.linkExpiresAt) || body.linkExpiresAt <= Date.now()))
        throw httpError("Choose an expiry time in the future.");
      next.link_expires_at = body.linkExpiresAt;
    }
    db.prepare(
      "UPDATE live_sessions SET name=?,description=?,viewer_access=?,after_end=?,allow_download=?,workspace_id=?,folder_id=?,link_expires_at=?,updated_at=? WHERE id=?",
    ).run(
      next.name,
      next.description,
      next.viewer_access,
      next.after_end,
      next.allow_download,
      next.workspace_id,
      next.folder_id,
      next.link_expires_at,
      Date.now(),
      row.id,
    );
    const updated = live.row(row.id)!;
    live.revalidate(updated, "This session's settings changed.");
    const room = live.active.get(row.id);
    if (room) live.notifyAll(room, { live: { settings: true } });
    res.json(summary(updated, "owner"));
  });
  app.post("/api/live/:sessionId/status", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    const next = req.body?.status as LiveStatus;
    if (!STATUSES.includes(next)) throw httpError("Choose a session state.");
    if (next === found.row.status) {
      res.json(summary(found.row, "owner"));
      return;
    }
    if (!TRANSITIONS[found.row.status].includes(next))
      throw httpError(`A ${found.row.status} session can't become ${next}.`, 409);
    live.setStatus(found.row, next);
    res.json(summary(live.row(found.row.id)!, "owner"));
  });
  app.delete("/api/live/:sessionId", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    const room = live.active.get(found.row.id);
    if (room) {
      for (const peer of room.peers.keys()) peer.close(4002, "This session was deleted.");
      room.dirty = false;
      live.release(room);
    }
    db.prepare("DELETE FROM live_sessions WHERE id=?").run(found.row.id);
    res.json({ ok: true });
  });
  // The session link: shown again to its owner, replaced or revoked (viewers using the old link
  // are disconnected at once).
  app.get("/api/live/:sessionId/link", (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    res.json({ token: live.openLink(found.row), expiresAt: found.row.link_expires_at });
  });
  app.post("/api/live/:sessionId/link", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    const expires = req.body?.expiresAt ?? null;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= Date.now())) throw httpError("Choose an expiry time in the future.");
    const token = live.newLink(found.row.id, expires);
    live.revalidate(live.row(found.row.id)!, "The session link was replaced.");
    res.status(201).json({ token, expiresAt: expires });
  });
  app.delete("/api/live/:sessionId/link", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    db.prepare("UPDATE live_sessions SET link_hash=NULL,link_sealed=NULL,link_expires_at=NULL,updated_at=? WHERE id=?").run(Date.now(), found.row.id);
    live.revalidate(live.row(found.row.id)!, "The session link was revoked.");
    res.json({ ok: true });
  });
  // Invited people: collaborators (Editor) and, for invite-only sessions, viewers.
  const memberList = (id: string) =>
    db
      .prepare(
        "SELECT m.user_id AS userId,u.display_name AS displayName,u.email,m.role FROM live_session_members m JOIN users u ON u.id=m.user_id WHERE m.session_id=? ORDER BY m.created_at",
      )
      .all(id);
  app.post("/api/live/:sessionId/members", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    const role = req.body?.role ?? "editor";
    if (role !== "editor" && role !== "viewer") throw httpError("Choose Editor or Viewer.");
    const user = db.prepare("SELECT id FROM users WHERE email=?").get(validEmail(req.body?.email));
    if (!user) throw httpError("No Kodelumi account uses that email.", 404);
    if (user.id === found.row.owner_id) throw httpError("You already run this session.");
    db.prepare(
      "INSERT INTO live_session_members (session_id,user_id,role,created_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id,user_id) DO UPDATE SET role=excluded.role",
    ).run(found.row.id, user.id as string, role, found.session!.user.id, Date.now());
    live.revalidate(found.row, "Your access to this session changed.");
    res.status(201).json({ members: memberList(found.row.id) });
  });
  app.delete("/api/live/:sessionId/members/:userId", changes, (req, res) => {
    const found = resolve(req, res, "owner");
    if (!found) return;
    db.prepare("DELETE FROM live_session_members WHERE session_id=? AND user_id=?").run(found.row.id, String(req.params.userId));
    live.revalidate(found.row, "Your access to this session changed.");
    res.json({ members: memberList(found.row.id) });
  });
  // Files: created, renamed, reordered and deleted here; their text changes live.
  app.post("/api/live/:sessionId/files", changes, (req, res) => {
    const found = resolve(req, res, "write");
    if (!found) return;
    const body = (req.body ?? {}) as Record<string, any>;
    if (body.content !== undefined && typeof body.content !== "string") throw httpError("File content must be text.");
    const content = normalizeNewlines(body.content ?? "");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DOCUMENT) throw fileTooLarge(bytes);
    const id = withRoom(found.row, (room) => {
      if (content) validateLessonCapacity(room, content);
      const created = addDocument(room, filename(body.filename), language(body.language), content);
      live.save(room);
      return created;
    });
    res.status(201).json({ id });
  });
  app.patch("/api/live/:sessionId/files-order", changes, (req, res) => {
    const found = resolve(req, res, "write");
    if (!found) return;
    withRoom(found.row, (room) => {
      const docs = room.doc.getMap<Y.Map<unknown>>("documents"),
        ids = req.body?.ids;
      if (!Array.isArray(ids) || ids.length !== docs.size || new Set(ids).size !== docs.size || ids.some((id) => !docs.has(id)))
        throw httpError("Provide every file in this session exactly once.");
      room.doc.transact(() => ids.forEach((id: string, position: number) => docs.get(id)!.set("position", position)));
      live.save(room);
    });
    res.json({ ok: true });
  });
  app.patch("/api/live/:sessionId/files/:fileId", changes, (req, res) => {
    const found = resolve(req, res, "write");
    if (!found) return;
    const result = withRoom(found.row, (room) => {
      const docs = room.doc.getMap<Y.Map<unknown>>("documents");
      const item = docs.get(String(req.params.fileId));
      if (!item) return false;
      const name = req.body?.filename !== undefined ? filename(req.body.filename) : undefined;
      const lang = req.body?.language !== undefined ? language(req.body.language) : undefined;
      if (name && [...docs].some(([id, other]) => id !== req.params.fileId && other.get("filename") === name))
        throw httpError("A file with that name already exists in this session.");
      room.doc.transact(() => {
        if (name) item.set("filename", name);
        if (lang) item.set("language", lang);
        item.set("updatedAt", Date.now());
      });
      live.save(room);
      return true;
    });
    if (!result) res.status(404).json({ error: "File not found." });
    else res.json({ ok: true });
  });
  app.delete("/api/live/:sessionId/files/:fileId", changes, (req, res) => {
    const found = resolve(req, res, "write");
    if (!found) return;
    const removed = withRoom(found.row, (room) => {
      const docs = room.doc.getMap("documents");
      if (!docs.has(String(req.params.fileId))) return false;
      docs.delete(String(req.params.fileId));
      live.save(room);
      return true;
    });
    if (!removed) res.status(404).json({ error: "File not found." });
    else res.json({ ok: true });
  });
  // Images of the session (viewers load them with their link: see the frontend's imageSrc).
  app.get("/api/live/:sessionId/images/:imageId", (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    live.images.serve(found.row.id, String(req.params.imageId), res, req.headers["if-none-match"]);
  });
  // The body is read only after the access check, so nobody else makes the server parse it.
  app.post(
    "/api/live/:sessionId/images",
    rateLimit({ windowMs: 10 * 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }),
    (req, res, next) => {
      const found = resolve(req, res, "write");
      if (!found) return;
      res.locals.liveSession = found.row.id;
      next();
    },
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.status(201).json(live.images.store(res.locals.liveSession as string, data));
    },
  );
  // ---- Save to Workspace: copies the session's files (and their images) into a workspace
  // folder the caller can edit, optionally into a new (or existing, same-name) subfolder. Never
  // overwrites unless asked to replace, never publishes locked content (a locked destination is
  // refused for people locks restrict there; "lock" locks what was saved), and leaves the
  // session as it is.
  app.post("/api/live/:sessionId/save", changes, (req, res) => {
    const found = resolve(req, res, "view");
    if (!found) return;
    if (found.grant.role === "viewer" || !found.session) {
      res.status(403).json({ error: "Only the session's owner and collaborators can save it to a workspace." });
      return;
    }
    const session = found.session;
    const body = (req.body ?? {}) as Record<string, any>;
    const conflict = body.conflict ?? "rename";
    if (!["rename", "skip", "replace"].includes(conflict)) throw httpError("Choose what happens to files with the same name.");
    const dest = destination(session, body.workspaceId, body.folderId);
    const snapshot = deps.locks.any(dest.workspaceId) ? deps.locks.snapshot(dest.workspaceId) : undefined;
    const who = { userId: session.user.id, owner: dest.owner };
    const exempt = (folder: string | null) => !snapshot || deps.locks.exempt(snapshot, who, folder);
    if (snapshot && !exempt(dest.folderId) && snapshot.folderState(dest.folderId).locked)
      throw httpError("That folder is locked. Ask the person who manages its locks, or choose another folder.", 423);
    // Locking what is saved needs lock management rights there.
    if (
      body.lock &&
      !deps.locks.canManage(
        snapshot ?? deps.locks.snapshot(dest.workspaceId),
        who,
        dest.folderId ? "folder" : "workspace",
        dest.folderId ?? dest.workspaceId,
      )
    )
      throw httpError("You can't lock content in that folder.", 403);
    // The destination lesson: the chosen folder, or a subfolder of it (reused if it exists).
    let target = dest.folderId;
    let createdFolder: string | null = null;
    if (body.subfolder) {
      const name = filename(body.subfolder);
      const existing = db
        .prepare("SELECT id FROM folders WHERE workspace_id=? AND parent_id IS ? AND name=?")
        .get(dest.workspaceId, dest.folderId, name)?.id as string | undefined;
      if (existing) {
        if (snapshot && !exempt(existing) && snapshot.folderState(existing).locked)
          throw httpError("That folder is locked. Choose another folder.", 423);
        target = existing;
      } else {
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM folders WHERE workspace_id=?").get(dest.workspaceId)?.n) >= 256)
          throw httpError("A course supports up to 256 lesson folders.");
        let depth = 0;
        for (let ancestor = dest.folderId; ancestor; ) {
          if (++depth >= 12) throw httpError("Folders support up to 12 levels.");
          ancestor = db.prepare("SELECT parent_id FROM folders WHERE id=?").get(ancestor)?.parent_id as string | null;
        }
        createdFolder = target = randomUUID();
      }
    }
    const sessionFiles = withRoom(found.row, (room) => files(room));
    if (!sessionFiles.length) throw httpError("This session has no files to save yet.");
    if (createdFolder) {
      const now = Date.now(),
        empty = new Y.Doc();
      empty.getMap("documents");
      const position = Number(
        db.prepare("SELECT COUNT(*) AS n FROM folders WHERE workspace_id=? AND parent_id IS ?").get(dest.workspaceId, dest.folderId)?.n,
      );
      db.prepare(
        "INSERT INTO folders(id,workspace_id,parent_id,name,position,created_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?)",
      ).run(createdFolder, dest.workspaceId, dest.folderId, filename(body.subfolder), position, now, now, Y.encodeStateAsUpdate(empty));
      empty.destroy();
      deps.record(dest.workspaceId, "folder.created", filename(body.subfolder), { kind: "user", id: session.user.id, name: session.user.displayName });
    }
    const room = deps.rooms.get(dest.workspaceId, target);
    if (!room) throw httpError("Folder not found.", 404);
    const release = deps.rooms.hold(room);
    try {
      const docs = room.doc.getMap<Y.Map<unknown>>("documents");
      const names = new Map([...docs.values()].map((item) => [item.get("filename") as string, item.get("id") as string]));
      // Plan first (names, limits), then write, so a refusal changes nothing.
      const plan: Array<{ name: string; language: string; content: string; replace?: string }> = [];
      const skipped: string[] = [];
      for (const file of sessionFiles) {
        let name = file.filename;
        const clash = names.get(name);
        if (clash) {
          const clashLocked = snapshot && !exempt(target) && snapshot.fileState(clash, target).locked;
          if (conflict === "skip" || (conflict === "replace" && clashLocked)) {
            skipped.push(name);
            continue;
          }
          if (conflict === "rename") {
            const dot = name.lastIndexOf(".");
            const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
            for (let n = 2; names.has(name); n++) name = filename(`${base.slice(0, 70)}-${n}${ext}`);
          }
        }
        plan.push({ name, language: file.language, content: file.content, ...(clash && conflict === "replace" ? { replace: clash } : {}) });
        names.set(name, "planned");
      }
      const added = plan.filter((p) => !p.replace).length;
      if (docs.size + added > 64) throw httpError(`That folder can hold ${64 - docs.size} more files; this session has ${added}.`);
      let total = 0;
      for (const [id, item] of docs)
        if (!plan.some((p) => p.replace === id)) total += Buffer.byteLength((item.get("content") as Y.Text).toString());
      for (const p of plan) total += Buffer.byteLength(p.content);
      if (total > MAX_CONTENT) throw httpError("Those files don't fit in that folder (2 MB per folder). Choose another folder.", 413);
      // Images are copied into the workspace and the links in the text follow them.
      const copied = new Map<string, string>();
      for (const p of plan)
        p.content = p.content.replace(LIVE_IMAGE, (link, sessionId: string, imageId: string) => {
          if (sessionId !== found.row.id) return link;
          if (!copied.has(imageId)) {
            const bytes = live.images.bytes(found.row.id, imageId);
            if (!bytes) return link;
            copied.set(imageId, deps.workspaceImages.store(dest.workspaceId, bytes).id);
          }
          return `/api/rooms/${dest.workspaceId}/images/${copied.get(imageId)}`;
        });
      if (copied.size) vouchImages(db, dest.workspaceId, target, copied.values());
      const saved: Array<{ id: string; filename: string }> = [];
      for (const p of plan) {
        if (p.replace) {
          const item = docs.get(p.replace)!;
          const text = item.get("content") as Y.Text;
          room.doc.transact(() => {
            text.delete(0, text.length);
            text.insert(0, p.content);
            item.set("updatedAt", Date.now());
          });
          saved.push({ id: p.replace, filename: p.name });
        } else saved.push({ id: addDocument(room, p.name, p.language, p.content), filename: p.name });
      }
      deps.rooms.save(room);
      const actor = { kind: "user" as const, id: session.user.id, name: session.user.displayName };
      if (body.lock) {
        const now = Date.now();
        const insert = db.prepare(
          "INSERT OR IGNORE INTO content_locks (workspace_id,target_kind,target_id,visibility,created_by,created_at,updated_at) VALUES (?,?,?,'visible',?,?,?)",
        );
        if (createdFolder) insert.run(dest.workspaceId, "folder", createdFolder, session.user.id, now, now);
        else for (const file of saved) insert.run(dest.workspaceId, "file", file.id, session.user.id, now, now);
        for (const item of createdFolder ? [{ kind: "folder" as const, id: createdFolder, name: filename(body.subfolder) }] : saved.map((f) => ({ kind: "file" as const, id: f.id, name: f.filename })))
          deps.locks.record(dest.workspaceId, item, "locked", "Locked when saved from a live session", actor);
      }
      deps.record(dest.workspaceId, "live.saved", `${found.row.name}: ${saved.length} file${saved.length === 1 ? "" : "s"}`, actor);
      deps.rooms.notifyTree(dest.workspaceId, [dest.folderId, target]);
      if (body.lock || snapshot) deps.locks.changed(dest.workspaceId);
      res.status(201).json({ saved, skipped, folderId: target, workspaceId: dest.workspaceId });
    } finally {
      release();
    }
  });
}
