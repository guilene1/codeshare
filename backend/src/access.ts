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
