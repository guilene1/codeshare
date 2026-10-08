import * as Y from "yjs";
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Awareness } from "y-protocols/awareness";
import type { WebSocket } from "ws";
import { equalHash, type Auth } from "./access.js";
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
  "markdown",
  "html",
  "css",
  "plaintext",
];
export const MAX_CONTENT = 512 * 1024;
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
export type Room = {
  id: string;
  workspaceId: string;
  folderId: string | null;
  name: string;
  doc: Y.Doc;
  awareness: Awareness;
  peers: Map<WebSocket, Set<number>>;
  awarenessOwners: Map<number, WebSocket>;
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
    size += Buffer.byteLength((item.get("content") as Y.Text).toString());
  }
  const blocks = orderedBlocks(doc);
  if (blocks.length > MAX_BLOCKS) throw new Error("Too many code blocks.");
  for (const block of blocks) {
    blockFields(block);
    if (!Number.isSafeInteger(block.position) || block.position < 0)
      throw new Error("Invalid block position.");
    size += Buffer.byteLength(block.content);
  }
  if (
    size > MAX_CONTENT ||
    Y.encodeStateAsUpdate(doc).byteLength > 4 * MAX_CONTENT
  )
    throw new Error(
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
    this.record(id, "workspace.created", name);
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
  record(workspaceId: string, action: string, label: string) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO activity(id,workspace_id,action,label,created_at) VALUES (?,?,?,?,?)",
      )
      .run(randomUUID(), workspaceId, action, label.slice(0, 120), now);
    this.db
      .prepare("UPDATE rooms SET updated_at=? WHERE id=?")
      .run(now, workspaceId);
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
    for (const room of this.active.values()) {
      for (const peer of room.peers.keys())
        peer.close(1001, "Server restarting");
      this.release(room);
    }
    this.db.close();
  }
}
