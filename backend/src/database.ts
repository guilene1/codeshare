import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Image links inside documents look like /api/rooms/<workspace>/images/<image>. Only images
// that really belong to the same workspace are recorded.
const IMAGE_LINK = /\/api\/rooms\/([A-Za-z0-9_-]{16})\/images\/([A-Za-z0-9_-]{22})/g;
export function imageIds(workspaceId: string, texts: string[]) {
  const ids = new Set<string>();
  for (const text of texts)
    for (const [, workspace, image] of text.matchAll(IMAGE_LINK)) if (workspace === workspaceId) ids.add(image);
  return ids;
}
// Brings one lesson's image references in line with its documents. References that are new
// here start unvouched (vouched=0): a link typed into a document proves nothing about who may
// see the image. Only vouchImages (an upload, or a link added by someone who could already see
// the image) makes a reference grant access to folder-only recipients. References the lesson
// still uses keep their flag; the rest are removed.
export function recordImageRefs(
  db: DatabaseSync,
  workspaceId: string,
  folderId: string | null,
  texts: string[],
  vouched = false,
) {
  const ids = imageIds(workspaceId, texts);
  let removed = 0,
    added = 0;
  const remove = db.prepare("DELETE FROM image_refs WHERE image_id=? AND workspace_id=? AND folder_id IS ?");
  for (const row of db
    .prepare("SELECT image_id FROM image_refs WHERE workspace_id=? AND folder_id IS ?")
    .all(workspaceId, folderId) as { image_id: string }[])
    if (!ids.has(row.image_id)) removed += Number(remove.run(row.image_id, workspaceId, folderId).changes);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO image_refs (image_id, workspace_id, folder_id, vouched) SELECT id, workspace_id, ?, ? FROM images WHERE id=? AND workspace_id=?",
  );
  for (const id of ids) added += Number(insert.run(folderId, vouched ? 1 : 0, id, workspaceId).changes);
  return { removed, added };
}
// Startup check after a rollback and roll-forward. The previous release edits documents
// without maintaining image references, so a lesson it changed can have references that no
// longer match its documents. Every lesson is brought in line with its saved documents, and
// only ever in the restrictive direction:
// - a reference whose link is gone is removed (nobody keeps access through a deleted link);
// - a link without a reference is recorded UNVOUCHED. Who placed it can't be known (the
//   previous release didn't record it), so it grants folder-only recipients nothing, exactly
//   like an image ID pasted by someone who couldn't see the image;
// - a reference that is still used keeps its flag, so provenance recorded by this release
//   (vouched uploads and links, unvouched pasted IDs) is never upgraded.
// Under normal operation every save already keeps references in line, so the only change is
// the one the next save would make anyway: an uploaded image whose link was never placed in
// any file of that lesson loses its unused reference.
export function reconcileImageRefs(db: DatabaseSync) {
  const lessons = db
    .prepare(
      "SELECT room_id AS w, folder_id AS f FROM documents UNION SELECT workspace_id, folder_id FROM image_refs",
    )
    .all() as { w: string; f: string | null }[];
  const texts = db.prepare("SELECT content FROM documents WHERE room_id=? AND folder_id IS ?");
  let removed = 0,
    added = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { w, f } of lessons) {
      const result = recordImageRefs(db, w, f, (texts.all(w, f) as { content: string }[]).map((r) => r.content));
      removed += result.removed;
      added += result.added;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { lessons: lessons.length, removed, added };
}
// Marks images as legitimately placed in a lesson (by an upload, or by someone who could see
// them), so the lesson's folder-only recipients may load them.
export function vouchImages(db: DatabaseSync, workspaceId: string, folderId: string | null, ids: Iterable<string>) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO image_refs (image_id, workspace_id, folder_id, vouched) SELECT id, workspace_id, ?, 1 FROM images WHERE id=? AND workspace_id=?",
  );
  const vouch = db.prepare("UPDATE image_refs SET vouched=1 WHERE image_id=? AND workspace_id=? AND folder_id IS ?");
  for (const id of ids) {
    insert.run(folderId, id, workspaceId);
    vouch.run(id, workspaceId, folderId);
  }
}
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
  // General access (additive): 'link' lets anyone with the workspace link view it, as every
  // workspace always has; 'private' limits it to the owner, shares and Edit Link holders.
  // Existing rows get 'link', so their student links keep working; new workspaces start
  // 'private' (rooms.create).
  if (
    !db
      .prepare("PRAGMA table_info(rooms)")
      .all()
      .some((column) => column.name === "visibility")
  )
    db.exec(
      "ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link','private'))",
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
  // Teams (additive). Membership alone grants no workspace access: workspaces are shared
  // with a team explicitly (workspace_team_shares, a later phase). Exactly one owner per
  // team, enforced by the partial unique index. Invitations go to existing accounts only
  // (emails are not verified, so an invitation to an unregistered address could be claimed
  // by whoever registers it first); declining or cancelling deletes the row.
  db.exec(`CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS team_one_owner ON team_members(team_id) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS team_invitations (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin','member')),
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS team_invitations_user ON team_invitations(user_id, created_at DESC);`);
  // Team shares (additive): a workspace explicitly shared with a team, as Viewer or Editor.
  // Members get that role while they are members; removing the share, the member or the team
  // removes it. No existing workspace is shared with any team.
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_team_shares (
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_team_shares_team ON workspace_team_shares(team_id);`);
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
  // Folder sharing (additive): a folder shared with an account or a team, as Viewer or
  // Editor, covers that folder and everything inside it, never the rest of the workspace.
  // Deleting the folder, workspace, user or team removes the share. No existing folder is
  // shared with anyone.
  db.exec(`CREATE TABLE IF NOT EXISTS folder_shares (
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (folder_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS folder_shares_user ON folder_shares(user_id, workspace_id);
    CREATE INDEX IF NOT EXISTS folder_shares_workspace ON folder_shares(workspace_id);
    CREATE TABLE IF NOT EXISTS folder_team_shares (
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (folder_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS folder_team_shares_team ON folder_team_shares(team_id);
    CREATE INDEX IF NOT EXISTS folder_team_shares_workspace ON folder_team_shares(workspace_id);
    CREATE INDEX IF NOT EXISTS folder_team_shares_folder ON folder_team_shares(folder_id);`);
  // Database-level guarantees (the API checks them first, with friendly messages): a folder
  // share belongs to the folder's own workspace, needs a Restricted workspace, and a workspace
  // with folder shares can't become "Anyone with the link" (that would open every folder).
  for (const table of ["folder_shares", "folder_team_shares"])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_scope BEFORE INSERT ON ${table}
      WHEN (SELECT workspace_id FROM folders WHERE id=NEW.folder_id) IS NOT NEW.workspace_id
        OR (SELECT visibility FROM rooms WHERE id=NEW.workspace_id) IS NOT 'private'
      BEGIN SELECT RAISE(ABORT, 'Folder sharing needs a folder in a Restricted workspace'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS rooms_link_without_folder_shares
    BEFORE UPDATE OF visibility ON rooms
    WHEN NEW.visibility='link' AND (
      EXISTS (SELECT 1 FROM folder_shares WHERE workspace_id=NEW.id) OR
      EXISTS (SELECT 1 FROM folder_team_shares WHERE workspace_id=NEW.id))
    BEGIN SELECT RAISE(ABORT, 'Remove folder shares before allowing anyone with the link'); END;`);
  // Image references (additive): which lesson's documents use which image. A folder-only
  // recipient may load an image only when a document inside their shared folders uses it.
  // Kept current on every lesson save; existing documents are scanned once, here.
  const hadImageRefs = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_refs'")
    .get();
  db.exec(`CREATE TABLE IF NOT EXISTS image_refs (
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      vouched INTEGER NOT NULL DEFAULT 0 CHECK (vouched IN (0,1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS image_refs_unique ON image_refs(image_id, COALESCE(folder_id, ''));
    CREATE INDEX IF NOT EXISTS image_refs_lesson ON image_refs(workspace_id, folder_id);`);
  // (A development database from before the vouched flag: its references predate it.)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('image_refs') WHERE name='vouched'").get())
    db.exec("ALTER TABLE image_refs ADD COLUMN vouched INTEGER NOT NULL DEFAULT 1 CHECK (vouched IN (0,1))");
  if (!hadImageRefs) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Every existing link was written by a workspace member (folder sharing didn't exist),
      // so existing references are vouched.
      const documents = db.prepare("SELECT room_id, folder_id, content FROM documents").all();
      for (const row of documents)
        vouchImages(db, row.room_id as string, row.folder_id as string | null, imageIds(row.room_id as string, [row.content as string]));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    const result = reconcileImageRefs(db);
    if (result.removed || result.added)
      console.info(
        `Image references reconciled with saved documents: ${result.removed} removed, ${result.added} added without access (provenance unknown).`,
      );
  }
  migrateLocksAndLiveSessions(db);
  return db;
}

// Content locks and Live Coding sessions (additive: new tables only, nothing existing changes,
// safe to run again). Without lock rows every workspace behaves exactly as before. Rolling back
// to a release without these features leaves the tables unused: content stays as it is, but
// that release does not enforce locks (see the rollback plan).
export function migrateLocksAndLiveSessions(db: DatabaseSync) {
  // One row per locked item. A file lock has no foreign key on purpose: file rows are rewritten
  // on every save; file locks are removed with the file (and with its folder) by the server.
  db.exec(`CREATE TABLE IF NOT EXISTS content_locks (
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('workspace','folder','file')),
      target_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden')),
      release_at INTEGER,
      release_zone TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS content_locks_release ON content_locks(release_at) WHERE release_at IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS folders_delete_locks AFTER DELETE ON folders
    BEGIN DELETE FROM content_locks WHERE workspace_id=OLD.workspace_id AND target_kind='folder' AND target_id=OLD.id; END;
    CREATE TABLE IF NOT EXISTS lock_permissions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      can_manage INTEGER NOT NULL DEFAULT 1 CHECK (can_manage IN (0,1)),
      can_schedule INTEGER NOT NULL DEFAULT 0 CHECK (can_schedule IN (0,1)),
      can_access INTEGER NOT NULL DEFAULT 1 CHECK (can_access IN (0,1)),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      CHECK ((user_id IS NULL) <> (team_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lock_permissions_unique
      ON lock_permissions(workspace_id, COALESCE(user_id,''), COALESCE(team_id,''), COALESCE(folder_id,''));
    CREATE INDEX IF NOT EXISTS lock_permissions_user ON lock_permissions(user_id);
    CREATE TABLE IF NOT EXISTS lock_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT, actor_kind TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lock_events_target ON lock_events(workspace_id, target_kind, target_id, created_at DESC);`);
  // Live Coding sessions: their own live document (never part of a workspace), their own
  // images, an unguessable revocable link (stored as a hash, sealed for re-display) and
  // explicitly invited collaborators.
  db.exec(`CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      workspace_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused','ended','archived')),
      viewer_access TEXT NOT NULL DEFAULT 'anyone' CHECK (viewer_access IN ('anyone','signed_in','invited')),
      after_end TEXT NOT NULL DEFAULT 'closed' CHECK (after_end IN ('closed','available')),
      allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0,1)),
      link_hash TEXT, link_sealed TEXT, link_expires_at INTEGER,
      state BLOB NOT NULL,
      -- While paused: what viewers have (they catch up from it on resume).
      paused_state BLOB,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS live_sessions_owner ON live_sessions(owner_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_link ON live_sessions(link_hash) WHERE link_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS live_session_members (
      session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS live_session_members_user ON live_session_members(user_id);
    CREATE TABLE IF NOT EXISTS live_images (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS live_images_session ON live_images(session_id);
    CREATE TABLE IF NOT EXISTS live_image_chunks (
      image_id TEXT NOT NULL REFERENCES live_images(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (image_id, seq)
    );`);
}
