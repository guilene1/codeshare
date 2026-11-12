import * as Y from "yjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Awareness } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import {
  canEditAccess,
  equalHash,
  folderScope,
  lessonAccess,
  type Access,
  type Auth,
  type ShareRole,
  type Visibility,
} from "./access.js";
import { imageIds, recordImageRefs, vouchImages } from "./database.js";
import { imageInScope } from "./scope.js";
import { blockFields, MAX_BLOCKS, orderedBlocks } from "./blocks.js";
import { templates } from "./templates.js";

export const languages = [
  "hcl",
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "shell",
  "yaml",
  "json",
  "dockerfile",
  "sql",
  "powershell",
  "xml",
  "ini",
  "ruby",
  "markdown",
  "html",
  "css",
  "plaintext",
];
// Text limits, enforced the same way on REST and WebSocket writes: one file, and everything a
// lesson holds (files plus code blocks). The Yjs state may grow to 4x content (history).
export const MAX_DOCUMENT = 1024 * 1024;
export const MAX_CONTENT = 2 * 1024 * 1024;
// Rounded up, so a size just over a limit never reads as the limit itself.
export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(Math.ceil((bytes / 1024 / 1024) * 100) / 100).toFixed(2)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
export const tooLarge = (message: string) =>
  Object.assign(new Error(message), { status: 413 });
// Messages stay under the 123-byte WebSocket close-reason limit.
export const fileTooLarge = (bytes: number) =>
  tooLarge(`Files can be up to 1 MB (this one would be ${formatSize(bytes)}).`);
export const lessonTooLarge = (bytes: number) =>
  tooLarge(
    `Lessons can hold up to 2 MB of files and code blocks (this would be ${formatSize(bytes)}).`,
  );
// API text is stored with LF line endings, except in a file that already uses CRLF, which
// keeps CRLF: editors map offsets by their model's line ending, so mixing the two in one
// shared text would make open editors drift.
export const normalizeNewlines = (text: string, like = "") => {
  const lf = text.replace(/\r\n?/g, "\n");
  return like.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
};
// Content version for optimistic concurrency (If-Match / ETag).
export const contentVersion = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);
// Replaces a file's text with the smallest edit (shared prefix and suffix kept), in one
// transaction, so open editors keep their cursors and the update stays small.
export function replaceContent(room: Room, fileId: string, next: string, origin?: unknown) {
  const item = room.doc.getMap<Y.Map<unknown>>("documents").get(fileId)!;
  const text = item.get("content") as Y.Text,
    current = text.toString();
  if (current === next) return false;
  const max = Math.min(current.length, next.length);
  let start = 0;
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Never split a UTF-16 surrogate pair.
  if (start > 0 && /[\ud800-\udbff]/.test(current[start - 1])) start--;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  )
    end++;
  if (end > 0 && /[\udc00-\udfff]/.test(current[current.length - end])) end--;
  room.doc.transact(() => {
    const removed = current.length - start - end;
    if (removed > 0) text.delete(start, removed);
    const inserted = next.slice(start, next.length - end);
    if (inserted) text.insert(start, inserted);
    item.set("updatedAt", Date.now());
  }, origin);
  return true;
}
export function filename(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\w .-]{1,80}$/.test(value) ||
    value === "." ||
    value === ".." ||
    value.trim() !== value
  )
    throw new Error(
      "Use a filename of 1–80 letters, numbers, spaces, dots, dashes or underscores.",
    );
  return value;
}
export function language(value: unknown): string {
  if (typeof value !== "string" || !languages.includes(value))
    throw new Error("Choose a supported language.");
  return value;
}
// Who made a change: a verified account, or a private editor-link guest (whose
// self-entered name is never stored).
export type Actor = { kind: "user"; id: string; name: string } | { kind: "link" };
// Workspace content changes Owners and Editors see. Sharing and link management stay
// owner-only (the dashboard), so they are never sent to Editors.
export const CONTENT_ACTIONS = [
  "workspace.created",
  "workspace.renamed",
  "folder.created",
  "folder.renamed",
  "folder.deleted",
  "file.created",
  "file.edited",
  "file.renamed",
  "file.deleted",
  "block.created",
  "block.updated",
  "block.deleted",
  "blocks.migrated",
  "image",
];
export type ActivityEntry = {
  id: string;
  action: string;
  label: string;
  created_at: number;
  actor: { kind: "user"; name: string } | { kind: "link" } | null;
};
export function activityEntry(row: Record<string, unknown>): ActivityEntry {
  return {
    id: row.id as string,
    action: row.action as string,
    label: row.label as string,
    created_at: row.created_at as number,
    actor:
      row.actor_kind === "user" && typeof row.actor_name === "string"
        ? { kind: "user", name: row.actor_name }
        : row.actor_kind === "link"
          ? { kind: "link" }
          : null,
  };
}
// Consecutive edits of one file by one person within this window update a single row.
export const EDIT_WINDOW_MS = 10 * 60_000;
// One live socket, for the Owner/Editor presence summary. A share or link change closes
// the socket, so its access cannot go stale.
export type Live = {
  workspaceId: string;
  room: Room;
  // Rights in this socket's lesson (workspace access plus any folder grant on it).
  access: Access;
  // Workspace-level rights alone: "none" for a folder-only recipient. Presence and activity
  // are workspace-wide, so they follow this, never folder grants.
  workspace: Access;
  userId?: string;
  name?: string;
  // Folder-only recipients: the folders they reached when last told about the tree (IDs and
  // roles). When a sharing or team change alters it, they're told to re-read their tree.
  scopeKey?: string;
};
// A stable fingerprint of a folder scope: which folders, with which role (not their names).
export const scopeKeyOf = (scope: Map<string, ShareRole>) =>
  [...scope].map(([id, role]) => id + ":" + role).sort().join(",");
