import { useEffect, useState } from "react";
import {
  ArrowRight,
  Clock3,
  Copy,
  FileCode2,
  FolderOpen,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Modal from "./Modal";
import { api, readLocal } from "../lib";
import {
  activityText,
  forgetLegacy,
  legacyShortcuts,
  relativeTime,
  type OwnedWorkspace,
} from "../workspaces";

export default function WorkspaceDashboard({
  navigate,
  onCreate,
  notify,
}: {
  navigate: (path: string) => void;
  onCreate: () => void;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState<OwnedWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [menu, setMenu] = useState<string | null>(null);
  const [target, setTarget] = useState<OwnedWorkspace | null>(null);
  const [mode, setMode] = useState<"rename" | "delete">("rename");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [legacy, setLegacy] = useState(legacyShortcuts);
  const [importing, setImporting] = useState(false);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  async function load() {
    try {
      const result = await api<{ workspaces: OwnedWorkspace[] }>("/me/workspaces");
      setItems(result.workspaces);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".shortcut-menu")
      )
        setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  // One-time import: claims each v1 browser shortcut with its editor link, then
  // deletes the stored token from this browser.
  async function importLegacy() {
    setImporting(true);
    const notes: string[] = [];
    for (const item of legacyShortcuts()) {
      try {
        await api(`/rooms/${item.id}/claim`, "POST", {}, item.token);
        forgetLegacy(item.id);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 403 || status === 409) {
          forgetLegacy(item.id);
          notes.push(
            `“${item.name}” was not imported: ${(e as Error).message}`,
          );
        } else notes.push(`“${item.name}”: ${(e as Error).message}`);
      }
    }
    setLegacy(legacyShortcuts());
    setImportNotes(notes);
    setImporting(false);
    await load();
    notify(notes.length ? "Import finished with notes" : "Workspaces added to your account");
  }
  const shown = (items ?? [])
    .filter((item) =>
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.updated_at - a.updated_at,
    );
  const activity = (items ?? [])
    .flatMap((item) => item.activity.map((event) => ({ event, item })))
    .sort((a, b) => b.event.created_at - a.event.created_at)
    .slice(0, 8);
  async function copyStudentLink(item: OwnedWorkspace) {
    try {
      await navigator.clipboard.writeText(location.origin + "/w/" + item.id);
      notify("Student link copied");
    } catch {
      notify("Clipboard unavailable. Open the workspace and use Share.");
    }
    setMenu(null);
  }
  return (
    <section className="workspace-dashboard" aria-label="My Workspaces">
      <div className="dashboard-heading">
        <div>
          <h2>My Workspaces</h2>
          <p>Your workspaces, on every device you sign in to.</p>
        </div>
        <button className="button primary" onClick={onCreate}>
          <Plus size={16} /> Create Workspace
        </button>
      </div>
      {!!legacy.length && (
        <div className="import-banner" role="region" aria-label="Import workspaces">
          <History size={18} />
          <div>
            <strong>
              {legacy.length} workspace{legacy.length === 1 ? "" : "s"} saved
              in this browser
            </strong>
            <p>
              Add the workspaces you opened with private editor links in this
              browser to your account. Their links keep working, and the saved
              links are then removed from this browser.
            </p>
          </div>
          <button
            className="button primary"
            onClick={() => void importLegacy()}
            disabled={importing}
          >
            {importing && <Loader2 size={15} className="spin" />} Add to my
            account
          </button>
        </div>
      )}
      {!!importNotes.length && (
        <ul className="import-notes">
          {importNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {!!items?.length && (
        <div className="dashboard-filters">
          <label>
            <Search size={16} />
            <input
              aria-label="Search workspaces"
              placeholder="Search your workspaces"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="Sort workspaces"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recently updated</option>
            <option value="name">Name</option>
          </select>
        </div>
      )}
      {loadError ? (
        <p className="error" role="alert">
          {loadError}
        </p>
      ) : !items ? (
        <p className="dashboard-empty">
          <Loader2 size={20} className="spin" /> Loading your workspaces…
        </p>
      ) : !items.length ? (
        <div className="dashboard-empty">
          <FolderOpen size={30} />
          <h3>Your workspace starts here.</h3>
          <p>Create a workspace for your next class, project, or lab.</p>
          <button className="button primary" onClick={onCreate}>
            <Plus size={16} /> Create Workspace
          </button>
        </div>
      ) : !shown.length ? (
        <p className="dashboard-empty">No workspaces match your search.</p>
      ) : (
        <div className="workspace-grid">
          {shown.map((item) => (
            <article
              className="workspace-card"
              key={item.id}
              aria-label={item.name}
            >
              <div className="workspace-card-top">
                <span className="workspace-card-icon">
                  <FolderOpen size={19} />
                </span>
                <div className="shortcut-menu">
                  <button
                    className="icon-button"
                    aria-label={`Manage ${item.name}`}
                    aria-expanded={menu === item.id}
                    onClick={() => setMenu(menu === item.id ? null : item.id)}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {menu === item.id && (
                    <div role="menu">
                      <button
                        onClick={() => {
                          setTarget(item);
                          setMode("rename");
                          setDraft(item.name);
                          setError("");
                          setMenu(null);
                        }}
                      >
                        <Pencil size={14} /> Rename workspace
                      </button>
                      <button onClick={() => void copyStudentLink(item)}>
                        <Copy size={14} /> Copy Student Link
                      </button>
                      <button
                        className="danger-item"
                        onClick={() => {
                          setTarget(item);
                          setMode("delete");
                          setDraft("");
                          setMenu(null);
                          setError("");
                        }}
                      >
                        <Trash2 size={14} /> Delete workspace
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <h3>{item.name}</h3>
              <p className="workspace-description">
                {item.description || "Lessons, files and code examples."}
              </p>
              <div className="workspace-card-counts">
                <FileCode2 size={14} /> {item.files} file
                {item.files === 1 ? "" : "s"}
                {item.folders
                  ? ` · ${item.folders} folder${item.folders === 1 ? "" : "s"}`
                  : ""}
              </div>
              <div className="workspace-card-bottom">
                <span>Updated {relativeTime(item.updated_at)}</span>
                <button
                  className="text-button"
                  onClick={() => {
                    const lesson = readLocal<string | null>(
                      "devshare.lastLesson." + item.id,
                      null,
                    );
                    navigate(
                      "/w/" +
                        item.id +
                        (lesson && /^[\w-]{36}$/.test(lesson)
                          ? "?folder=" + lesson
                          : ""),
                    );
                  }}
                >
                  Open <ArrowRight size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!!activity.length && (
        <section className="recent-activity" aria-label="Recent activity">
          <h3>
            <Clock3 size={15} /> Recent activity
          </h3>
          {activity.map(({ event, item }) => (
            <div className="activity-row" key={event.id}>
              <span>
                <strong>{activityText(event)}</strong>
                <small>{item.name}</small>
              </span>
              <time dateTime={new Date(event.created_at).toISOString()}>
                {relativeTime(event.created_at)}
              </time>
            </div>
          ))}
        </section>
      )}
      {target && (
        <Modal
          title={mode === "rename" ? "Rename workspace" : "Delete workspace?"}
          onClose={() => {
            if (!busy) setTarget(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                if (mode === "delete") {
                  await api(`/rooms/${target.id}`, "DELETE");
                  notify("Workspace permanently deleted");
                } else {
                  await api(`/rooms/${target.id}`, "PATCH", { name: draft });
                  notify("Workspace renamed");
                }
                setTarget(null);
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "rename" ? (
              <label className="field">
                Workspace name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
            ) : (
              <>
                <p className="modal-description">
                  “{target.name}” and all of its folders, files and lessons will
                  be permanently deleted for everyone, including students using
                  its link. This cannot be undone.
                </p>
                <label className="field">
                  Type the workspace name to confirm
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </label>
              </>
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
                onClick={() => setTarget(null)}
              >
                Cancel
              </button>
              <button
                className={"button " + (mode === "delete" ? "danger" : "primary")}
                disabled={
                  busy ||
                  (mode === "rename" ? !draft.trim() : draft !== target.name)
                }
              >
                {mode === "rename" ? "Save name" : "Delete workspace"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
