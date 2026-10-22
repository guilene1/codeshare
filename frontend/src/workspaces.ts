import { readLocal, storeLocal } from "./lib";
export type Activity = {
  id: string;
  action: string;
  label: string;
  created_at: number;
  // Present on workspace activity for Owners and Editors; null for unattributed history.
  actor?: { kind: "user"; name: string } | { kind: "link" } | null;
};
// Live presence for Owners and Editors (pushed over the workspace WebSocket).
export type PresenceSummary = {
  total: number;
  users: Array<{ name: string; role: "owner" | "editor" | "viewer"; you: boolean }>;
  guests: Array<{ name: string; you: boolean }>;
  anonymous: number;
};
export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
// Neutral attribution: verified account names only, never a guess.
export function actorName(actor: Activity["actor"]) {
  if (actor?.kind === "user") return actor.name;
  return actor?.kind === "link" ? "Guest editor" : "Unknown";
}
const changes: Record<string, string> = {
  "workspace.created": "Workspace created",
  "workspace.renamed": "Workspace renamed",
  "folder.created": "Folder created",
  "folder.renamed": "Folder renamed",
  "folder.deleted": "Folder deleted",
  "file.created": "File created",
  "file.edited": "File edited",
  "file.renamed": "File renamed",
  "file.deleted": "File deleted",
  "block.created": "Code block added",
  "block.updated": "Code block updated",
  "block.deleted": "Code block deleted",
  "blocks.migrated": "Snippets moved into a lesson",
  image: "Image added",
};
export const changeLabel = (action: string) =>
  changes[action] ?? "Workspace content updated";
// The affected file or folder, when the record names one.
export const changeTarget = (item: Activity) =>
  item.action === "image" ? "" : item.label;
export const targetKind = (action: string) =>
  action.startsWith("folder.")
    ? "Folder"
    : action.startsWith("file.")
      ? "File"
      : action.startsWith("workspace.")
        ? "Workspace"
        : action.startsWith("block")
          ? "Code block"
          : "Item";
// "Today at 2:35 PM", "Yesterday at 9:05 AM", else "Oct 18 at 2:35 PM", in local time.
export function whenLabel(time: number, now = new Date()) {
  const date = new Date(time),
    clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })} at ${clock}`;
}
// A workspace owned by the signed-in account (from /api/me/workspaces).
export type OwnedWorkspace = {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  hasEditorLink: boolean;
  files: number;
  folders: number;
  activity: Activity[];
};
// A workspace another owner shared with the signed-in account (from /api/me/shared).
export type SharedWorkspace = {
  id: string;
  name: string;
  description: string;
  updated_at: number;
  shared_at: number;
  role: "viewer" | "editor";
  ownerName: string;
};
export type ShareRole = SharedWorkspace["role"];
// v1 kept private editor shortcuts (including tokens) in localStorage. v2 only reads
// them to offer a one-time import into the account, then deletes them.
export type LegacyShortcut = { id: string; token: string; name: string };
const legacyKey = "devshare.workspaces.v1";
export function legacyShortcuts(): LegacyShortcut[] {
  const value = readLocal<unknown>(legacyKey, []);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is LegacyShortcut =>
      item &&
      typeof item.id === "string" &&
      /^[\w-]{16}$/.test(item.id) &&
      typeof item.token === "string" &&
      /^[\w-]{43}$/.test(item.token) &&
      typeof item.name === "string",
  );
}
export function forgetLegacy(id: string) {
  const remaining = legacyShortcuts().filter((value) => value.id !== id);
  if (remaining.length) storeLocal(legacyKey, remaining);
  else
    try {
      localStorage.removeItem(legacyKey);
    } catch {
      /* storage unavailable */
    }
}
export function relativeTime(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (hours < 48) return "yesterday";
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
export function activityText(item: Activity) {
  const verbs: Record<string, string> = {
    "workspace.created": "Created workspace",
    "workspace.renamed": "Renamed workspace",
    "workspace.claimed": "Added to account",
    "folder.created": "Created folder",
    "folder.renamed": "Renamed folder",
    "folder.deleted": "Deleted folder",
    "file.created": "Created",
    "file.edited": "Edited",
    "file.renamed": "Renamed file",
    "file.deleted": "Deleted file",
    "block.created": "Added code block",
    "block.updated": "Updated code block",
    "block.deleted": "Deleted code block",
    "blocks.migrated": "Moved snippets into a lesson",
    "link.created": "Created",
    "link.replaced": "Replaced",
    "link.revoked": "Revoked",
    "share.added": "Shared with",
    "share.changed": "Changed access for",
    "share.removed": "Removed access for",
    "share.left": "Left shared workspace",
  };
  return `${verbs[item.action] ?? "Updated workspace structure"} · ${item.label}`;
}