export type PresenceSummary = {
  total: number;
  users: Array<{ name: string; role: Access; you: boolean }>;
  guests: Array<{ name: string; you: boolean }>;
  anonymous: number;
};
export type Room = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  name: string;
  doc: Y.Doc;
  awareness: Awareness;
  peers: Map<WebSocket, Set<number>>;
  awarenessOwners: Map<number, WebSocket>;
  // Awareness IDs owned by view-only sockets; only Owners and Editors receive them.
  viewerIds: Set<number>;
  // Text edits since the last checkpoint, keyed by file and person.
  edits: Map<string, { fileId: string; actor?: Actor }>;
  dirty: boolean;
  touched: number;
  // Requests and connection upgrades still using this lesson (see Rooms.hold): a lesson with
  // holds or connected peers is never unloaded.
  holds: number;
  timer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
};
// How many lessons may be in memory at once: MAX_ACTIVE_LESSONS, 16 by default. Anything that
// isn't a whole number from 1 to 256 is ignored (with a warning), so a typo can't remove the
// limit or stop the server from starting.
export const DEFAULT_LESSON_LIMIT = 16;
export function lessonLimit(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_LESSON_LIMIT;
  const n = Number(value);
  if (/^\d+$/.test(value.trim()) && n >= 1 && n <= 256) return n;
  console.warn(`MAX_ACTIVE_LESSONS must be a whole number from 1 to 256; using ${DEFAULT_LESSON_LIMIT}.`);
  return DEFAULT_LESSON_LIMIT;
}
// Notices tell a client to re-read something over REST; they never carry the data itself.
export type Notice = { tree: true } | { workspace: true } | { folderShares: true };
// Everyone connected to a lesson receives that lesson's whole live document, so it holds only
// the lesson's own files, code blocks and migration flags. Workspace-wide metadata (the
// folder/file tree and the workspace name) is served over REST instead. Lessons saved by
// earlier releases still carry both as the "catalog" and "workspace" maps: they're cleared on
// load, Yjs garbage collection drops their contents, and the stored state loses them the next
// time the lesson is saved. Clients can't write them back (see the WebSocket validator).
export const LEGACY_METADATA_MAPS = ["catalog", "workspace"] as const;
export function stripWorkspaceMetadata(doc: Y.Doc) {
  doc.transact(() => {
    for (const name of LEGACY_METADATA_MAPS) {
      const map = doc.getMap(name);
      for (const key of [...map.keys()]) map.delete(key);
    }
  });
}
export function validateDocument(doc: Y.Doc) {
  const docs = doc.getMap<Y.Map<unknown>>("documents");
  if (docs.size > 64) throw new Error("A lesson supports up to 64 files.");
  let size = 0;
  for (const [id, item] of docs) {
    if (
      !(item instanceof Y.Map) ||
      item.get("id") !== id ||
      !(item.get("content") instanceof Y.Text)
    )
      throw new Error("Invalid document.");
    filename(item.get("filename"));
    language(item.get("language"));
    if (
      !Number.isSafeInteger(item.get("createdAt")) ||
      !Number.isSafeInteger(item.get("updatedAt"))
    )
      throw new Error("Invalid timestamp.");
    const bytes = Buffer.byteLength((item.get("content") as Y.Text).toString());
    if (bytes > MAX_DOCUMENT) throw fileTooLarge(bytes);
    size += bytes;
  }
  const blocks = orderedBlocks(doc);
  if (blocks.length > MAX_BLOCKS) throw new Error("Too many code blocks.");
  for (const block of blocks) {
    blockFields(block);
    if (!Number.isSafeInteger(block.position) || block.position < 0)
      throw new Error("Invalid block position.");
    size += Buffer.byteLength(block.content);
  }
  if (size > MAX_CONTENT) throw lessonTooLarge(size);
  if (Y.encodeStateAsUpdate(doc).byteLength > 4 * MAX_CONTENT)
    throw tooLarge(
      "Lesson storage limit exceeded. Export your files or create another lesson.",
    );
}
export function addDocument(
  room: Room,
  name: string,
  lang: string,
  content = "",
) {
  if (room.doc.getMap("documents").size >= 64)
    throw new Error("A lesson supports up to 64 files.");
  if (
    [...room.doc.getMap<Y.Map<unknown>>("documents").values()].some(
      (file) => file.get("filename") === name,
    )
  )
    throw new Error("A file with that name already exists in this lesson.");
  const id = randomUUID(),
    item = new Y.Map<unknown>(),
    now = Date.now();
  room.doc.transact(() => {
    item.set("id", id);
    item.set("filename", filename(name));
    item.set("language", language(lang));
    item.set("createdAt", now);
    item.set("updatedAt", now);
    item.set("position", room.doc.getMap("documents").size);
    item.set("content", new Y.Text(content));
    room.doc.getMap("documents").set(id, item);
  });
  return id;
}
export class Rooms {
  active = new Map<string, Room>();
  // Credentials behind each live socket, so revoked sessions/links can be disconnected.
  connections = new Map<WebSocket, Auth>();
  live = new Map<WebSocket, Live>();
  // Set by the WebSocket server: delivers a JSON message to one socket.
  sendJson?: (peer: WebSocket, payload: unknown) => void;
  // Set by the WebSocket server: delivers a data-free notice (message type 5) to one socket.
  sendNotice?: (peer: WebSocket, notice: Notice) => void;
  private presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Lesson capacity counters (reported by /api/metrics).
  capacity = { evictions: 0, refusals: 0, evictionFailures: 0 };
  constructor(
    public db: DatabaseSync,
    public checkpointMs = 1500,
    public maxRooms = DEFAULT_LESSON_LIMIT,
  ) {}
  // Marks a lesson as in use by a request or a connection upgrade until the returned function
  // is called (calling it again does nothing). Held lessons are never unloaded.
  hold(room: Room) {
    room.holds++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      room.holds--;
      room.touched = Date.now();
    };
  }
  private idle(room: Room) {
    return !room.peers.size && !room.holds;
  }
  // At the lesson limit: unloads the least recently used lesson that nobody is connected to and
  // nothing is using, after saving it. A lesson whose save fails stays in memory, unchanged,
  // and the next candidate is tried. Returns false when every lesson is in use.
  private makeSpace() {
    const candidates = [...this.active.values()].filter((r) => this.idle(r)).sort((a, b) => a.touched - b.touched);
    for (const room of candidates) {
      try {
        this.release(room);
        this.capacity.evictions++;
        console.info(`Lesson capacity: unloaded the least recently used idle lesson (${this.active.size + 1}/${this.maxRooms} were loaded).`);
        return true;
      } catch (error) {
        this.capacity.evictionFailures++;
        console.error("Lesson capacity: an idle lesson could not be saved, so it stays loaded.", error);
      }
    }
    return false;
  }
  create(
    name: string,
    lang: string,
    editorHash: string | null = null,
    template?: string,
    description = "",
    ownerId: string | null = null,
    actor?: Actor,
    // New workspaces are private unless the caller asks for link access.
    visibility: Visibility = "private",
  ) {
    const id = randomBytes(12).toString("base64url"),
      now = Date.now(),
      doc = new Y.Doc();
    const room = this.make(id, name, doc);
    const names: Record<string, string> = {
      hcl: "main.tf",
      python: "main.py",
      javascript: "index.js",
      typescript: "index.ts",
      java: "Main.java",
      go: "main.go",
      shell: "script.sh",
      yaml: "config.yaml",
      json: "config.json",
      dockerfile: "Dockerfile",
      sql: "query.sql",
      markdown: "notes.md",
      html: "index.html",
      css: "styles.css",
      plaintext: "untitled.txt",
    };
    const starter =
      lang === "hcl"
        ? '# Your shared Terraform workspace\n# Invite your class and start building together.\n\nresource "aws_s3_bucket" "example" {\n  bucket = "my-training-bucket"\n\n  tags = {\n    Environment = "dev"\n  }\n}\n'
        : lang === "python"
          ? 'def hello(name):\n    print(f"Hello {name}")\n\nhello("class")\n'
          : "";
    if (template === undefined) addDocument(room, names[lang], lang, starter);
    else
      for (const [file, language, content] of templates[template])
        addDocument(room, file, language, content);
    this.db
      .prepare(
        "INSERT INTO rooms (id,name,created_at,updated_at,last_activity,state,editor_token_hash,description,owner_id,visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        name,
        now,
        now,
        now,
        Y.encodeStateAsUpdate(doc),
        editorHash,
        description,
        ownerId,
        visibility,
      );
    this.save(room);
    this.record(id, "workspace.created", name, actor);
    return room;
  }
  make(
    workspaceId: string,
    name: string,
    doc: Y.Doc,
    folderId: string | null = null,
  ) {
    const id = folderId ? workspaceId + ":" + folderId : workspaceId;
    if (this.active.size >= this.maxRooms && !this.makeSpace()) {
      this.capacity.refusals++;
      console.warn(`Lesson capacity: refused to open a lesson; all ${this.maxRooms} loaded lessons are in use.`);
      throw new Error(
        "The server is at active lesson capacity. Try again shortly.",
      );
    }
    const room: Room = {
      id,
      workspaceId,
      folderId,
      name,
      doc,
      awareness: new Awareness(doc),
      peers: new Map(),
      awarenessOwners: new Map(),
      viewerIds: new Set(),
      edits: new Map(),
      dirty: false,
      touched: Date.now(),
      holds: 0,
    };
    room.awareness.setLocalState(null);
    doc.on("update", () => {
      room.dirty = true;
      room.touched = Date.now();
      if (!room.timer)
        room.timer = setTimeout(() => {
          room.timer = undefined;
          try {
            this.save(room);
          } catch (error) {
            console.error("Checkpoint failed", error);
          }
        }, this.checkpointMs);
    });
    this.active.set(id, room);
    return room;
  }
  info(id: string) {
    return this.db
      .prepare(
        "SELECT id,name,description,created_at,updated_at,owner_id,visibility,editor_token_hash IS NOT NULL AS has_editor_link FROM rooms WHERE id=?",
      )
      .get(id);
  }
  record(workspaceId: string, action: string, label: string, actor?: Actor) {
    const now = Date.now(),
      id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO activity(id,workspace_id,action,label,created_at,actor_id,actor_name,actor_kind) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        action,
        label.slice(0, 120),
        now,
        actor?.kind === "user" ? actor.id : null,
        actor?.kind === "user" ? actor.name.slice(0, 40) : null,
        actor?.kind ?? null,
      );
    this.db
      .prepare("UPDATE rooms SET updated_at=? WHERE id=?")
      .run(now, workspaceId);
    this.announce(workspaceId, action, id);
  }
  // Deny by default: only sockets tracked as Owner or Editor may receive presence,
  // activity or other viewers' awareness. Viewers and untracked sockets get none of it.
  // Workspace-wide presence and activity: workspace Owners and Editors only. A folder-only
  // recipient (even a folder Editor) and a workspace viewer never receive them.
  canSeePresence(peer: WebSocket) {
    const live = this.live.get(peer);
    return !!live && canEditAccess(live.workspace) && canEditAccess(live.access);
  }
  // Sends a new or refreshed content activity row to the workspace's Owners and Editors.
  private announce(workspaceId: string, action: string, id: string) {
    if (!this.sendJson || !CONTENT_ACTIONS.includes(action)) return;
    let row: Record<string, unknown> | undefined;
    for (const [peer, live] of this.live)
      if (live.workspaceId === workspaceId && this.canSeePresence(peer)) {
        row ??= this.db
          .prepare(
            "SELECT id,action,label,created_at,actor_name,actor_kind FROM activity WHERE id=?",
          )
          .get(id);
        if (row) this.sendJson(peer, { activity: activityEntry(row) });
      }
  }
  // One "file.edited" row per file and person per EDIT_WINDOW_MS: later edits in the window
  // only move its timestamp, so typing never writes a row per keystroke.
  private recordEdit(workspaceId: string, label: string, actor?: Actor) {
    const now = Date.now();
    const recent = this.db
      .prepare(
        "SELECT id FROM activity WHERE workspace_id=? AND created_at>? AND action='file.edited' AND label=? AND actor_kind IS ? AND actor_id IS ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(
        workspaceId,
        now - EDIT_WINDOW_MS,
        label.slice(0, 120),
        actor?.kind ?? null,
        actor?.kind === "user" ? actor.id : null,
      );
    if (!recent) {
      this.record(workspaceId, "file.edited", label, actor);
      return;
    }
    this.db
      .prepare("UPDATE activity SET created_at=? WHERE id=?")
      .run(now, recent.id);
    this.db
      .prepare("UPDATE rooms SET updated_at=? WHERE id=?")
      .run(now, workspaceId);
    this.announce(workspaceId, "file.edited", recent.id as string);
  }
  private flushEdits(room: Room) {
    const docs = room.doc.getMap<Y.Map<unknown>>("documents");
    for (const { fileId, actor } of room.edits.values()) {
      const name = docs.get(fileId)?.get("filename");
      if (typeof name === "string") this.recordEdit(room.workspaceId, name, actor);
    }
    room.edits.clear();
  }
  noteEdit(room: Room, fileId: string, actor?: Actor) {
    const who = actor?.kind === "user" ? actor.id : (actor?.kind ?? "");
    room.edits.set(fileId + "|" + who, { fileId, actor });
  }
  presence(workspaceId: string, recipient: WebSocket): PresenceSummary {
    // "none" never has a live socket (refused at the handshake); listed for completeness.
    const rank = { none: -1, viewer: 0, editor: 1, owner: 2 };
    const self = this.live.get(recipient);
    const users = new Map<string, PresenceSummary["users"][number]>(),
      guests: PresenceSummary["guests"] = [];
    let anonymous = 0;
    for (const [peer, live] of this.live) {
      if (live.workspaceId !== workspaceId) continue;
      if (live.userId) {
        // Several tabs of one account count once, at their highest role.
        const previous = users.get(live.userId);
        if (!previous || rank[live.access] > rank[previous.role])
          users.set(live.userId, {
            name: live.name ?? "Account",
            role: live.access,
            you: live.userId === self?.userId,
          });
      } else if (canEditAccess(live.access))
        guests.push({ name: live.name || "Guest editor", you: peer === recipient });
      else anonymous++;
    }
    return {
      total: users.size + guests.length + anonymous,
      users: [...users.values()].sort(
        (a, b) => rank[b.role] - rank[a.role] || a.name.localeCompare(b.name),
      ),
      guests,
      anonymous,
    };
  }
  // Coalesces bursts (a class joining at once) into one message per Owner/Editor socket.
  schedulePresence(workspaceId: string) {
    if (!this.sendJson || this.presenceTimers.has(workspaceId)) return;
    this.presenceTimers.set(
      workspaceId,
      setTimeout(() => {
        this.presenceTimers.delete(workspaceId);
        for (const [peer, live] of this.live)
          if (live.workspaceId === workspaceId && this.canSeePresence(peer))
            this.sendJson?.(peer, { presence: this.presence(workspaceId, peer) });
      }, 250),
    );
  }
  get(workspaceId: string, folderId: string | null = null) {
    const key = folderId ? workspaceId + ":" + folderId : workspaceId;
    const existing = this.active.get(key);
    if (existing) {
      existing.touched = Date.now();
      return existing;
    }
    const row = folderId
      ? this.db
          .prepare(
            "SELECT rooms.name,folders.state FROM folders JOIN rooms ON rooms.id=folders.workspace_id WHERE folders.id=? AND folders.workspace_id=?",
          )
          .get(folderId, workspaceId)
      : this.db
          .prepare("SELECT name,state FROM rooms WHERE id=?")
          .get(workspaceId);
    if (!row) return undefined;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.state as Uint8Array);
    let position = 0;
    for (const file of doc.getMap<Y.Map<unknown>>("documents").values()) {
      if (file.get("position") === undefined) file.set("position", position);
      position++;
    }
    stripWorkspaceMetadata(doc);
    return this.make(workspaceId, row.name as string, doc, folderId);
  }
  tree(workspaceId: string) {
    const folders = this.db
      .prepare(
        "SELECT id,parent_id,name,position FROM folders WHERE workspace_id=? ORDER BY position,id",
      )
      .all(workspaceId);
    const documents = this.db
      .prepare(
        "SELECT id,folder_id,filename,language,position FROM documents WHERE room_id=? ORDER BY position,id",
      )
      .all(workspaceId);
    return { folders, documents };
  }
  // The workspace's folders or files changed (created, renamed, reordered, deleted): every
  // connected socket of the workspace is told, and its client re-reads the tree over REST with
  // its own credentials. The notice itself carries no workspace data.
  // `affected` names the folders whose contents changed (null is the workspace root). Sockets
  // with workspace access always hear it. A folder-only recipient hears it only when the
  // change is inside their own folders, so the timing of notices reveals nothing about the
  // rest of the workspace.
  notifyTree(workspaceId: string, affected: (string | null)[]) {
    this.sendTree(this.treeAudience(workspaceId, affected));
  }
  // Who hears about a tree change, worked out separately so a deletion can ask before the
  // folders (and their shares) are gone: workspace members always, a folder-only recipient
  // only when an affected folder is inside their scope.
  treeAudience(workspaceId: string, affected: (string | null)[]) {
    const audience = new Set<WebSocket>();
    const scopes = new Map<string, Map<string, ShareRole>>();
    for (const [peer, live] of this.live) {
      if (live.workspaceId !== workspaceId) continue;
      if (live.workspace !== "none") {
        audience.add(peer);
        continue;
      }
      if (!live.userId) continue;
      if (!scopes.has(live.userId)) scopes.set(live.userId, folderScope(this.db, workspaceId, live.userId));
      if (affected.some((folder) => folder !== null && scopes.get(live.userId!)!.has(folder))) audience.add(peer);
    }
    return audience;
  }
  sendTree(audience: Iterable<WebSocket>) {
    if (!this.sendNotice) return;
    for (const peer of audience) {
      const live = this.live.get(peer);
      if (!live) continue;
      // Remember what a folder-only recipient was last told about, so only changes of their
      // own scope (never anyone else's sharing) lead to a later notice from revalidate().
      if (live.workspace === "none" && live.userId)
        live.scopeKey = scopeKeyOf(folderScope(this.db, live.workspaceId, live.userId));
      this.sendNotice(peer, { tree: true });
    }
  }
  notifyWorkspace(workspaceId: string, notice: Notice) {
    if (!this.sendNotice) return;
    for (const [peer, live] of this.live)
      if (live.workspaceId === workspaceId) {
        // Folder-only recipients never see the workspace name, so they aren't told it changed.
        if ("workspace" in notice && live.workspace === "none") continue;
        this.sendNotice(peer, notice);
      }
  }
  // Folder shares changed (added, re-roled, removed, or a team holding one was deleted): the
  // people who manage sharing re-read which folders are shared, so the Explorer marks in all
  // their open tabs stay current. Only current managers hear it, by the same rule as
  // res.locals.canShare (the owner, or a signed-in account with a direct workspace Editor
  // share). Folder recipients, Viewers, team-derived Editors and Edit Link guests never do.
  notifySharing(workspaceId: string) {
    if (!this.sendNotice) return;
    const direct = this.db.prepare(
      "SELECT role FROM workspace_shares WHERE workspace_id=? AND user_id=?",
    );
    for (const [peer, live] of this.live) {
      if (live.workspaceId !== workspaceId || !live.userId) continue;
      // A socket being closed by revalidate() (its rights changed) hears nothing more.
      if (peer.readyState !== peer.OPEN) continue;
      const manager =
        live.workspace === "owner" ||
        (live.workspace === "editor" &&
          direct.get(workspaceId, live.userId)?.role === "editor");
      if (manager) this.sendNotice(peer, { folderShares: true });
    }
  }
  // Closes live sockets whose credentials match (after sign-out, link revocation, deletion).
  disconnect(match: (auth: Auth) => boolean, reason: string) {
    for (const [peer, auth] of this.connections)
      if (match(auth)) peer.close(1008, reason);
  }
  // Re-checks every live socket of a workspace after an access change (general access,
  // shares) and closes those whose rights changed; they reconnect with their new rights,
  // or are refused if they no longer have any. Unaffected sockets stay connected.
  revalidate(
    workspaceId: string,
    sessionValid: (tokenHash: string, userId: string) => boolean,
    reason: string,
  ) {
    const retold: WebSocket[] = [];
    for (const [peer, auth] of this.connections) {
      if (auth.workspaceId !== workspaceId) continue;
      const live = this.live.get(peer);
      // Compared per lesson (folder grants count there) and at workspace level (presence).
      const now = lessonAccess(this.db, sessionValid, workspaceId, live?.room.folderId ?? null, auth);
      if (now.access !== live?.access || now.workspace !== live?.workspace) {
        peer.close(1008, reason);
        continue;
      }
      // Still connected, but a folder-only recipient may have gained or lost other folders
      // (a share or team change): their own tree is out of date, so they re-read it. Nobody
      // else is told anything, so sharing changes elsewhere stay invisible.
      if (live.workspace === "none" && live.userId) {
        const key = scopeKeyOf(folderScope(this.db, workspaceId, live.userId));
        if (key !== live.scopeKey) retold.push(peer);
      }
    }
    this.sendTree(retold);
  }
  // Image provenance. A link typed into a document proves nothing: anyone can paste an image
  // ID. A reference newly added to a lesson is vouched for (and so becomes visible to that
  // lesson's folder-only recipients) only when the person who added it could already see that
  // image: anyone with workspace read access, or a folder-only recipient for whom the same
  // image is already vouched inside their own folders. Anything else stays unvouched, so it
  // grants nobody new access. `canSeeAll` tells whether the actor has workspace read access;
  // it's asked only when an image link was really added (not on every keystroke).
  vouchAdded(
    room: Room,
    before: string[],
    after: string[],
    actor: { canSeeAll: () => boolean; userId?: string },
  ) {
    const existing = imageIds(room.workspaceId, before);
    const added = [...imageIds(room.workspaceId, after)].filter((id) => !existing.has(id));
    if (!added.length) return;
    const all = actor.canSeeAll();
    let scope: Map<string, ShareRole> | undefined;
    const visible = added.filter((id) => {
      if (all) return true;
      if (!actor.userId) return false;
      scope ??= folderScope(this.db, room.workspaceId, actor.userId);
      return imageInScope(this.db, room.workspaceId, id, scope);
    });
    if (visible.length) vouchImages(this.db, room.workspaceId, room.folderId, visible);
  }
  canEditHash(id: string, supplied: string | undefined) {
    if (!supplied) return false;
    return equalHash(
      this.db.prepare("SELECT editor_token_hash FROM rooms WHERE id=?").get(id)
        ?.editor_token_hash,
      supplied,
    );
  }
  save(room: Room) {
    const now = Date.now(),
      docs = room.doc.getMap<Y.Map<unknown>>("documents");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (room.folderId) {
        this.db
          .prepare(
            "UPDATE folders SET state=?,updated_at=? WHERE id=? AND workspace_id=?",
          )
          .run(
            Y.encodeStateAsUpdate(room.doc),
            now,
            room.folderId,
            room.workspaceId,
          );
        this.db
          .prepare("UPDATE rooms SET updated_at=?,last_activity=? WHERE id=?")
          .run(now, room.touched, room.workspaceId);
      } else
        this.db
          .prepare(
            "UPDATE rooms SET state=?,updated_at=?,last_activity=? WHERE id=?",
          )
          .run(
            Y.encodeStateAsUpdate(room.doc),
            now,
            room.touched,
            room.workspaceId,
          );
      this.db
        .prepare("DELETE FROM documents WHERE room_id=? AND folder_id IS ?")
        .run(room.workspaceId, room.folderId);
      const insert = this.db.prepare(
        "INSERT INTO documents (id,room_id,filename,language,content,created_at,updated_at,folder_id,position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [id, d] of docs)
        insert.run(
          id,
          room.workspaceId,
          d.get("filename") as string,
          d.get("language") as string,
          (d.get("content") as Y.Text).toString(),
          d.get("createdAt") as number,
          d.get("updatedAt") as number,
          room.folderId,
          (d.get("position") as number) ?? 0,
        );
      this.db
        .prepare(
          "DELETE FROM code_blocks WHERE workspace_id=? AND folder_id IS ?",
        )
        .run(room.workspaceId, room.folderId);
      const insertBlock = this.db.prepare(
        "INSERT INTO code_blocks (id,workspace_id,title,language,content,position,created_at,updated_at,folder_id) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const block of orderedBlocks(room.doc))
        insertBlock.run(
          block.id,
          room.workspaceId,
          block.title,
          block.language,
          block.content,
          block.position,
          block.created_at,
          block.updated_at,
          room.folderId,
        );
      // Which images this lesson's documents use (folder-scoped image access).
      recordImageRefs(
        this.db,
        room.workspaceId,
        room.folderId,
        [...docs.values()].map((d) => (d.get("content") as Y.Text).toString()),
      );
      this.db.exec("COMMIT");
      room.dirty = false;
      this.flushEdits(room);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  collect() {
    const now = Date.now();
    for (const [id, room] of this.active) {
      if (room.peers.size) {
        room.touched = now;
        this.db
          .prepare("UPDATE rooms SET last_activity=? WHERE id=?")
          .run(now, room.workspaceId);
        continue;
      }
      if (now - room.touched > 30_000 && !room.holds) {
        try {
          this.release(room);
        } catch (error) {
          // Kept in memory (still dirty); the next sweep tries again.
          console.error("Could not save an idle lesson; it stays loaded.", error);
        }
      }
    }
  }
  // Saves a lesson (when it has unsaved changes) and frees it. If the save fails nothing is
  // freed: the lesson, its changes and its pending checkpoint stay as they were.
  release(room: Room) {
    if (room.dirty) this.save(room);
    else
      this.db
        .prepare("UPDATE rooms SET last_activity=? WHERE id=?")
        .run(room.touched, room.workspaceId);
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
    room.dispose?.();
    room.awareness.destroy();
    room.awarenessOwners.clear();
    room.doc.destroy();
    this.active.delete(room.id);
  }
  close() {
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.presenceTimers.clear();
    for (const room of this.active.values()) {
      for (const peer of room.peers.keys())
        peer.close(1001, "Server restarting");
      try {
        this.release(room);
      } catch (error) {
        // One lesson that can't be saved must not keep the others from being saved.
        console.error("Could not save a lesson while shutting down.", error);
      }
    }
    this.db.close();
  }
}
