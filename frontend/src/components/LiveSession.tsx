import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Download,
  FileCode2,
  FolderInput,
  ImagePlus,
  Loader2,
  Lock,
  Pause,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  Radio,
  Settings as SettingsIcon,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { WebsocketProvider } from "y-websocket";
import Modal from "./Modal";
import MarkdownPreview from "./MarkdownPreview";
import { ClassroomAwareness } from "./ClassroomAwareness";
import { Logo } from "../brand";
import { useAuth } from "../auth";
import { setLiveImageCredential } from "../imageSrc";
import { imageMarkdown, insertBlock, isDocumentLanguage } from "../markdown";
import {
  api,
  defaults,
  inferLanguage,
  languages,
  readLocal,
  releaseLong,
  uploadLiveImage,
  type FileDoc,
  type Settings,
} from "../lib";
const CodeEditor = lazy(() => import("./CodeEditor"));

// A Live Coding session: the instructor (and invited collaborators) write files that viewers
// watch arrive in real time. Viewers read, copy and (when allowed) download; they never write.
export type LiveStatus = "draft" | "live" | "paused" | "ended" | "archived";
export type LiveInfo = {
  id: string;
  name: string;
  description: string;
  status: LiveStatus;
  role: "owner" | "editor" | "viewer";
  allowDownload: boolean;
  ownerName: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  viewerAccess?: "anyone" | "signed_in" | "invited";
  afterEnd?: "closed" | "available";
  hasLink?: boolean;
  linkExpiresAt?: number | null;
  workspace?: { id: string; name: string } | null;
  folder?: { id: string; name: string } | null;
  members?: Array<{ userId: string; displayName: string; email: string; role: "editor" | "viewer" }>;
};
type Denied = { status: number; error: string; state?: string; locked?: boolean; releaseAt?: number | null; name?: string };
export const STATUS_LABEL: Record<LiveStatus, string> = {
  draft: "Draft",
  live: "Live",
  paused: "Paused",
  ended: "Ended",
  archived: "Archived",
};
const colors = ["#a78bfa", "#38bdf8", "#fb923c", "#34d399", "#f472b6", "#facc15"];
// GET with the session link (viewers) or the session cookie; refusals keep their details.
async function liveGet(path: string, token?: string) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
// A copy button that turns green with a checkmark and "Copied!" for 2 seconds.
export function CopyButton({
  value,
  label,
  className = "button secondary",
  icon = true,
  onError,
}: {
  value: () => Promise<string> | string;
  label: string;
  className?: string;
  icon?: boolean;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className={className + (copied ? " copied" : "")}
      aria-label={copied ? undefined : label}
      onClick={async () => {
        try {
          const text = await value();
          if (!(await copyText(text))) throw new Error("Couldn’t copy. Select the text and press Ctrl+C (⌘C on a Mac).");
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch (e) {
          onError((e as Error).message);
        }
      }}
    >
      {copied ? <Check size={15} /> : icon ? <Copy size={15} /> : null}
      <span>{copied ? "Copied!" : label}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label}: copied` : ""}
      </span>
    </button>
  );
}

export default function LiveSession({
  sessionId,
  token,
  navigate,
  notify,
  dark,
  themeButton,
}: {
  sessionId?: string;
  token?: string;
  navigate: (path: string) => void;
  notify: (message: string) => void;
  dark: boolean;
  themeButton: React.ReactNode;
}) {
  const { user } = useAuth();
  const [info, setInfo] = useState<LiveInfo | null>(null),
    [denied, setDenied] = useState<Denied | null>(null),
    [ended, setEnded] = useState(""),
    [error, setError] = useState(""),
    [provider, setProvider] = useState<WebsocketProvider | null>(null),
    [files, setFiles] = useState<FileDoc[]>([]),
    [openTabs, setOpenTabs] = useState<string[]>([]),
    [active, setActive] = useState(""),
    [status, setStatus] = useState("connecting"),
    [synced, setSynced] = useState(false),
    [viewers, setViewers] = useState(0),
    [saving, setSaving] = useState(false),
    [follow, setFollow] = useState(true),
    [mode, setMode] = useState<"edit" | "preview">("edit"),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 560),
    [dialog, setDialog] = useState<null | "new" | "rename" | "delete" | "settings" | "save" | "end">(null),
    [busy, setBusy] = useState(false);
  const settings = useMemo<Settings>(() => ({ ...defaults, ...readLocal<Partial<Settings>>("devshare.settings", {}) }), []);
  const runner = info?.role === "owner" || info?.role === "editor";
  const owner = info?.role === "owner";
  const writable = runner && info?.status !== "ended" && info?.status !== "archived";
  const current = openTabs.includes(active) ? files.find((f) => f.id === active) : undefined;
  // Viewers' images load with their link; cleared on leaving.
  setLiveImageCredential(token);
  useEffect(() => () => setLiveImageCredential(undefined), []);
  const load = async () => {
    const r = token ? await liveGet("/live/access", token) : await liveGet(`/live/${sessionId}`);
    if (r.ok) {
      // A runner who opened the viewer link works in the full session view.
      if (token && (r.json.role === "owner" || r.json.role === "editor")) {
        navigate(`/live-sessions/${r.json.id}`);
        return;
      }
      setInfo(r.json as LiveInfo);
      setDenied(null);
    } else
      setDenied({
        status: r.status,
        ...(r.json as { error: string }),
        error:
          (r.json as { error?: string }).error ??
          ([502, 503, 504].includes(r.status)
            ? "Kodelumi is temporarily unavailable for maintenance. Please try again in a few minutes."
            : "This session couldn’t be opened. Try again."),
      });
  };
  useEffect(() => {
    void load();
  }, [sessionId, token]);
  // Waiting for the session to start (or its content to be released): a light check every 20 s
  // and whenever the tab is shown again.
  useEffect(() => {
    if (!denied || !(denied.state === "draft" || denied.locked)) return;
    const timer = setInterval(() => void load(), 20_000);
    const shown = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [denied?.state, denied?.locked]);
  const api$ = <T,>(path: string, method = "GET", body?: unknown) => api<T>(path, method, body, token);
  useEffect(() => {
    if (!info || denied) return;
    const viewer = info.role === "viewer";
    const doc = new Y.Doc();
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/live`;
    const p = new WebsocketProvider(url, info.id, doc, {
      awareness: new ClassroomAwareness(doc, viewer),
      connect: false,
      disableBc: true,
      protocols: token ? ["devshare", "live." + token] : ["devshare"],
    });
    if (!viewer) p.awareness.setLocalStateField("user", { name: (user?.displayName ?? "Instructor").slice(0, 40), color: colors[doc.clientID % colors.length] });
    else p.awareness.setLocalState({ viewer: true });
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (_update?: Uint8Array, origin?: unknown) => {
      const list: FileDoc[] = [];
      doc.getMap<Y.Map<unknown>>("documents").forEach((item) =>
        list.push({
          id: item.get("id") as string,
          filename: item.get("filename") as string,
          language: item.get("language") as string,
          content: item.get("content") as Y.Text,
          createdAt: item.get("createdAt") as number,
          updatedAt: item.get("updatedAt") as number,
          position: item.get("position") as number,
        }),
      );
      list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      setFiles(list);
      if (!viewer && origin !== p) {
        setSaving(true);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => setSaving(false), 1800);
      }
    };
    // Viewers follow the file an instructor is working in (they can turn it off).
    const followEditor = () => {
      if (!viewer) return;
      for (const [id, state] of p.awareness.getStates())
        if (id !== doc.clientID && state.role === "editor" && typeof state.fileId === "string") {
          followTarget.current = state.fileId;
          if (followRef.current) {
            setOpenTabs((tabs) => (tabs.includes(state.fileId) ? tabs : [...tabs, state.fileId]));
            setActive(state.fileId);
          }
          break;
        }
    };
    p.messageHandlers[4] = (_encoder, decoder) => {
      const message = JSON.parse(decoding.readVarString(decoder)) as { live?: { viewers: number; status: LiveStatus } };
      if (message.live) setViewers(message.live.viewers);
    };
    p.messageHandlers[5] = (_encoder, decoder) => {
      const notice = JSON.parse(decoding.readVarString(decoder)) as { live?: { status?: LiveStatus; settings?: boolean } };
      const next = notice.live?.status;
      if (next) setInfo((value) => (value ? { ...value, status: next } : value));
      if (notice.live?.settings) void load();
    };
    const onStatus = ({ status: value }: { status: string }) => {
      setStatus(value);
      if (value !== "connected") setSynced(false);
    };
    const onClose = (event: CloseEvent | null) => {
      if (event?.code === 4002 || event?.code === 1008) {
        p.shouldConnect = false;
        if (event.code === 4002) setEnded(event.reason || "This session is no longer available.");
        else setError(event.reason || "The connection was closed.");
        void load();
      }
    };
    doc.on("update", refresh);
    p.on("status", onStatus);
    p.on("sync", setSynced);
    p.on("connection-close", onClose);
    p.awareness.on("change", followEditor);
    setProvider(p);
    p.connect();
    return () => {
      clearTimeout(saveTimer);
      doc.off("update", refresh);
      p.awareness.off("change", followEditor);
      p.off("status", onStatus);
      p.off("sync", setSynced);
      p.off("connection-close", onClose);
      p.destroy();
      doc.destroy();
      setProvider(null);
    };
  }, [info?.id, info?.role, !!denied]);
  const followRef = useRef(follow);
  followRef.current = follow;
  const followTarget = useRef<string | null>(null);
  // The first file opens when the session arrives; deleted files leave the tabs.
  useEffect(() => {
    if (!synced) return;
    setOpenTabs((tabs) => {
      const kept = [...new Set(tabs)].filter((tab) => files.some((f) => f.id === tab));
      return kept.length || !files[0] ? kept : [files[0].id];
    });
    setActive((value) => (files.some((f) => f.id === value) ? value : (files[0]?.id ?? "")));
  }, [files, synced]);
  useEffect(() => {
    if (current && runner) provider?.awareness.setLocalStateField("fileId", current.id);
  }, [current?.id, provider, runner]);
  const connected = status === "connected" && synced;
  async function setSessionStatus(next: LiveStatus) {
    setBusy(true);
    try {
      const value = await api$<LiveInfo>(`/live/${info!.id}/status`, "POST", { status: next });
      setInfo((old) => (old ? { ...old, ...value } : value));
      notify(
        next === "live"
          ? info!.status === "paused"
            ? "Session resumed: viewers catch up now"
            : "You're live"
          : next === "paused"
            ? "Session paused: viewers keep what they have"
            : next === "ended"
              ? "Session ended"
              : next === "archived"
                ? "Session archived"
                : "Session updated",
      );
      setDialog(null);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sessionLink = async () => {
    const r = await api$<{ token: string | null }>(`/live/${info!.id}/link`);
    if (!r.token) throw new Error("This session has no link. Create one in Settings.");
    return `${location.origin}/live/${r.token}`;
  };
  function download(file: FileDoc) {
    const url = URL.createObjectURL(new Blob([file.content.toString()], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function insertImage(file: File) {
    if (!current || !info) return;
    try {
      const result = await uploadLiveImage(info.id, file);
      const text = current.content.toString();
      current.content.insert(text.length, insertBlock(text, text.length, imageMarkdown(file.name.replace(/\.[^.]+$/, ""), `/api/live/${info.id}/images/${result.id}`)).insert);
      notify("Image added");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  // ---- Screens before the session itself.
  if (denied || ended)
    return (
      <div className="center-state live-page" role="region" aria-label="Live session">
        <Logo />
        {denied?.state === "draft" ? (
          <>
            <h2>{denied.name ?? "This session"} hasn’t started yet</h2>
            <p className="muted">It opens here automatically when your instructor goes live.</p>
            <Loader2 size={20} className="spin" />
          </>
        ) : denied?.locked ? (
          <>
            <Lock size={28} className="live-locked" />
            <h2>This session is locked</h2>
            <p className="muted">
              {denied.releaseAt ? `It opens on ${releaseLong(denied.releaseAt)}.` : "It opens when your instructor releases its content."}
            </p>
          </>
        ) : (
          <>
            <h2>{ended ? "Session closed" : denied?.status === 410 ? "This session has ended" : "We couldn’t open this session"}</h2>
            <p className="error" role="alert">
              {ended || denied?.error}
            </p>
            {denied?.status === 401 && (
              <button className="button primary" onClick={() => navigate("/signin?next=" + encodeURIComponent(location.pathname))}>
                Sign in
              </button>
            )}
          </>
        )}
        <button className="button secondary" onClick={() => navigate(user ? "/workspaces?view=live" : "/")}>
          {user ? "My Live Sessions" : "Back to home"}
        </button>
      </div>
    );
  if (!info)
    return (
      <div className="center-state">
        <Logo />
        <Loader2 size={28} className="spin" />
        <p>Opening the session…</p>
      </div>
    );
  const pill = (
    <span className={"live-pill " + info.status} aria-label={`Session ${STATUS_LABEL[info.status]}`}>
      {info.status === "live" ? <Radio size={13} /> : info.status === "paused" ? <Pause size={13} /> : <Square size={11} />}
      {STATUS_LABEL[info.status].toUpperCase()}
      {runner && (info.status === "live" || info.status === "paused") && (
        <span className="live-viewers">
          {" "}
          • <Users size={13} /> {viewers} {viewers === 1 ? "viewer" : "viewers"}
        </span>
      )}
    </span>
  );
  const fileKey = current ? `${current.id}:${current.content.doc?.clientID ?? 0}` : "";
  const preview = !!current && isDocumentLanguage(current.language) && (!writable || mode === "preview");
  return (
    <div className="workspace live-page">
      <header className="workspace-nav">
        {user && (
          <button className="workspace-back text-button" onClick={() => navigate("/workspaces?view=live")} title="My Live Sessions">
            <ArrowLeft size={16} />
            <span>Live Sessions</span>
          </button>
        )}
        <span className="workspace-brand">
          <Logo />
        </span>
        <span className="nav-divider" />
        <div className="room-title">
          <span className="room-title-label">LIVE CODING</span>
          <strong title={info.name}>{info.name}</strong>
        </div>
        {pill}
        <div className="nav-right">
          {owner && (
            <CopyButton className="button primary live-copy-link" label="Copy Session Link" value={sessionLink} onError={notify} />
          )}
          {owner && info.status === "draft" && (
            <button className="button primary" disabled={busy} onClick={() => void setSessionStatus("live")}>
              <Play size={15} /> <span>Go Live</span>
            </button>
          )}
          {owner && info.status === "live" && (
            <button className="button secondary" disabled={busy} onClick={() => void setSessionStatus("paused")}>
              <Pause size={15} /> <span>Pause</span>
            </button>
          )}
          {owner && info.status === "paused" && (
            <button className="button secondary" disabled={busy} onClick={() => void setSessionStatus("live")}>
              <Play size={15} /> <span>Resume</span>
            </button>
          )}
          {owner && (info.status === "live" || info.status === "paused") && (
            <button className="button secondary live-end" disabled={busy} onClick={() => setDialog("end")}>
              <Square size={13} /> <span>End Session</span>
            </button>
          )}
          {owner && info.status === "ended" && (
            <button className="button secondary" disabled={busy} onClick={() => void setSessionStatus("paused")} title="Reopen privately (paused), then resume">
              <Play size={15} /> <span>Reopen</span>
            </button>
          )}
          {owner && (
            <button className="icon-button" aria-label="Session settings" title="Settings" onClick={() => setDialog("settings")}>
              <SettingsIcon size={18} />
            </button>
          )}
          {themeButton}
        </div>
      </header>
      {info.status === "paused" && (
        <div className="live-banner" role="status">
          <Pause size={15} />
          {runner ? "Paused: viewers keep what they had at the pause. Resume to send your changes." : "Your instructor paused the session. New changes appear when it resumes."}
        </div>
      )}
      {info.status === "ended" && (
        <div className="live-banner" role="status">
          <Square size={12} />
          {runner ? "This session has ended and is read-only. Reopen it to make changes, or save it to a workspace." : "This session has ended. You can still read and copy its files."}
        </div>
      )}
      <div className="workspace-body">
        {sidebar && (
          <aside className="sidebar live-sidebar">
            <div className="sidebar-heading">
              FILES
              {writable && (
                <button className="icon-button" aria-label="New file" disabled={!connected} onClick={() => setDialog("new")}>
                  <Plus size={16} />
                </button>
              )}
            </div>
            <div className="live-files" role="list" aria-label="Session files">
              {files.map((file) => (
                <div key={file.id} role="listitem" className={"live-file" + (file.id === current?.id ? " active" : "")}>
                  <button
                    className="tree-file"
                    onClick={() => {
                      setOpenTabs((tabs) => (tabs.includes(file.id) ? tabs : [...tabs, file.id]));
                      setActive(file.id);
                      if (window.innerWidth <= 560) setSidebar(false);
                    }}
                  >
                    <FileCode2 size={15} />
                    <span title={file.filename}>{file.filename}</span>
                  </button>
                </div>
              ))}
              {connected && !files.length && (
                <p className="muted live-empty">{writable ? "Create a file to start teaching." : "Your instructor’s files will appear here."}</p>
              )}
            </div>
            {info.role === "viewer" && (
              <label className="live-follow">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow the instructor’s file
              </label>
            )}
            {runner && info.workspace && (
              <p className="live-association" title="Associated workspace and folder">
                {info.workspace.name}
                {info.folder ? ` › ${info.folder.name}` : ""}
              </p>
            )}
            <div className="sidebar-bottom">
              <span className="live-dot" />
              {runner ? "Live session" : `${info.ownerName ?? "Instructor"}’s session`}
            </div>
          </aside>
        )}
        <main className="editor-main">
          <div className="tab-bar">
            <button className="icon-button" aria-label="Toggle files" onClick={() => setSidebar(!sidebar)}>
              <PanelLeft size={16} />
            </button>
            <div className="tabs" role="tablist" aria-label="Open files">
              {openTabs.map((tabId) => {
                const f = files.find((file) => file.id === tabId);
                if (!f) return null;
                return (
                  <div
                    role="tab"
                    tabIndex={0}
                    aria-label={f.filename}
                    aria-selected={current?.id === f.id}
                    key={f.id}
                    className={"file-tab " + (current?.id === f.id ? "active" : "")}
                    onClick={() => setActive(f.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActive(f.id)}
                  >
                    <FileCode2 size={15} />
                    {f.filename}
                    {/* Closing a tab only hides it here; the file stays in the session. */}
                    <button
                      className="tab-close"
                      aria-label={"Close " + f.filename}
                      onClick={(e) => {
                        e.stopPropagation();
                        const rest = openTabs.filter((t) => t !== f.id);
                        setOpenTabs(rest);
                        if (active === f.id) setActive(rest[0] ?? "");
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
            {writable && (
              <button className="icon-button" aria-label="Add file tab" title="New file" disabled={!connected} onClick={() => setDialog("new")}>
                <Plus size={17} />
              </button>
            )}
          </div>
          <div className="editor-breadcrumb">
            <span>{info.name}</span>
            <FileCode2 size={13} />
            <span>{current?.filename ?? (connected ? "No file open" : "Connecting…")}</span>
            <div className="editor-actions">
              {writable && current && (
                <select
                  aria-label="Programming language"
                  className="language-select"
                  value={current.language}
                  disabled={!connected}
                  onChange={(e) =>
                    void api$(`/live/${info.id}/files/${current.id}`, "PATCH", { language: e.target.value }).catch((err) => notify(err.message))
                  }
                >
                  {languages.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              {writable && current && isDocumentLanguage(current.language) && (
                <>
                  <label className="text-button insert-block-button" title="Insert an image">
                    <ImagePlus size={14} /> Insert Image
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      onChange={(e) => {
                        const chosen = e.target.files?.[0];
                        e.target.value = "";
                        if (chosen) void insertImage(chosen);
                      }}
                    />
                  </label>
                  <div className="markdown-switch" aria-label="Markdown view">
                    <button aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
                      Edit
                    </button>
                    <button aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                      Preview
                    </button>
                  </div>
                </>
              )}
              {current && (
                <CopyButton className="text-button live-copy-file" label="Copy file" value={() => current.content.toString()} onError={notify} />
              )}
              {current && (runner || info.allowDownload) && (
                <button className="icon-button" aria-label="Download file" title="Download file" onClick={() => download(current)}>
                  <Download size={15} />
                </button>
              )}
              {writable && current && (
                <>
                  {[
                    [-1, "Move file up", <ArrowUp size={14} key="u" />],
                    [1, "Move file down", <ArrowDown size={14} key="d" />],
                  ].map(([step, label, icon]) => {
                    const index = files.findIndex((f) => f.id === current.id);
                    const target = index + (step as number);
                    return (
                      <button
                        key={label as string}
                        className="icon-button"
                        aria-label={label as string}
                        title={label as string}
                        disabled={!connected || target < 0 || target >= files.length}
                        onClick={() => {
                          const ids = files.map((f) => f.id);
                          [ids[index], ids[target]] = [ids[target], ids[index]];
                          void api$(`/live/${info.id}/files-order`, "PATCH", { ids }).catch((e) => notify(e.message));
                        }}
                      >
                        {icon}
                      </button>
                    );
                  })}
                  <button className="icon-button" aria-label="Rename file" title="Rename file" disabled={!connected} onClick={() => setDialog("rename")}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-button" aria-label="Delete file" title="Delete file" disabled={!connected} onClick={() => setDialog("delete")}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
          {error && (
            <div className="connection-warning" role="alert">
              {error}
              <button onClick={() => location.reload()}>Refresh</button>
            </div>
          )}
          {!connected && provider && !error && (
            <div className="connection-warning">
              {status === "connected" ? "Syncing the session…" : "Reconnecting… The session continues when the connection returns."}
            </div>
          )}
          <div className="editor-surface">
            {provider && current && preview ? (
              <MarkdownPreview key={fileKey} file={current} fontSize={settings.fontSize} canEdit={false} canOpenOriginal={runner} plain={current.language === "plaintext"} notify={notify} />
            ) : provider && current ? (
              <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
                <CodeEditor
                  key={fileKey}
                  file={current}
                  readOnly={!writable}
                  provider={provider}
                  settings={settings}
                  dark={dark}
                  onPosition={() => {}}
                  onEditor={() => {}}
                />
              </Suspense>
            ) : (
              <div className="editor-loading">
                {connected ? (
                  <div className="empty-lesson">
                    <FileCode2 size={30} />
                    <p>{writable ? "No files yet." : "Your instructor’s files will appear here."}</p>
                    {writable && (
                      <button className="button primary" onClick={() => setDialog("new")}>
                        <Plus size={16} /> New File
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <Loader2 size={22} className="spin" /> Connecting to the session…
                  </>
                )}
              </div>
            )}
          </div>
          {runner && (
            <footer className="live-footer">
              <span className={"live-saved" + (saving ? " saving" : "")}>{!connected ? "Offline" : saving ? "Saving…" : "All changes saved"}</span>
              <button className="button secondary" disabled={!files.length} onClick={() => setDialog("save")}>
                <FolderInput size={15} /> Save to Workspace
              </button>
            </footer>
          )}
        </main>
      </div>
      {(dialog === "new" || dialog === "rename" || dialog === "delete") && (
        <FileDialog
          mode={dialog}
          file={dialog === "new" ? undefined : current}
          onClose={() => setDialog(null)}
          onSubmit={async (filename, language) => {
            if (dialog === "new") {
              const r = await api$<{ id: string }>(`/live/${info.id}/files`, "POST", { filename, language });
              setOpenTabs((tabs) => (tabs.includes(r.id) ? tabs : [...tabs, r.id]));
              setActive(r.id);
            } else if (dialog === "rename") await api$(`/live/${info.id}/files/${current!.id}`, "PATCH", { filename });
            else await api$(`/live/${info.id}/files/${current!.id}`, "DELETE");
            setDialog(null);
          }}
        />
      )}
      {dialog === "end" && (
        <Modal title="End this session?" onClose={() => !busy && setDialog(null)}>
          <p className="modal-description">
            Live broadcasting stops and the session becomes read-only.{" "}
            {info.afterEnd === "available"
              ? "Viewers can still read and copy its files (you allowed it in Settings)."
              : "Viewers are disconnected (you can let them keep reading in Settings)."}{" "}
            Its content stays saved, and you can save it to a workspace.
          </p>
          <div className="dialog-actions">
            <button className="button secondary" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="button primary" disabled={busy} onClick={() => void setSessionStatus("ended")}>
              {busy && <Loader2 size={15} className="spin" />} End Session
            </button>
          </div>
        </Modal>
      )}
      {dialog === "settings" && owner && (
        <LiveSettings info={info} onClose={() => setDialog(null)} onSaved={(value) => setInfo((old) => (old ? { ...old, ...value } : value))} notify={notify} />
      )}
      {dialog === "save" && runner && <SaveToWorkspace info={info} files={files} onClose={() => setDialog(null)} notify={notify} />}
    </div>
  );
}

function FileDialog({
  mode,
  file,
  onClose,
  onSubmit,
}: {
  mode: "new" | "rename" | "delete";
  file?: FileDoc;
  onClose: () => void;
  onSubmit: (filename: string, language: string) => Promise<void>;
}) {
  const [name, setName] = useState(mode === "rename" ? (file?.filename ?? "") : ""),
    [language, setLanguage] = useState("yaml"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim(), language);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={mode === "new" ? "New file" : mode === "rename" ? "Rename file" : "Delete file"} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        {mode === "delete" ? (
          <p className="modal-description">Delete “{file?.filename}” from this session? Viewers lose it at once.</p>
        ) : (
          <>
            <label className="field">
              Filename
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                placeholder="playbook.yaml"
                onChange={(e) => {
                  setName(e.target.value);
                  if (mode === "new" && e.target.value.includes(".")) setLanguage(inferLanguage(e.target.value.trim()));
                }}
              />
            </label>
            {mode === "new" && (
              <label className="field">
                Language
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {languages.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
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
          <button type="submit" className="button primary" disabled={busy || (mode !== "delete" && !name.trim())}>
            {busy && <Loader2 size={15} className="spin" />}
            {mode === "new" ? "Create File" : mode === "rename" ? "Rename File" : "Delete File"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Owner settings: name, who can watch, what happens after the end, downloads, the link
// (expiry, replace, revoke) and invited people.
function LiveSettings({
  info,
  onClose,
  onSaved,
  notify,
}: {
  info: LiveInfo;
  onClose: () => void;
  onSaved: (value: LiveInfo) => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(info.name),
    [description, setDescription] = useState(info.description),
    [access, setAccess] = useState(info.viewerAccess ?? "anyone"),
    [afterEnd, setAfterEnd] = useState(info.afterEnd ?? "closed"),
    [allowDownload, setAllowDownload] = useState(info.allowDownload),
    [expires, setExpires] = useState(info.linkExpiresAt ? toLocalInput(info.linkExpiresAt) : ""),
    [members, setMembers] = useState(info.members ?? []),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<"editor" | "viewer">("editor"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api<LiveInfo>(`/live/${info.id}`)
      .then((value) => setMembers(value.members ?? []))
      .catch(() => {});
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Session settings" onClose={() => !busy && onClose()}>
      <form
        className="live-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const value = await api<LiveInfo>(`/live/${info.id}`, "PATCH", {
              name,
              description,
              viewerAccess: access,
              afterEnd,
              allowDownload,
              linkExpiresAt: expires ? new Date(expires).getTime() : null,
            });
            onSaved(value);
            notify("Session settings saved");
            onClose();
          });
        }}
      >
        <label className="field">
          Session name
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Description <span className="optional">(optional)</span>
          <input maxLength={400} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          Viewer access
          <select value={access} onChange={(e) => setAccess(e.target.value as typeof access)}>
            <option value="anyone">Anyone with the session link (read-only)</option>
            <option value="signed_in">Signed-in Kodelumi accounts with the link</option>
            <option value="invited">Only people I invite</option>
          </select>
        </label>
        <label className="field">
          After the session ends
          <select value={afterEnd} onChange={(e) => setAfterEnd(e.target.value as typeof afterEnd)}>
            <option value="closed">Viewers lose access</option>
            <option value="available">Viewers can keep reading (read-only)</option>
          </select>
        </label>
        <label className="live-check">
          <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} /> Viewers can download files
        </label>
        <label className="field">
          Link expires <span className="optional">(optional)</span>
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
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
            {busy && <Loader2 size={15} className="spin" />} Save Settings
          </button>
        </div>
      </form>
      <section className="live-settings-section" aria-label="Session link">
        <h3>Session link</h3>
        <p className="muted">Replacing or revoking the link disconnects everyone who uses it at once.</p>
        <div className="dialog-actions start">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/live/${info.id}/link`, "POST", {});
                notify("New session link created. Copy it again to share it.");
              })
            }
          >
            Replace Link
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/live/${info.id}/link`, "DELETE");
                notify("Session link revoked");
              })
            }
          >
            Revoke Link
          </button>
        </div>
      </section>
      <section className="live-settings-section" aria-label="Invited people">
        <h3>Collaborators and invited viewers</h3>
        <form
          className="live-invite"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const r = await api<{ members: LiveInfo["members"] }>(`/live/${info.id}/members`, "POST", { email, role });
              setMembers(r.members ?? []);
              setEmail("");
              notify(role === "editor" ? "Collaborator added" : "Viewer invited");
            });
          }}
        >
          <input type="email" required aria-label="Email address" placeholder="colleague@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button className="button secondary" type="submit" disabled={busy || !email}>
            Add
          </button>
        </form>
        {members.map((m) => (
          <div className="lock-permission" key={m.userId}>
            <span>
              <strong>{m.displayName}</strong>
              <small>
                {m.email} · {m.role === "editor" ? "Editor" : "Viewer"}
              </small>
            </span>
            <button
              className="icon-button"
              aria-label={"Remove " + m.displayName}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ members: LiveInfo["members"] }>(`/live/${info.id}/members/${m.userId}`, "DELETE");
                  setMembers(r.members ?? []);
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </section>
    </Modal>
  );
}
const toLocalInput = (at: number) => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Destination = { id: string; name: string; role: "owner" | "editor" };
type Folder = { id: string; parent_id: string | null; name: string; lock?: { canOpen?: true } };
export function useDestinations() {
  const [list, setList] = useState<Destination[] | null>(null);
  useEffect(() => {
    Promise.all([
      api<{ workspaces: Array<{ id: string; name: string }> }>("/me/workspaces").catch(() => ({ workspaces: [] })),
      api<{ workspaces: Array<{ id: string; name: string; role: string }> }>("/me/shared").catch(() => ({ workspaces: [] })),
    ]).then(([own, shared]) =>
      setList([
        ...own.workspaces.map((w) => ({ id: w.id, name: w.name, role: "owner" as const })),
        ...shared.workspaces.filter((w) => w.role === "editor").map((w) => ({ id: w.id, name: w.name, role: "editor" as const })),
      ]),
    );
  }, []);
  return list;
}
// Folders of a workspace, indented by depth, for a destination select.
export function folderOptions(folders: Folder[]) {
  const out: Array<{ id: string; label: string }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent)) {
      out.push({ id: f.id, label: "  ".repeat(depth) + f.name });
      if (depth < 12) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
function SaveToWorkspace({ info, files, onClose, notify }: { info: LiveInfo; files: FileDoc[]; onClose: () => void; notify: (message: string) => void }) {
  const destinations = useDestinations();
  const [workspace, setWorkspace] = useState(info.workspace?.id ?? ""),
    [folders, setFolders] = useState<Folder[]>([]),
    [folder, setFolder] = useState(info.folder?.id ?? ""),
    [subfolder, setSubfolder] = useState("Live Coding"),
    [conflict, setConflict] = useState<"rename" | "skip" | "replace">("rename"),
    [lock, setLock] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<{ saved: Array<{ filename: string }>; skipped: string[] } | null>(null);
  useEffect(() => {
    if (!workspace && destinations?.length) setWorkspace(destinations[0].id);
  }, [destinations]);
  useEffect(() => {
    if (!workspace) return;
    api<{ folders: Folder[] }>(`/rooms/${workspace}/tree`)
      .then((tree) => {
        setFolders(tree.folders);
        setFolder((value) => (tree.folders.some((f) => f.id === value) ? value : ""));
      })
      .catch(() => setFolders([]));
  }, [workspace]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ saved: Array<{ filename: string }>; skipped: string[] }>(`/live/${info.id}/save`, "POST", {
        workspaceId: workspace,
        folderId: folder || null,
        subfolder: subfolder.trim() || undefined,
        conflict,
        lock,
      });
      setResult(r);
      notify(`Saved ${r.saved.length} file${r.saved.length === 1 ? "" : "s"} to the workspace`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Save to Workspace" onClose={() => !busy && onClose()}>
      {result ? (
        <>
          <p className="modal-description">
            Saved {result.saved.map((f) => f.filename).join(", ") || "nothing"}.
            {result.skipped.length ? ` Skipped (already there): ${result.skipped.join(", ")}.` : ""} The session itself is unchanged.
          </p>
          <div className="dialog-actions">
            <button className="button primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="lock-dialog">
          <p className="modal-description">
            Copies the session’s {files.length} file{files.length === 1 ? "" : "s"} (and their images) into a workspace folder you can edit. The
            session stays as it is.
          </p>
          <label className="field">
            Workspace
            <select required value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {!destinations && <option value="">Loading…</option>}
              {destinations?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Folder
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">Workspace root</option>
              {folderOptions(folders).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            New subfolder <span className="optional">(optional; reused if it already exists)</span>
            <input maxLength={80} value={subfolder} onChange={(e) => setSubfolder(e.target.value)} placeholder="Live Coding" />
          </label>
          <fieldset className="lock-visibility">
            <legend>Files with the same name</legend>
            <label>
              <input type="radio" name="conflict" checked={conflict === "rename"} onChange={() => setConflict("rename")} /> Keep both (save as
              name-2)
            </label>
            <label>
              <input type="radio" name="conflict" checked={conflict === "skip"} onChange={() => setConflict("skip")} /> Skip them
            </label>
            <label>
              <input type="radio" name="conflict" checked={conflict === "replace"} onChange={() => setConflict("replace")} /> Replace them
              (overwrites the workspace files)
            </label>
          </fieldset>
          <label className="live-check">
            <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Lock the saved files (students see them only
            after you unlock)
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy || !workspace}>
              {busy && <Loader2 size={15} className="spin" />} Save to Workspace
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
