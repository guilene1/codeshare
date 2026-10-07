import { api, readLocal, storeLocal } from "./lib";
export type Activity = {
  id: string;
  action: string;
  label: string;
  created_at: number;
};
export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string;
  updated_at: number;
  files: number;
  blocks: number;
  folders: number;
  activity: Activity[];
};
export type Shortcut = {
  id: string;
  token: string;
  name: string;
  description: string;
  lastOpened: number;
  folder?: string | null;
  file?: string;
  view?: "editor" | "blocks";
};
const key = "devshare.workspaces.v1";
export function shortcuts(): Shortcut[] {
  const value = readLocal<unknown>(key, []);
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Shortcut =>
        item &&
        typeof item.id === "string" &&
        /^[\w-]{16}$/.test(item.id) &&
        typeof item.token === "string" &&
        /^[\w-]{43}$/.test(item.token) &&
        typeof item.name === "string" &&
        Number.isFinite(item.lastOpened),
    )
    .sort((a, b) => b.lastOpened - a.lastOpened);
}
export function remember(item: Shortcut) {
  const existing = shortcuts();
  storeLocal(key, [item, ...existing.filter((value) => value.id !== item.id)]);
}
export function forget(id: string) {
  storeLocal(
    key,
    shortcuts().filter((value) => value.id !== id),
  );
}
export function editorPath(item: Shortcut) {
  const query = new URLSearchParams();
  if (item.folder) query.set("folder", item.folder);
  if (item.file) query.set("file", item.file);
  if (item.view === "blocks") query.set("view", "blocks");
  return (
    `/w/${item.id}/edit/${item.token}` +
    (query.size ? "?" + query.toString() : "")
  );
}
export async function summary(item: Shortcut) {
  return api<WorkspaceSummary>(
    `/rooms/${item.id}/summary`,
    "GET",
    undefined,
    item.token,
  );
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
    "folder.created": "Created folder",
    "folder.renamed": "Renamed folder",
    "folder.deleted": "Deleted folder",
    "file.created": "Created",
    "file.renamed": "Renamed file",
    "file.deleted": "Deleted file",
    "block.created": "Added code block",
    "block.updated": "Updated code block",
    "block.deleted": "Deleted code block",
  };
  return `${verbs[item.action] ?? "Updated workspace structure"} · ${item.label}`;
}
