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
  Trash2,
} from "lucide-react";
import Modal from "./Modal";
import type { CourseTree } from "../lib";

type Props = {
  tree: CourseTree;
  name: string;
  folder: string | null;
  active: string | undefined;
  canEdit: boolean;
  connected: boolean;
  onOpen: (folder: string | null, file?: string) => void;
  request: (path: string, method: string, body?: unknown) => Promise<unknown>;
};
export default function CourseExplorer({
  tree,
  name,
  folder,
  active,
  canEdit,
  connected,
  onOpen,
  request,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "rename" | "delete" | null>(
    null,
  );
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function open(mode: "new" | "rename" | "delete", id: string | null) {
    if (!canEdit) return;
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
    if (busy || !canEdit || !connected) return;
    setBusy(true);
    setError("");
    try {
      if (dialog === "new")
        await request("/folders", "POST", { name: draft, parent_id: target });
      else if (dialog === "rename")
        await request("/folders/" + target, "PATCH", { name: draft });
      else await request("/folders/" + target, "DELETE");
      if (dialog === "delete" && target === folder) onOpen(null);
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
    if (!canEdit || !connected || busy) return;
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
  function branch(parent: string | null, depth = 0): React.ReactNode {
    return (
      <>
        {tree.folders
          .filter((f) => f.parent_id === parent)
          .map((item, index, siblings) => (
            <div key={item.id} className="course-folder">
              <div
                className={"folder-row" + (folder === item.id ? " active" : "")}
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
                  <span>{item.name}</span>
                </button>
                {canEdit && (
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
                      <button
                        onClick={() => open("new", item.id)}
                        disabled={!connected || busy}
                      >
                        <FolderPlus size={12} /> New subfolder
                      </button>
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
                    </div>
                  </details>
                )}
              </div>
              {!collapsed.has(item.id) && branch(item.id, depth + 1)}
            </div>
          ))}
        {tree.documents
          .filter((file) => file.folder_id === parent)
          .map((file) => (
            <button
              key={file.id}
              className={
                "tree-file" +
                (file.id === active && parent === folder ? " active" : "")
              }
              style={{ paddingLeft: 14 + depth * 12 }}
              onClick={() => onOpen(parent, file.id)}
            >
              <FileCode2 size={15} />
              <span>{file.filename}</span>
            </button>
          ))}
      </>
    );
  }
  return (
    <div className="course-explorer">
      <div className="course-root">
        <button onClick={() => onOpen(null)} title="Open workspace root">
          <FolderOpen size={15} />
          <span>{name}</span>
        </button>
        {canEdit && (
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
      {dialog && canEdit && (
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
