import type { DatabaseSync } from "node:sqlite";
import type { ShareRole } from "./access.js";

// What a /api/rooms/:roomId request touches, so the access gate can apply folder grants only
// where they belong. Anything not listed here is a workspace-level route: a folder-only
// recipient gets the same 404 there as for a workspace that doesn't exist (deny by default).
export type Target =
  // Workspace-level: sharing, Edit Link, visibility, summary, activity, rename/delete, claim.
  | { kind: "workspace" }
  // GET /api/rooms/:id and GET /tree: full for workspace members, scoped for folder-only.
  | { kind: "info" }
  | { kind: "tree" }
  // GET /folder-roles: the caller's own folder grants (folder ID -> role), so the interface
  // knows where they may edit. Readable by anyone with workspace or folder access.
  | { kind: "roles" }
  // One lesson's content (files, blocks, checkpoint): folderId null is the workspace root.
  | { kind: "lesson"; folderId: string | null }
  // Creating, renaming, reordering or deleting folders: needs Editor rights on the parent
  // lesson, so the shared folder itself (whose parent is outside the share) is protected.
  | { kind: "manage"; parentId: string | null; folderId: string | null }
  // Reading one image, and uploading into one lesson.
  | { kind: "image"; imageId: string }
  | { kind: "upload"; folderId: string | null };

const LESSON_ROUTES = new Set(["documents", "blocks", "checkpoint", "migrate-snippets"]);
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

export function classify(
  db: DatabaseSync,
  workspaceId: string,
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
): Target {
  const parts = path.split("/").filter(Boolean);
  const folderQuery = typeof query.folder === "string" ? query.folder : undefined;
  if (!parts.length) return method === "GET" ? { kind: "info" } : { kind: "workspace" };
  if (parts.length === 1 && parts[0] === "tree") return method === "GET" ? { kind: "tree" } : { kind: "workspace" };
  if (parts.length === 1 && parts[0] === "folder-roles") return method === "GET" ? { kind: "roles" } : { kind: "workspace" };
  if (parts[0] === "images") {
    if (method === "GET" && parts.length === 2) return { kind: "image", imageId: parts[1] };
    if (method === "POST" && (parts.length === 1 || (parts.length === 2 && parts[1] === "import")))
      return { kind: "upload", folderId: folderQuery ?? null };
    return { kind: "workspace" };
  }
  if (parts[0] === "folders") {
    const parent = textOrNull((body as { parent_id?: unknown } | undefined)?.parent_id);
    if (method === "POST" && parts.length === 1) return { kind: "manage", parentId: parent, folderId: null };
    if (method === "PATCH" && parts.length === 2 && parts[1] === "order")
      return { kind: "manage", parentId: parent, folderId: null };
    if ((method === "PATCH" || method === "DELETE") && parts.length === 2) {
      const row = db
        .prepare("SELECT parent_id FROM folders WHERE id=? AND workspace_id=?")
        .get(parts[1], workspaceId);
      return { kind: "manage", parentId: (row?.parent_id as string | null) ?? null, folderId: row ? parts[1] : null };
    }
    return { kind: "workspace" };
  }
  if (LESSON_ROUTES.has(parts[0]) && (parts[0] === "documents" || parts[0] === "blocks" || parts.length === 1)) {
    let folderId = folderQuery ?? null;
    // A file addressed by ID alone is checked against the lesson it really belongs to.
    if (folderQuery === undefined && parts[0] === "documents" && parts.length >= 2 && parts[1] !== "order") {
      const row = db.prepare("SELECT folder_id FROM documents WHERE id=? AND room_id=?").get(parts[1], workspaceId);
      if (row) folderId = (row.folder_id as string | null) ?? null;
    }
    return { kind: "lesson", folderId };
  }
  return { kind: "workspace" };
}

// The folders a folder-only recipient may see, shaped like the full tree: their shared
// folders become top-level entries (no parent ID, so no parent path), with everything inside
// them, and only the files in those folders. Nothing else of the workspace appears.
export function scopedTree(db: DatabaseSync, workspaceId: string, scope: Map<string, ShareRole>) {
  const folders = (
    db
      .prepare("SELECT id,parent_id,name,position FROM folders WHERE workspace_id=? ORDER BY position,id")
      .all(workspaceId) as { id: string; parent_id: string | null; name: string; position: number }[]
  )
    .filter((f) => scope.has(f.id))
    .map((f) => ({ ...f, parent_id: f.parent_id && scope.has(f.parent_id) ? f.parent_id : null }));
  const documents = (
    db
      .prepare("SELECT id,folder_id,filename,language,position FROM documents WHERE room_id=? ORDER BY position,id")
      .all(workspaceId) as { id: string; folder_id: string | null }[]
  ).filter((d) => d.folder_id !== null && scope.has(d.folder_id));
  return { folders, documents };
}

// What a folder-only recipient learns about the workspace: the folders shared with them
// (name and role) and the owner's name. Never the workspace name, description or settings.
export function scopedInfo(db: DatabaseSync, workspaceId: string, scope: Map<string, ShareRole>) {
  const tree = scopedTree(db, workspaceId, scope);
  const owner = db
    .prepare("SELECT u.display_name AS name FROM rooms r LEFT JOIN users u ON u.id=r.owner_id WHERE r.id=?")
    .get(workspaceId)?.name as string | undefined;
  return {
    id: workspaceId,
    scoped: true,
    ownerName: owner ?? null,
    folders: tree.folders
      .filter((f) => f.parent_id === null)
      .map((f) => ({ id: f.id, name: f.name, role: scope.get(f.id)! })),
  };
}

// An image is visible to a folder-only recipient only through a vouched reference inside one
// of their folders: it was uploaded there, or someone who could already see it placed it
// there (see Rooms.vouchAdded). Pasting an image ID into a document vouches for nothing.
export function imageInScope(
  db: DatabaseSync,
  workspaceId: string,
  imageId: string,
  scope: Map<string, ShareRole>,
) {
  return (
    db
      .prepare(
        "SELECT folder_id FROM image_refs WHERE image_id=? AND workspace_id=? AND folder_id IS NOT NULL AND vouched=1",
      )
      .all(imageId, workspaceId) as { folder_id: string }[]
  ).some((r) => scope.has(r.folder_id));
}
