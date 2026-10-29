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
  // Additive: the Edit Link sealed for later retrieval (see linkVault.ts); NULL for links
  // created before it existed, which keep working but cannot be shown again.
  if (!columns.some((column) => column.name === "editor_token_sealed"))
    db.exec("ALTER TABLE rooms ADD COLUMN editor_token_sealed TEXT");
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
  // v2 accounts: additive tables. Secrets are stored only as hashes.
  db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      password_changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );`);
  // Persistent email outbox: one row per (user, kind, recipient) so a signup can never
  // produce duplicate emails, and pending rows survive restarts.
  db.exec(`CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, recipient TEXT NOT NULL COLLATE NOCASE, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      last_error TEXT, message_id TEXT, created_at INTEGER NOT NULL, sent_at INTEGER,
      UNIQUE (user_id, kind, recipient)
    );
    CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);`);
  // Legacy workspaces keep owner_id NULL until claimed with their editor link.
  if (
    !db
      .prepare("PRAGMA table_info(rooms)")
      .all()
      .some((column) => column.name === "owner_id")
  )
    db.exec("ALTER TABLE rooms ADD COLUMN owner_id TEXT REFERENCES users(id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS rooms_owner ON rooms(owner_id, updated_at DESC)",
  );
  // Inline document images (additive). Original bytes in 256 KB chunks; deleting a
  // workspace removes its images.
  db.exec(`CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS images_workspace ON images(workspace_id);
    CREATE TABLE IF NOT EXISTS image_chunks (
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (image_id, seq)
    );`);
  // Account shares (additive): a workspace explicitly shared with a registered user shows
  // in their Shared with Me list. Public viewer links and editor links are unaffected.
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_shares (
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS shares_user ON workspace_shares(user_id, updated_at DESC);`);
  // Activity attribution (additive, nullable): older rows stay unattributed. actor_kind is
  // 'user' for a signed-in account or 'link' for a private editor-link guest.
  const activityColumns = db.prepare("PRAGMA table_info(activity)").all();
  if (!activityColumns.some((column) => column.name === "actor_id"))
    db.exec(
      "ALTER TABLE activity ADD COLUMN actor_id TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
  if (!activityColumns.some((column) => column.name === "actor_name"))
    db.exec("ALTER TABLE activity ADD COLUMN actor_name TEXT");
  if (!activityColumns.some((column) => column.name === "actor_kind"))
    db.exec("ALTER TABLE activity ADD COLUMN actor_kind TEXT");
  return db;
}
