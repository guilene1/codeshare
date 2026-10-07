import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, state BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_activity ON rooms(last_activity);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_blocks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      title TEXT NOT NULL, language TEXT NOT NULL, content TEXT NOT NULL,
      position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS blocks_workspace ON code_blocks(workspace_id, position);
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE, name TEXT NOT NULL,
      position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS folders_workspace ON folders(workspace_id, parent_id, position);`);
  db.exec(`CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    action TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS activity_workspace ON activity(workspace_id, created_at DESC);`);
  // Additive migration: legacy public links stay readable, never gain editor rights.
  const columns = db.prepare("PRAGMA table_info(rooms)").all();
  if (!columns.some((column) => column.name === "editor_token_hash"))
    db.exec("ALTER TABLE rooms ADD COLUMN editor_token_hash TEXT");
  if (!columns.some((column) => column.name === "description"))
    db.exec(
      "ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  for (const table of ["documents", "code_blocks"]) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!existing.some((column) => column.name === "folder_id"))
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE`,
      );
    if (
      table === "documents" &&
      !existing.some((column) => column.name === "position")
    )
      db.exec(
        "ALTER TABLE documents ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
      );
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS documents_course ON documents(room_id, folder_id, position)",
  );
  return db;
}
