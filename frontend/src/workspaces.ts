import { readLocal, storeLocal } from "./lib";
export type Activity = {
  id: string;
  action: string;
  label: string;
  created_at: number;
};
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
    "file.renamed": "Renamed file",
    "file.deleted": "Deleted file",
    "block.created": "Added code block",
    "block.updated": "Updated code block",
    "block.deleted": "Deleted code block",
    "blocks.migrated": "Moved snippets into a lesson",
    "link.created": "Created",
    "link.replaced": "Replaced",
    "link.revoked": "Revoked",
  };
  return `${verbs[item.action] ?? "Updated workspace structure"} · ${item.label}`;
}
