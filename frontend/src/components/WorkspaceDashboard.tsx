import { useEffect, useState } from "react";
import {
  ArrowRight,
  Clock3,
  Copy,
  FileCode2,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import {
  activityText,
  editorPath,
  forget,
  relativeTime,
  remember,
  shortcuts,
  summary,
  type Shortcut,
  type WorkspaceSummary,
} from "../workspaces";

export default function WorkspaceDashboard({
  compact = false,
  navigate,
  onCreate,
  notify,
}: {
  compact?: boolean;
  navigate: (path: string) => void;
  onCreate: () => void;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState(shortcuts);
  const [details, setDetails] = useState<Record<string, WorkspaceSummary>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [menu, setMenu] = useState<string | null>(null);
  const [target, setTarget] = useState<Shortcut | null>(null);
  const [mode, setMode] = useState<"rename" | "remove">("rename");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    async function load() {
      // Metadata only, with bounded concurrency; no lesson Yjs documents are loaded.
      const visible = compact ? items.slice(0, 6) : items;
      for (let index = 0; index < visible.length && !canceled; index += 4) {
        await Promise.all(
          visible.slice(index, index + 4).map(async (item) => {
            try {
              const value = await summary(item);
              if (!canceled) {
                setDetails((previous) => ({ ...previous, [item.id]: value }));
                setErrors((previous) => {
                  const next = { ...previous };
                  delete next[item.id];
                  return next;
                });
              }
            } catch (e) {
              if (!canceled)
                setErrors((previous) => ({
                  ...previous,
                  [item.id]: (e as Error).message,
                }));
            }
          }),
        );
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [compact, items]);
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
  const shown = items
    .filter((item) =>
      `${details[item.id]?.name ?? item.name} ${details[item.id]?.description ?? item.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? (details[a.id]?.name ?? a.name).localeCompare(
            details[b.id]?.name ?? b.name,
          )
        : Math.max(details[b.id]?.updated_at ?? 0, b.lastOpened) -
          Math.max(details[a.id]?.updated_at ?? 0, a.lastOpened),
    );
  const activity = items
    .flatMap((item) =>
      (details[item.id]?.activity ?? []).map((event) => ({ event, item })),
    )
    .sort((a, b) => b.event.created_at - a.event.created_at)
    .slice(0, compact ? 3 : 8);
  async function copy(item: Shortcut, privateLink: boolean) {
    try {
      await navigator.clipboard.writeText(
        location.origin +
          (privateLink
            ? editorPath(item)
            : `/w/${item.id}` + (item.folder ? `?folder=${item.folder}` : "")),
      );
      notify(
        privateLink
          ? "Editor link copied. Keep it private."
          : "Student link copied",
      );
    } catch {
      notify("Clipboard unavailable. Open the workspace and use Share.");
    }
    setMenu(null);
  }
  if (compact && !items.length) return null;
  return (
    <section
      className={"workspace-dashboard" + (compact ? " compact-dashboard" : "")}
      aria-label="My Workspaces"
    >
      <div className="dashboard-heading">
        <div>
          <h2>My Workspaces</h2>
          <p>Continue where you left off.</p>
        </div>
        {compact ? (
          <button
            className="text-button"
            onClick={() => navigate("/workspaces")}
          >
            View all workspaces <ArrowRight size={15} />
          </button>
        ) : (
          <button className="button primary" onClick={onCreate}>
            <Plus size={16} /> Create Workspace
          </button>
        )}
      </div>
      {!compact && (
        <>
          <p className="device-note">
            Private shortcuts are saved only in this browser. Your course
            content stays safely on the server.
          </p>
          {!!items.length && (
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
                <option value="recent">Recently used / updated</option>
                <option value="name">Name</option>
              </select>
            </div>
          )}
        </>
      )}
      {!items.length ? (
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
          {(compact ? shown.slice(0, 6) : shown).map((item) => {
            const value = details[item.id];
            return (
              <article
                className="workspace-card"
                key={item.id}
                aria-label={value?.name ?? item.name}
              >
                <div className="workspace-card-top">
                  <span className="workspace-card-icon">
                    <FolderOpen size={19} />
                  </span>
                  {!compact && (
                    <div className="shortcut-menu">
                      <button
                        className="icon-button"
                        aria-label={`Manage ${value?.name ?? item.name}`}
                        aria-expanded={menu === item.id}
                        onClick={() =>
                          setMenu(menu === item.id ? null : item.id)
                        }
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      {menu === item.id && (
                        <div role="menu">
                          <button
                            onClick={() => {
                              setTarget(item);
                              setMode("rename");
                              setDraft(value?.name ?? item.name);
                              setError("");
                              setMenu(null);
                            }}
                          >
                            <Pencil size={14} /> Rename workspace
                          </button>
                          <button onClick={() => void copy(item, false)}>
                            <Copy size={14} /> Copy Student Link
                          </button>
                          <button onClick={() => void copy(item, true)}>
                            <Copy size={14} /> Copy Editor Link
                          </button>
                          <button
                            onClick={() => {
                              setTarget(item);
                              setMode("remove");
                              setMenu(null);
                              setError("");
                            }}
                          >
                            <Trash2 size={14} /> Remove from My Workspaces
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <h3>{value?.name ?? item.name}</h3>
                <p className="workspace-description">
                  {value?.description ||
                    item.description ||
                    "Lessons, files and reusable snippets."}
                </p>
                <div className="workspace-card-counts">
                  <FileCode2 size={14} />{" "}
                  {value
                    ? `${value.files} file${value.files === 1 ? "" : "s"} · ${value.blocks} code block${value.blocks === 1 ? "" : "s"}`
                    : errors[item.id]
                      ? "Unavailable"
                      : "Loading workspace details…"}
                </div>
                {errors[item.id] && (
                  <p className="shortcut-error">
                    {errors[item.id]} The shortcut is kept so you can recover
                    access or remove it.
                  </p>
                )}
                <div className="workspace-card-bottom">
                  <span>
                    Updated {relativeTime(value?.updated_at ?? item.lastOpened)}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => navigate(editorPath(item))}
                  >
                    Open <ArrowRight size={15} />
                  </button>
                </div>
              </article>
            );
          })}
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
                <small>{details[item.id]?.name ?? item.name}</small>
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
          title={
            mode === "rename" ? "Rename workspace" : "Remove from My Workspaces"
          }
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
                if (mode === "remove") {
                  forget(target.id);
                  notify(
                    "Local shortcut removed. Workspace content is preserved.",
                  );
                } else {
                  await api(
                    `/rooms/${target.id}`,
                    "PATCH",
                    { name: draft },
                    target.token,
                  );
                  remember({ ...target, name: draft.trim() });
                  notify("Workspace renamed");
                }
                setItems(shortcuts());
                setTarget(null);
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
              <p className="modal-description">
                This removes only the shortcut from this browser. All folders,
                files and code blocks remain on the server. Keep the private
                editor link to open it again.
              </p>
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
                className="button primary"
                disabled={busy || (mode === "rename" && !draft.trim())}
              >
                {mode === "rename" ? "Save name" : "Remove shortcut"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
