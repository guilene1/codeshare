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
};
export type Access = "owner" | "editor" | "viewer";
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
  if (
    auth.userId &&
    auth.sessionHash &&
    row.owner_id === auth.userId &&
    sessionValid(auth.sessionHash, auth.userId)
  )
    return "owner";
  if (auth.tokenHash && equalHash(row.editor_token_hash, auth.tokenHash))
    return "editor";
  return "viewer";
}
