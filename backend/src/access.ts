import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function hashEditorToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function equalHash(stored: unknown, supplied: string | undefined) {
  return (
    typeof stored === "string" &&
    /^[a-f0-9]{64}$/.test(stored) &&
    !!supplied &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(supplied, "hex"))
  );
}
// Who is asking: a signed-in session and/or a private editor link credential.
export type Auth = {
  userId?: string;
  sessionHash?: string;
  tokenHash?: string;
  // Set on live sockets so a share change can disconnect just that workspace.
  workspaceId?: string;
};
// "none" means no access at all: the workspace is private and nothing grants entry. It must
// never be treated as edit rights; use canEditAccess / canReadAccess, not `!== "viewer"`.
export type Access = "owner" | "editor" | "viewer" | "none";
export const canEditAccess = (access: Access) =>
  access === "owner" || access === "editor";
export const canReadAccess = (access: Access) => access !== "none";
export type Visibility = "link" | "private";
export const isVisibility = (value: unknown): value is Visibility =>
  value === "link" || value === "private";
export type ShareRole = "viewer" | "editor";
export const isShareRole = (value: unknown): value is ShareRole =>
  value === "viewer" || value === "editor";
// Single source of truth for read and edit rights, re-evaluated on every REST request and
// every WebSocket message so revoked sessions, shares and links lose access immediately.
// The highest grant wins: owner, then editor (share or Edit Link), then viewer (share, or
// anyone with the link when the workspace's general access is 'link').
export function workspaceAccess(
  db: DatabaseSync,
  sessionValid: (tokenHash: string, userId: string) => boolean,
  workspaceId: string,
  auth: Auth,
): Access {
  const row = db
    .prepare("SELECT owner_id,editor_token_hash,visibility FROM rooms WHERE id=?")
    .get(workspaceId);
  if (!row) return "none";
  const signedIn =
    !!auth.userId &&
    !!auth.sessionHash &&
    sessionValid(auth.sessionHash, auth.userId);
  if (signedIn && row.owner_id === auth.userId) return "owner";
  const share = signedIn
    ? (db
        .prepare(
          "SELECT role FROM workspace_shares WHERE workspace_id=? AND user_id=?",
        )
        .get(workspaceId, auth.userId!)?.role as ShareRole | undefined)
    : undefined;
  const team = signedIn ? teamRole(db, workspaceId, auth.userId!) : undefined;
  if (share === "editor" || team === "editor") return "editor";
  if (auth.tokenHash && equalHash(row.editor_token_hash, auth.tokenHash))
    return "editor";
  if (share === "viewer" || team === "viewer") return "viewer";
  return row.visibility === "private" ? "none" : "viewer";
}
// Folder sharing: a folder shared with an account (folder_shares) or a team
// (folder_team_shares) grants that role on the folder and everything inside it, never on the
// workspace root, its parents, siblings or anything else. Folder grants only add to workspace
// access; they never grant sharing or workspace management.
const rankOf = { none: 0, viewer: 1, editor: 2, owner: 3 } as const;
export const higherAccess = (a: Access, b: Access): Access => (rankOf[a] >= rankOf[b] ? a : b);
const ROLE_RANK_SQL = "CASE s.role WHEN 'editor' THEN 2 ELSE 1 END";
// The best folder role a signed-in user has on one folder, through grants on it or any of its
// ancestors (12 levels at most). Undefined when the folder isn't in this workspace.
export function folderRole(
  db: DatabaseSync,
  workspaceId: string,
  folderId: string,
  userId: string,
): ShareRole | undefined {
  const best = db
    .prepare(
      `WITH RECURSIVE chain(id, parent_id) AS (
         SELECT id, parent_id FROM folders WHERE id=? AND workspace_id=?
         UNION ALL SELECT f.id, f.parent_id FROM folders f JOIN chain c ON f.id=c.parent_id
       )
       SELECT MAX(rank) AS rank FROM (
         SELECT ${ROLE_RANK_SQL} AS rank FROM folder_shares s JOIN chain c ON s.folder_id=c.id WHERE s.user_id=?
         UNION ALL
         SELECT ${ROLE_RANK_SQL} FROM folder_team_shares s JOIN chain c ON s.folder_id=c.id
           JOIN team_members m ON m.team_id=s.team_id AND m.user_id=?
       )`,
    )
    .get(folderId, workspaceId, userId, userId)?.rank;
  return best === 2 ? "editor" : best === 1 ? "viewer" : undefined;
}
// Every folder a signed-in user reaches through folder grants in one workspace (each granted
// folder and all its descendants), with the best role for each. Empty when there are none.
export function folderScope(db: DatabaseSync, workspaceId: string, userId: string) {
  const rows = db
    .prepare(
      `WITH RECURSIVE granted(folder_id, rank) AS (
         SELECT s.folder_id, ${ROLE_RANK_SQL} FROM folder_shares s WHERE s.workspace_id=? AND s.user_id=?
         UNION ALL
         SELECT s.folder_id, ${ROLE_RANK_SQL} FROM folder_team_shares s
           JOIN team_members m ON m.team_id=s.team_id AND m.user_id=? WHERE s.workspace_id=?
       ),
       reach(folder_id, rank) AS (
         SELECT folder_id, rank FROM granted
         UNION ALL SELECT f.id, r.rank FROM folders f JOIN reach r ON f.parent_id=r.folder_id
       )
       SELECT folder_id, MAX(rank) AS rank FROM reach GROUP BY folder_id`,
    )
    .all(workspaceId, userId, userId, workspaceId) as { folder_id: string; rank: number }[];
  return new Map<string, ShareRole>(rows.map((r) => [r.folder_id, r.rank === 2 ? "editor" : "viewer"]));
}
// Access to one lesson: the workspace root (folderId null) follows workspace access alone; a
// folder lesson also counts folder grants, and the highest grant wins.
export function lessonAccess(
  db: DatabaseSync,
  sessionValid: (tokenHash: string, userId: string) => boolean,
  workspaceId: string,
  folderId: string | null,
  auth: Auth,
): { access: Access; workspace: Access } {
  const workspace = workspaceAccess(db, sessionValid, workspaceId, auth);
  if (!folderId || canEditAccess(workspace) || !auth.userId || !auth.sessionHash) return { access: workspace, workspace };
  if (!sessionValid(auth.sessionHash, auth.userId)) return { access: workspace, workspace };
  const role = folderRole(db, workspaceId, folderId, auth.userId);
  return { access: role ? higherAccess(workspace, role) : workspace, workspace };
}
// The highest role any of the user's current teams has on this workspace (team shares).
// Read live, so joining a team grants it and leaving or removal takes it away at once.
export function teamRole(
  db: DatabaseSync,
  workspaceId: string,
  userId: string,
): ShareRole | undefined {
  const best = db
    .prepare(
      "SELECT MAX(CASE s.role WHEN 'editor' THEN 2 ELSE 1 END) AS rank FROM workspace_team_shares s JOIN team_members m ON m.team_id=s.team_id WHERE s.workspace_id=? AND m.user_id=?",
    )
    .get(workspaceId, userId)?.rank;
  return best === 2 ? "editor" : best === 1 ? "viewer" : undefined;
}
