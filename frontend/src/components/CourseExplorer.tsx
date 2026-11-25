import { useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Share2,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import Modal from "./Modal";
import type { CourseTree, LockTarget } from "../lib";
import {
  applyLock,
  LockDialogs,
  LockLabel,
  LockMenu,
  LockToggle,
  type LockDialog,
  type LockItem,
} from "./ContentLocks";

// Content locks in the Explorer. `show`: padlocks and statuses appear (for people who manage
// locks, and for everyone once the workspace has any lock); `rights(item)`: what this person may
// do with that item's lock.
export type ExplorerLocks = {
  show: boolean;
  // Statuses on the right ("Available", "Locked"…): once the workspace has any lock.
  labels: boolean;
  owner: boolean;
  rights: (item: LockTarget) => { manage: boolean; schedule: boolean };
  notify: (message: string) => void;
};
type Props = {
  tree: CourseTree;
  name: string;
  // Set for a folder-only recipient: their tree starts at the folders shared with them (the
  // server sends nothing above them), so there is no workspace root to show or open.
  shared?: { ownerName: string; role: "viewer" | "editor" };
  folder: string | null;
  active: string | undefined;
  // Files open as tabs in the current lesson; each gets a close X in its row.
  openTabs: string[];
  onCloseTab: (file: string) => void;
  // Whether folders may be created inside `parent` (null: the workspace root), and so
  // renamed, moved or deleted there: the server needs Editor rights on the parent.
  canOrganize: (parent: string | null) => boolean;
  // Workspace sharing managers only (owner, direct Editors): opens Share folder. Absent for
  // everyone else, so the menu item doesn't exist for them.
  onShare?: (folder: { id: string; name: string }) => void;
  // Folders shared on their own (direct shares), marked subtly. Managers only.
  sharedFolders?: Set<string>;
  connected: boolean;
  onOpen: (folder: string | null, file?: string) => void;
  request: (path: string, method: string, body?: unknown) => Promise<unknown>;
  workspaceId?: string;
  locks?: ExplorerLocks;
};
export default function CourseExplorer({
  tree,
  name,
  shared,
  folder,
  active,
  openTabs,
  onCloseTab,
  canOrganize,
  onShare,
  sharedFolders,
  connected,
  onOpen,
  request,
  workspaceId,
  locks,
}: Props) {
  const parentOf = (id: string | null) => tree.folders.find((f) => f.id === id)?.parent_id ?? null;
  // A folder's own entry (rename, move, delete) is managed from its parent.
  const canManage = (id: string) => canOrganize(parentOf(id));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "rename" | "delete" | null>(
    null,
  );
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Locks: the open padlock menu, the open lock dialog, and the items selected for a bulk change.
  const [lockMenu, setLockMenu] = useState<{ item: LockItem; anchor: HTMLElement } | null>(null);
  const [lockDialog, setLockDialog] = useState<LockDialog | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, LockItem>>(new Map());
  const [lockBusy, setLockBusy] = useState(false);
  const showLocks = !!locks?.show;
  const keyOf = (item: LockTarget) => item.kind + ":" + item.id;
  const rootItem: LockItem | undefined = workspaceId
    ? { kind: "workspace", id: workspaceId, name: name || "Workspace", lock: tree.workspaceLock }
    : undefined;
  function open(mode: "new" | "rename" | "delete", id: string | null) {
    if (mode === "new" ? !canOrganize(id) : !id || !canManage(id)) return;
    setMenu(null);
    setDialog(mode);
    setTarget(id);
    setDraft(
      mode === "rename"
        ? (tree.folders.find((f) => f.id === id)?.name ?? "")
        : "",
    );
    setError("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !connected) return;
    setBusy(true);
    setError("");
    try {
      if (dialog === "new")
        await request("/folders", "POST", { name: draft, parent_id: target });
      else if (dialog === "rename")
        await request("/folders/" + target, "PATCH", { name: draft });
      else await request("/folders/" + target, "DELETE");
      // A shared-folder recipient has no root to fall back to: its parent (always inside
      // their folders, since the shared folder itself can't be deleted by them) instead.
      if (dialog === "delete" && target === folder) onOpen(shared ? parentOf(target) : null);
      if (target)
        setCollapsed((previous) => {
          const next = new Set(previous);
          next.delete(target);
          return next;
        });
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function move(id: string, direction: number) {
    if (!canManage(id) || !connected || busy) return;
    setMenu(null);
    const item = tree.folders.find((f) => f.id === id)!;
    const siblings = tree.folders.filter((f) => f.parent_id === item.parent_id);
    const index = siblings.findIndex((f) => f.id === id);
    const ids = siblings.map((f) => f.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    setBusy(true);
    setError("");
    try {
      await request("/folders/order", "PATCH", {
        ids,
        parent_id: item.parent_id,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // A one-click lock change from the padlock menu; reported only after the server confirms.
  async function quick(item: LockItem, action: "lock" | "unlock" | "cancel" | "visibility", extra: Record<string, unknown> = {}, done = "") {
    setLockBusy(true);
    setError("");
    try {
      await applyLock(request, [item], action, extra);
      locks?.notify(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLockBusy(false);
    }
  }
  function lockAction(item: LockItem, action: Parameters<Parameters<typeof LockMenu>[0]["onAction"]>[0]) {
    setLockMenu(null);
    if (action === "history") return setLockDialog({ mode: "history", item });
    if (action === "permissions") return setLockDialog({ mode: "permissions", folderId: item.kind === "folder" ? item.id : null });
    if (action === "schedule") return setLockDialog({ mode: "schedule", items: [item] });
    if (action === "select") {
      setSelecting(true);
      setSelected(new Map([[keyOf(item), item]]));
      return;
    }
    // Locking or unlocking the whole workspace is confirmed first.
    if ((action === "lock" || action === "unlock") && item.kind === "workspace")
      return setLockDialog({ mode: "confirm", items: [item], action });
    if (action === "lock") return void quick(item, "lock", {}, `Locked “${item.name}”`);
    if (action === "unlock") return void quick(item, "unlock", {}, `Unlocked “${item.name}”`);
    if (action === "cancel") return void quick(item, "cancel", {}, `Scheduled release canceled: “${item.name}” stays locked`);
    if (action === "hide") return void quick(item, "visibility", { visibility: "hidden" }, `“${item.name}” is hidden from students until released`);
    if (action === "show") return void quick(item, "visibility", { visibility: "visible" }, `Students now see “${item.name}” as locked`);
  }
  const toggleSelected = (item: LockItem) =>
    setSelected((previous) => {
      const next = new Map(previous);
      next.has(keyOf(item)) ? next.delete(keyOf(item)) : next.set(keyOf(item), item);
      return next;
    });
  // The padlock (and selection box) before a row's own icon.
  const lockLead = (item: LockItem) => {
    if (!showLocks) return null;
    const rights = locks!.rights(item);
    return (
      <>
        {selecting && rights.manage && item.kind !== "workspace" && (
          <input
            type="checkbox"
            className="lock-select"
            aria-label={"Select " + item.name}
            checked={selected.has(keyOf(item))}
            onChange={() => toggleSelected(item)}
          />
        )}
        <LockToggle item={item} manage={rights.manage || locks!.owner} onMenu={(anchor) => setLockMenu({ item, anchor })} />
      </>
    );
  };
  function branch(parent: string | null, depth = 0): React.ReactNode {
    return (
      <>
        {tree.folders
          .filter((f) => f.parent_id === parent)
          .map((item, index, siblings) => {
            const lockItem: LockItem = { kind: "folder", id: item.id, name: item.name, lock: item.lock };
            return (
            <div key={item.id} className="course-folder">
              <div
                className={"folder-row" + (folder === item.id ? " active" : "") + (showLocks ? " with-locks" : "")}
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                <button
                  className="folder-chevron"
                  aria-label={
                    (collapsed.has(item.id) ? "Expand " : "Collapse ") +
                    item.name
                  }
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      next.has(item.id)
                        ? next.delete(item.id)
                        : next.add(item.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(item.id) ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
                {lockLead(lockItem)}
                <button
                  className="folder-open"
                  aria-label={"Open folder " + item.name}
                  onClick={() => onOpen(item.id)}
                >
                  {folder === item.id ? (
                    <FolderOpen size={15} />
                  ) : (
                    <Folder size={15} />
                  )}
                  <span title={item.name}>{item.name}</span>
                  {sharedFolders?.has(item.id) && (
                    <span className="shared-mark" role="img" aria-label="Shared folder" title="Shared folder">
                      <Users size={12} aria-hidden="true" />
                    </span>
                  )}
                </button>
                {showLocks && locks!.labels && <LockLabel item={lockItem} />}
                {(canOrganize(item.id) || canManage(item.id) || onShare) && (
                  <details className="folder-menu" open={menu === item.id}>
                    <summary
                      aria-label={"Manage folder " + item.name}
                      aria-expanded={menu === item.id}
                      onClick={(event) => {
                        event.preventDefault();
                        setMenu((previous) =>
                          previous === item.id ? null : item.id,
                        );
                      }}
                    >
                      ⋯
                    </summary>
                    <div>
                      {onShare && (
                        <button
                          onClick={() => {
                            setMenu(null);
                            onShare({ id: item.id, name: item.name });
                          }}
                        >
                          <Share2 size={12} /> Share folder
                        </button>
                      )}
                      {canOrganize(item.id) && (
                        <button
                          onClick={() => open("new", item.id)}
                          disabled={!connected || busy}
                        >
                          <FolderPlus size={12} /> New subfolder
                        </button>
                      )}
                      {/* The folder's own entry: not for the shared folder itself. */}
                      {canManage(item.id) && (
                        <>
                          <button
                            onClick={() => open("rename", item.id)}
                            disabled={!connected || busy}
                          >
                            <Pencil size={12} /> Rename
                          </button>
                          <button
                            onClick={() => void move(item.id, -1)}
                            disabled={!connected || busy || index === 0}
                          >
                            <ArrowUp size={12} /> Move up
                          </button>
                          <button
                            onClick={() => void move(item.id, 1)}
                            disabled={
                              !connected || busy || index === siblings.length - 1
                            }
                          >
                            <ArrowDown size={12} /> Move down
                          </button>
                          <button
                            onClick={() => open("delete", item.id)}
                            disabled={!connected || busy}
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                )}
              </div>
              {!collapsed.has(item.id) && branch(item.id, depth + 1)}
            </div>
            );
          })}
        {tree.documents
          .filter((file) => file.folder_id === parent)
          .map((file) => {
            // Tabs belong to the open lesson, so only its files can have one.
            const tabOpen = parent === folder && openTabs.includes(file.id);
            const lockItem: LockItem = { kind: "file", id: file.id, name: file.filename, lock: file.lock };
            if (showLocks)
              return (
                <div
                  key={file.id}
                  className={"tree-file-row with-locks" + (tabOpen ? " tab-open" : "")}
                  style={{ paddingLeft: 6 + depth * 12 }}
                >
                  {lockLead(lockItem)}
                  <button
                    className={"tree-file" + (file.id === active && parent === folder ? " active" : "")}
                    onClick={() => onOpen(parent, file.id)}
                  >
                    <FileCode2 size={15} />
                    <span title={file.filename}>{file.filename}</span>
                  </button>
                  {locks!.labels && <LockLabel item={lockItem} />}
                  {tabOpen && (
                    <button
                      className="tree-file-close"
                      aria-label={"Close tab " + file.filename}
                      title="Close tab"
                      onClick={() => onCloseTab(file.id)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              );
            return (
              <div key={file.id} className={"tree-file-row" + (tabOpen ? " tab-open" : "")}>
                <button
                  className={
                    "tree-file" +
                    (file.id === active && parent === folder ? " active" : "")
                  }
                  style={{ paddingLeft: 14 + depth * 12 }}
                  onClick={() => onOpen(parent, file.id)}
                >
                  <FileCode2 size={15} />
                  <span title={file.filename}>{file.filename}</span>
                </button>
                {/* A sibling, not a child, so closing never opens or selects the file. */}
                {tabOpen && (
                  <button
                    className="tree-file-close"
                    aria-label={"Close tab " + file.filename}
                    title="Close tab"
                    onClick={() => onCloseTab(file.id)}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
      </>
    );
  }
  const selectedItems = [...selected.values()];
  return (
    <div className="course-explorer">
      <div className={"course-root" + (showLocks && !shared ? " with-locks" : "")}>
        {shared ? (
          // Who shared it and the role here, in place of the workspace root.
          <span className="shared-by" aria-label="Shared folder details">
            <UserRound size={14} />
            <span title={shared.ownerName ? "Shared by " + shared.ownerName : undefined}>
              {shared.ownerName ? "Shared by " + shared.ownerName : "Shared with you"}
            </span>
            <span className={"role-badge " + shared.role}>
              {shared.role === "editor" ? "Editor" : "Viewer"}
            </span>
          </span>
        ) : (
          <>
            {rootItem && lockLead(rootItem)}
            <button onClick={() => onOpen(null)} title="Open workspace root">
              <FolderOpen size={15} />
              <span>{name}</span>
            </button>
            {showLocks && locks!.labels && rootItem && <LockLabel item={rootItem} />}
          </>
        )}
        {canOrganize(folder) && (
          <button
            className="icon-button"
            aria-label="Create folder"
            title="Create lesson folder"
            disabled={!connected || busy}
            onClick={() => open("new", folder)}
          >
            <FolderPlus size={15} />
          </button>
        )}
      </div>
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {branch(null)}
      {selecting && (
        <div className="lock-bulk-bar" role="region" aria-label="Lock several items">
          <span>{selectedItems.length} selected</span>
          <div>
            <button
              className="button secondary"
              disabled={!selectedItems.length || lockBusy}
              onClick={() => setLockDialog({ mode: "confirm", items: selectedItems, action: "lock" })}
            >
              Lock
            </button>
            <button
              className="button secondary"
              disabled={!selectedItems.length || lockBusy}
              onClick={() => setLockDialog({ mode: "confirm", items: selectedItems, action: "unlock" })}
            >
              Unlock
            </button>
            {selectedItems.length > 0 && selectedItems.every((item) => locks?.rights(item).schedule) && (
              <button className="button secondary" disabled={lockBusy} onClick={() => setLockDialog({ mode: "schedule", items: selectedItems })}>
                Schedule
              </button>
            )}
            <button
              className="text-button"
              onClick={() => {
                setSelecting(false);
                setSelected(new Map());
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
      {lockMenu && (
        <LockMenu
          item={lockMenu.item}
          anchor={lockMenu.anchor}
          scopes={locks!.rights(lockMenu.item)}
          owner={locks!.owner}
          onClose={() => setLockMenu(null)}
          onAction={(action) => lockAction(lockMenu.item, action)}
        />
      )}
      <LockDialogs
        dialog={lockDialog}
        setDialog={(next) => {
          setLockDialog(next);
          // A finished bulk change ends the selection.
          if (!next && selecting) {
            setSelected(new Map());
            setSelecting(false);
          }
        }}
        request={request}
        notify={locks?.notify ?? (() => {})}
        folders={tree.folders.map((f) => ({ id: f.id, name: f.name }))}
      />
      {dialog && (
        <Modal
          title={
            dialog === "new"
              ? "Create folder"
              : dialog === "rename"
                ? "Rename folder"
                : "Delete folder"
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form onSubmit={submit}>
            {dialog === "delete" ? (
              <p className="modal-description">
                Permanently delete this folder, its subfolders, files and code
                blocks? Students will lose access to this lesson.
              </p>
            ) : (
              <label className="field">
                Folder name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Week 04 - Terraform"
                />
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={
                  busy || !connected || (dialog !== "delete" && !draft.trim())
                }
              >
                {dialog === "new"
                  ? "Create Folder"
                  : dialog === "rename"
                    ? "Rename Folder"
                    : "Delete Folder"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
