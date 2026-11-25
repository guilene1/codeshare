import { useEffect, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Loader2, MoreHorizontal, Pencil, Plus, Radio, Trash2, Users } from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import { relativeTime } from "../workspaces";
import { CopyButton, folderOptions, STATUS_LABEL, useDestinations, type LiveInfo } from "./LiveSession";

// The dashboard's Live Coding section: create sessions, see the active and previous ones,
// reopen, rename, archive and delete them.
type Row = LiveInfo & { viewers: number };
export default function LiveDashboard({ navigate, notify }: { navigate: (path: string) => void; notify: (message: string) => void }) {
  const [sessions, setSessions] = useState<Row[] | null>(null),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [menu, setMenu] = useState<string | null>(null),
    [target, setTarget] = useState<{ row: Row; mode: "rename" | "delete" } | null>(null),
    [tab, setTab] = useState<"active" | "previous">("active");
  const load = () =>
    api<{ sessions: Row[] }>("/live")
      .then((r) => {
        setSessions(r.sessions);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []);
  const active = (sessions ?? []).filter((s) => s.status === "draft" || s.status === "live" || s.status === "paused");
  const previous = (sessions ?? []).filter((s) => s.status === "ended" || s.status === "archived");
  const shown = tab === "active" ? active : previous;
  async function setStatus(row: Row, status: string) {
    setMenu(null);
    try {
      await api(`/live/${row.id}/status`, "POST", { status });
      notify(status === "archived" ? "Session archived" : "Session restored");
      void load();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <section className="live-dashboard" aria-label="Live Coding">
      <div className="dashboard-heading">
        <div>
          <h2>Live Coding</h2>
          <p>Share code and notes with your class in real time, without Zoom chat. Students watch and copy as you type.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Create Session
        </button>
      </div>
      <div className="dashboard-filters live-tabs" role="tablist" aria-label="Sessions">
        <button role="tab" aria-selected={tab === "active"} className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
          Active <span>{active.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "previous"} className={tab === "previous" ? "active" : ""} onClick={() => setTab("previous")}>
          Previous <span>{previous.length}</span>
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!sessions && !error && <Loader2 size={20} className="spin" />}
      {sessions && !shown.length && (
        <div className="dashboard-empty">
          <Radio size={26} />
          <p>{tab === "active" ? "No active sessions. Create one before class and share its link." : "Ended and archived sessions appear here."}</p>
        </div>
      )}
      <div className="workspace-grid live-grid">
        {shown.map((row) => (
          <article key={row.id} className="workspace-card live-card">
            <div className="live-card-top">
              <span className={"live-pill " + row.status}>{STATUS_LABEL[row.status].toUpperCase()}</span>
              {(row.status === "live" || row.status === "paused") && (
                <span className="live-card-viewers" title="Connected viewers">
                  <Users size={13} /> {row.viewers}
                </span>
              )}
              {row.role === "owner" && (
                <details className="folder-menu live-card-menu" open={menu === row.id}>
                  <summary
                    aria-label={"Manage session " + row.name}
                    onClick={(event) => {
                      event.preventDefault();
                      setMenu(menu === row.id ? null : row.id);
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </summary>
                  <div>
                    <button onClick={() => (setMenu(null), setTarget({ row, mode: "rename" }))}>
                      <Pencil size={12} /> Rename
                    </button>
                    {row.status === "ended" && (
                      <button onClick={() => void setStatus(row, "archived")}>
                        <Archive size={12} /> Archive
                      </button>
                    )}
                    {row.status === "archived" && (
                      <button onClick={() => void setStatus(row, "ended")}>
                        <ArchiveRestore size={12} /> Unarchive
                      </button>
                    )}
                    <button onClick={() => (setMenu(null), setTarget({ row, mode: "delete" }))}>
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                </details>
              )}
            </div>
            <h3 title={row.name}>{row.name}</h3>
            <p className="workspace-description">
              {row.description ||
                (row.workspace ? `${row.workspace.name}${row.folder ? " › " + row.folder.name : ""}` : "Standalone session")}
            </p>
            <div className="workspace-card-bottom">
              <span>
                {row.role === "owner" ? "Yours" : row.role === "editor" ? `Collaborating with ${row.ownerName}` : `Invited by ${row.ownerName}`} ·{" "}
                {relativeTime(row.updatedAt)}
              </span>
              <span className="live-card-actions">
                {row.role === "owner" && row.status !== "archived" && (
                  <CopyButton
                    className="text-button"
                    label="Copy link"
                    onError={notify}
                    value={async () => {
                      const r = await api<{ token: string | null }>(`/live/${row.id}/link`);
                      if (!r.token) throw new Error("This session has no link. Create one in its Settings.");
                      return `${location.origin}/live/${r.token}`;
                    }}
                  />
                )}
                <button className="text-button" onClick={() => navigate(`/live-sessions/${row.id}`)}>
                  Open
                </button>
              </span>
            </div>
          </article>
        ))}
      </div>
      {creating && <CreateSession onClose={() => setCreating(false)} onCreated={(id) => navigate(`/live-sessions/${id}`)} />}
      {target && (
        <RenameOrDelete
          row={target.row}
          mode={target.mode}
          onClose={() => setTarget(null)}
          onDone={(message) => {
            notify(message);
            setTarget(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function CreateSession({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const destinations = useDestinations();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [folders, setFolders] = useState<Array<{ id: string; parent_id: string | null; name: string }>>([]),
    [folder, setFolder] = useState(""),
    [access, setAccess] = useState("anyone"),
    [collaborators, setCollaborators] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setFolder("");
    if (!workspace) return setFolders([]);
    api<{ folders: typeof folders }>(`/rooms/${workspace}/tree`)
      .then((tree) => setFolders(tree.folders))
      .catch(() => setFolders([]));
  }, [workspace]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/live", "POST", {
        name,
        description,
        viewerAccess: access,
        ...(workspace ? { workspaceId: workspace, folderId: folder || null } : {}),
        collaborators: collaborators
          .split(/[\s,;]+/)
          .map((v) => v.trim())
          .filter(Boolean),
      });
      onCreated(r.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Create Live Coding Session" onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        <label className="field">
          Session name
          <input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Week 06 – Ansible Live Coding" />
        </label>
        <label className="field">
          Description <span className="optional">(optional)</span>
          <input maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          Workspace <span className="optional">(optional)</span>
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">None (standalone session)</option>
            {destinations?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {workspace && (
          <label className="field">
            Folder <span className="optional">(optional)</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">Workspace root</option>
              {folderOptions(folders).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Viewer access
          <select value={access} onChange={(e) => setAccess(e.target.value)}>
            <option value="anyone">Anyone with the session link (Read-only)</option>
            <option value="signed_in">Signed-in Kodelumi accounts with the link</option>
            <option value="invited">Only people I invite</option>
          </select>
        </label>
        <label className="field">
          Collaborators <span className="optional">(optional: Kodelumi account emails, who can edit with you)</span>
          <input value={collaborators} onChange={(e) => setCollaborators(e.target.value)} placeholder="ta@example.com" />
        </label>
        {workspace && (
          <p className="fine-print">
            The session follows that folder’s locks: while it is locked, only you (and people allowed to open locked content) can open the
            session.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 size={15} className="spin" />} Create Session
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RenameOrDelete({ row, mode, onClose, onDone }: { row: Row; mode: "rename" | "delete"; onClose: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState(row.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "rename") await api(`/live/${row.id}`, "PATCH", { name });
      else await api(`/live/${row.id}`, "DELETE");
      onDone(mode === "rename" ? "Session renamed" : "Session deleted");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={mode === "rename" ? "Rename session" : "Delete session"} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        {mode === "rename" ? (
          <label className="field">
            Session name
            <input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        ) : (
          <p className="modal-description">
            Permanently delete “{row.name}”, its files and images? Viewers are disconnected and its link stops working. Files you saved to a
            workspace stay there.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || (mode === "rename" && !name.trim())}>
            {busy && <Loader2 size={15} className="spin" />} {mode === "rename" ? "Rename Session" : "Delete Session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
