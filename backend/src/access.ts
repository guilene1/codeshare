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
export type Access = "owner" | "editor" | "viewer";
export type ShareRole = "viewer" | "editor";
export const isShareRole = (value: unknown): value is ShareRole =>
  value === "viewer" || value === "editor";
// Single source of truth for edit rights, re-evaluated on every REST request and
// every WebSocket write so revoked sessions and links lose access immediately.
export function workspaceAccess(
  db: DatabaseSync,
  sessionValid: (tokenHash: string, userId: string) => boolean,
  workspaceId: string,
  auth: Auth,
): Access {
  const row = db
    .prepare("SELECT owner_id,editor_token_hash FROM rooms WHERE id=?")
    .get(workspaceId);
  if (!row) return "viewer";
  const signedIn =
    !!auth.userId &&
    !!auth.sessionHash &&
    sessionValid(auth.sessionHash, auth.userId);
  if (signedIn && row.owner_id === auth.userId) return "owner";
  // Account shares: an explicit editor share grants editing; a viewer share adds nothing
  // beyond the public link except the Shared with Me entry.
  if (
    signedIn &&
    db
      .prepare(
        "SELECT 1 FROM workspace_shares WHERE workspace_id=? AND user_id=? AND role='editor'",
      )
      .get(workspaceId, auth.userId!)
  )
    return "editor";
  if (auth.tokenHash && equalHash(row.editor_token_hash, auth.tokenHash))
    return "editor";
  return "viewer";
}
