import * as Y from "yjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Awareness } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { equalHash, type Access, type Auth } from "./access.js";
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
  access: Access;
  userId?: string;
  name?: string;
};
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
  timer?: ReturnType<typeof setTimeout>;
  dispose?: () => void;
};
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
  private presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    public db: DatabaseSync,
    public checkpointMs = 1500,
    public maxRooms = 16,
  ) {}
  create(
    name: string,
    lang: string,
    editorHash: string | null = null,
    template?: string,
    description = "",
    ownerId: string | null = null,
    actor?: Actor,
  ) {
    const id = randomBytes(12).toString("base64url"),
      now = Date.now(),
      doc = new Y.Doc();
    const room = this.make(id, name, doc);
    doc.getMap("workspace").set("name", name);
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
        "INSERT INTO rooms (id,name,created_at,updated_at,last_activity,state,editor_token_hash,description,owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      );
    this.save(room);
    this.syncCatalog(id);
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
    if (this.active.size >= this.maxRooms)
      throw new Error(
        "The server is at active lesson capacity. Try again shortly.",
      );
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
        "SELECT id,name,description,created_at,updated_at,owner_id,editor_token_hash IS NOT NULL AS has_editor_link FROM rooms WHERE id=?",
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
  canSeePresence(peer: WebSocket) {
    const access = this.live.get(peer)?.access;
    return access === "owner" || access === "editor";
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
    const rank = { viewer: 0, editor: 1, owner: 2 };
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
      } else if (live.access !== "viewer")
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
    if (existing) return existing;
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
    doc.getMap("workspace").set("name", row.name);
    doc.getMap("catalog").set("tree", this.tree(workspaceId));
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
  syncCatalog(workspaceId: string) {
    const tree = this.tree(workspaceId);
    for (const room of this.active.values())
      if (room.workspaceId === workspaceId)
        room.doc.getMap("catalog").set("tree", tree);
  }
  // Closes live sockets whose credentials match (after sign-out, link revocation, deletion).
  disconnect(match: (auth: Auth) => boolean, reason: string) {
    for (const [peer, auth] of this.connections)
      if (match(auth)) peer.close(1008, reason);
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
      if (now - room.touched > 30_000) {
        this.release(room);
      }
    }
  }
  release(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    if (room.dirty) this.save(room);
    else
      this.db
        .prepare("UPDATE rooms SET last_activity=? WHERE id=?")
        .run(room.touched, room.workspaceId);
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
      this.release(room);
    }
    this.db.close();
  }
}
