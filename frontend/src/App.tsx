import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Code2,
  Sun,
  Moon,
  Plus,
  Users,
  Copy,
  ClipboardPaste,
  Share2,
  Settings as SettingsIcon,
  FileCode2,
  ChevronRight,
  Check,
  Search,
  PanelLeft,
  Download,
  Wifi,
  WifiOff,
  Link,
  Hash,
  X,
  Loader2,
  Keyboard,
  Trash2,
  Pencil,
  Save,
  Terminal,
  Layers,
  Radio,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  Eye,
  ArrowLeft,
} from "lucide-react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { editor } from "monaco-editor";
import Modal from "./components/Modal";
import SettingsPanel from "./components/SettingsPanel";
import AccessShare from "./components/AccessShare";
import CodeBlocks from "./components/CodeBlocks";
import CreateWorkspace from "./components/CreateWorkspace";
import WorkspaceDashboard from "./components/WorkspaceDashboard";
import MarkdownPreview from "./components/MarkdownPreview";
import { remember, shortcuts, forget } from "./workspaces";
import CourseExplorer from "./components/CourseExplorer";
import { ClassroomAwareness } from "./components/ClassroomAwareness";
import {
  api,
  createEditorCredential,
  defaults,
  inferLanguage,
  initials,
  languages,
  readLocal,
  storeLocal,
  type FileDoc,
  type CodeBlock,
  type CourseTree,
  type Settings,
} from "./lib";
const CodeEditor = lazy(() => import("./components/CodeEditor"));
type RoomInfo = {
  id: string;
  name: string;
  description?: string;
  access?: "editor" | "viewer";
};
type Person = {
  id: number;
  name: string;
  color: string;
  fileId?: string;
  role: "editor" | "viewer";
};
const colors = [
  "#a78bfa",
  "#38bdf8",
  "#fb923c",
  "#34d399",
  "#f472b6",
  "#facc15",
  "#818cf8",
  "#2dd4bf",
];

function LanguageSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label="Programming language"
      className="language-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {languages.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
function Logo() {
  return (
    <span className="brand">
      <span className="brand-icon">
        <Code2 size={21} />
      </span>
      DevShare<span className="brand-dot">.</span>
    </span>
  );
}

export default function App() {
  const [dark, setDark] = useState(
    () => readLocal("devshare.theme", "dark") === "dark",
  );
  const [route, setRoute] = useState(location.pathname);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    storeLocal("devshare.theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const listener = () => setRoute(location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  const navigate = (path: string) => {
    history.pushState({}, "", path);
    setRoute(new URL(path, location.origin).pathname);
  };
  const notify = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };
  const themeButton = (
    <button
      className="icon-button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title="Toggle theme"
      onClick={() => setDark(!dark)}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
  const roomRoute =
    /^\/(?:room|w)\/([\w-]{16})(?:\/edit\/([\w-]{43}))?\/?$/.exec(route);
  return (
    <>
      {roomRoute ? (
        <Workspace
          key={route}
          id={roomRoute[1]}
          editorToken={roomRoute[2]}
          dark={dark}
          themeButton={themeButton}
          navigate={navigate}
          notify={notify}
        />
      ) : (
        <Landing
          key={route}
          dashboard={route === "/workspaces"}
          navigate={navigate}
          themeButton={themeButton}
          notify={notify}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </>
  );
}

function Landing({
  navigate,
  themeButton,
  dashboard,
  notify,
}: {
  navigate: (p: string) => void;
  themeButton: React.ReactNode;
  dashboard: boolean;
  notify: (message: string) => void;
}) {
  const [create, setCreate] = useState(false),
    [code, setCode] = useState(""),
    [error, setError] = useState("");
  function join(e: FormEvent) {
    e.preventDefault();
    let id = code.trim();
    try {
      if (id.includes("/")) {
        const url = new URL(id);
        const route =
          /^\/(?:room|w)\/([\w-]{16})(?:\/edit\/([\w-]{43}))?\/?$/.exec(
            url.pathname,
          );
        if (!route || url.origin !== location.origin)
          throw new Error("Invalid workspace link");
        navigate(url.pathname + url.search);
        return;
      }
    } catch {
      setError("Enter a workspace code or a complete workspace link.");
      return;
    }
    if (!/^[\w-]{16}$/.test(id)) {
      setError("Enter the 16-character workspace code from your shared link.");
      return;
    }
    navigate("/w/" + id);
  }
  return (
    <div className="landing">
      <header className="landing-nav">
        <a href="/" aria-label="DevShare home">
          <Logo />
        </a>
        <div className="nav-right">
          <span className="nav-caption">
            A workspace for technical instruction.
          </span>
          <button
            className="text-button"
            onClick={() => navigate("/workspaces")}
          >
            My Workspaces
          </button>
          {themeButton}
        </div>
      </header>
      {dashboard ? (
        <WorkspaceDashboard
          navigate={navigate}
          onCreate={() => setCreate(true)}
          notify={notify}
        />
      ) : (
        <>
          <main className="landing-main">
            <section className="hero-copy">
              <div className="eyebrow">
                <span className="live-dot" />
                Your DevOps teaching workspace
              </div>
              <h1>
                Code together.
                <br />
                <span>Learn together.</span>
              </h1>
              <p className="hero-description">
                A focused workspace for live coding, technical instruction, and
                real-time collaboration.
                <br />
                <br />
                Share code, explain concepts, and keep everyone in sync.
              </p>
              <button
                className="button primary hero-button"
                onClick={() => {
                  setError("");
                  setCreate(true);
                }}
              >
                <Plus size={19} />
                Create Workspace
              </button>
              <div className="join-section">
                <span className="join-label">Open a shared workspace</span>
                <form onSubmit={join} className="join-form">
                  <Hash size={18} />
                  <input
                    aria-label="Workspace code or link"
                    placeholder="Enter workspace code or link"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                  <button className="button secondary" type="submit">
                    Open Workspace
                  </button>
                </form>
                {!create && error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <div className="hero-footnote">
                <Radio size={14} /> Live collaboration<span>·</span>
                <Code2 size={14} /> Multi-language<span>·</span>
                <Terminal size={14} /> Developer focused
              </div>
            </section>
            <section
              className="preview-window"
              aria-label="Example coding workspace"
            >
              <div className="preview-title">
                <div className="window-dots">
                  <i />
                  <i />
                  <i />
                </div>
                <span>Terraform workshop</span>
                <span className="preview-live">
                  <Radio size={12} />
                  Live
                </span>
              </div>
              <div className="preview-tabs">
                <span>
                  <FileCode2 size={14} />
                  main.tf
                </span>
                <span>variables.tf</span>
                <Plus size={14} />
              </div>
              <div className="preview-code">
                <div className="preview-line-numbers">
                  1<br />2<br />3<br />4<br />5<br />6<br />7<br />8<br />9
                  <br />
                  10
                  <br />
                  11
                  <br />
                  12
                </div>
                <pre>
                  <span className="syntax-comment">
                    # Lesson 03 — S3 infrastructure
                  </span>
                  {"\n\n"}
                  <span className="syntax-purple">resource</span>{" "}
                  <span className="syntax-green">
                    "aws_s3_bucket" "example"
                  </span>{" "}
                  {"{\n"}
                  {"  "}bucket ={" "}
                  <span className="syntax-green">"my-training-bucket"</span>
                  {"\n\n  "}tags = {"{\n    "}Environment ={" "}
                  <span className="syntax-green">"dev"</span>
                  {"\n    "}Team ={" "}
                  <span className="syntax-green">"cloud-class"</span>
                  <span className="demo-cursor">
                    <b>Alex</b>
                  </span>
                  {"\n  }\n}\n"}
                </pre>
              </div>
              <div className="preview-bottom">
                <span>Terraform / HCL</span>
                <span>
                  <span className="live-dot" />
                  Connected
                </span>
              </div>
              <div className="preview-collaborators">
                <div className="stacked-avatars">
                  <span style={{ background: "#7660b9" }}>AK</span>
                  <span style={{ background: "#337997" }}>JS</span>
                  <span style={{ background: "#aa6940" }}>ML</span>
                </div>
                <div>
                  <strong>Instructor edits. Students follow live.</strong>
                  <span>One lesson. Everyone on the same page.</span>
                </div>
              </div>
            </section>
          </main>
          <section className="feature-strip">
            <div>
              <Radio size={20} />
              <span>
                <small className="feature-label">LIVE COLLABORATION</small>
                <strong>Teach in real time</strong>
                <small>
                  Changes appear instantly across connected viewers.
                </small>
              </span>
            </div>
            <div>
              <Terminal size={20} />
              <span>
                <small className="feature-label">DEVELOPER WORKSPACE</small>
                <strong>Built for your stack</strong>
                <small>Terraform, Python, YAML, Bash, Docker and more.</small>
              </span>
            </div>
            <div>
              <Layers size={20} />
              <span>
                <small className="feature-label">STRUCTURED LEARNING</small>
                <strong>Organize as you teach</strong>
                <small>
                  Keep lessons, files and reusable snippets together.
                </small>
              </span>
            </div>
          </section>
          <WorkspaceDashboard
            compact
            navigate={navigate}
            onCreate={() => setCreate(true)}
            notify={notify}
          />
        </>
      )}
      <footer className="landing-footer">
        <span>Made for the way developers teach and learn.</span>
        <span>Write. Share. Build together.</span>
      </footer>
      {create && (
        <CreateWorkspace onClose={() => setCreate(false)} navigate={navigate} />
      )}
    </div>
  );
}

function Workspace({
  id,
  editorToken,
  dark,
  themeButton,
  navigate,
  notify,
}: {
  id: string;
  editorToken?: string;
  dark: boolean;
  themeButton: React.ReactNode;
  navigate: (p: string) => void;
  notify: (s: string) => void;
}) {
  const previousShortcut = editorToken
    ? shortcuts().find((item) => item.id === id && item.token === editorToken)
    : undefined;
  const [room, setRoom] = useState<RoomInfo | null>(null),
    [error, setError] = useState(""),
    [name, setName] = useState(() =>
      editorToken ? readLocal<string>("devshare.name." + id, "") : "",
    ),
    [joining, setJoining] = useState(
      !!editorToken && !readLocal("devshare.name." + id, ""),
    ),
    [provider, setProvider] = useState<WebsocketProvider | null>(null),
    [files, setFiles] = useState<FileDoc[]>([]),
    [blocks, setBlocks] = useState<CodeBlock[]>([]),
    [folder, setFolder] = useState<string | null>(() =>
      new URLSearchParams(location.search).get("folder"),
    ),
    [tree, setTree] = useState<CourseTree>({ folders: [], documents: [] }),
    [treeReady, setTreeReady] = useState(false),
    [workspaceView, setWorkspaceView] = useState<"editor" | "blocks">(() =>
      new URLSearchParams(location.search).get("view") === "blocks"
        ? "blocks"
        : "editor",
    ),
    [markdownMode, setMarkdownMode] = useState<"edit" | "preview">("edit"),
    [selectionDraft, setSelectionDraft] = useState<Pick<
      CodeBlock,
      "title" | "language" | "content"
    > | null>(null),
    [active, setActive] = useState(""),
    [people, setPeople] = useState<Person[]>([]),
    [viewerCount, setViewerCount] = useState(0),
    [status, setStatus] = useState("connecting"),
    [synced, setSynced] = useState(false),
    [saved, setSaved] = useState(true);
  const [settings, setSettings] = useState<Settings>(() => ({
      ...defaults,
      ...readLocal<Partial<Settings>>("devshare.settings", {}),
    })),
    [dialog, setDialog] = useState<
      | "share"
      | "settings"
      | "new"
      | "rename"
      | "delete"
      | "shortcuts"
      | "paste"
      | null
    >(null),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 560),
    [filename, setFilename] = useState(""),
    [fileLang, setFileLang] = useState("hcl"),
    [busy, setBusy] = useState(false),
    [modalError, setModalError] = useState(""),
    [pasteDraft, setPasteDraft] = useState(""),
    [position, setPosition] = useState({ line: 1, col: 1 });
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const pendingFile = useRef<string | null>(
    new URLSearchParams(location.search).get("file") ??
      ((previousShortcut?.folder ?? null) === folder
        ? (previousShortcut?.file ?? null)
        : null),
  );
  const pasteTarget = useRef<{
    editor: editor.IStandaloneCodeEditor;
    model: editor.ITextModel;
  } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const current = files.find((f) => f.id === active) ?? files[0];
  const isEditor = room?.access === "editor";
  useEffect(() => {
    if (isEditor && editorToken && room)
      remember({
        id,
        token: editorToken,
        name: room.name,
        description: room.description ?? "",
        lastOpened: Date.now(),
        folder,
        file: current?.id,
        view: workspaceView,
      });
  }, [
    isEditor,
    editorToken,
    room?.name,
    room?.description,
    folder,
    current?.id,
    workspaceView,
  ]);
  useEffect(() => {
    setMarkdownMode(isEditor ? "edit" : "preview");
  }, [current?.id, isEditor]);
  function createBlockFromSelection(content: string, language: string) {
    if (!isEditor || !content) return;
    setSelectionDraft({ title: "", language, content });
    setWorkspaceView("blocks");
  }
  async function returnToWorkspaces() {
    if (isEditor && provider?.synced) {
      try {
        await roomApi("/rooms/" + id + "/checkpoint", "POST");
      } catch (e) {
        notify((e as Error).message);
        return;
      }
    }
    navigate("/workspaces");
  }
  const roomApi = <T = { ok: boolean },>(
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    api<T>(
      path +
        (folder
          ? (path.includes("?") ? "&" : "?") +
            "folder=" +
            encodeURIComponent(folder)
          : ""),
      method,
      body,
      editorToken,
    );
  function openLesson(next: string | null, file?: string) {
    setError("");
    if (next === folder) {
      if (file) setActive(file);
      return;
    }
    pendingFile.current = file ?? null;
    setActive("");
    setFiles([]);
    setBlocks([]);
    setSynced(false);
    setFolder(next);
    history.replaceState(
      {},
      "",
      location.pathname + (next ? "?folder=" + next : ""),
    );
    if (window.innerWidth <= 560) setSidebar(false);
  }
  useEffect(() => {
    let canceled = false;
    roomApi<RoomInfo>("/rooms/" + id)
      .then((r) => {
        if (!canceled) setRoom(r);
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      });
    return () => {
      canceled = true;
    };
  }, [id, editorToken]);
  useEffect(() => {
    api<CourseTree>("/rooms/" + id + "/tree", "GET", undefined, editorToken)
      .then((value) => {
        setTree(value);
        setTreeReady(true);
      })
      .catch((e) => setError(e.message));
  }, [id, editorToken]);
  useEffect(() => {
    if (
      treeReady &&
      folder &&
      !tree.folders.some((item) => item.id === folder)
    ) {
      openLesson(null);
      notify("That lesson is no longer available. Open another folder.");
    }
  }, [tree, treeReady, folder]);
  useEffect(() => {
    if (!room || (isEditor && (joining || !name.trim()))) return;
    const doc = new Y.Doc(),
      url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
      p = new WebsocketProvider(url, id, doc, {
        awareness: new ClassroomAwareness(doc, !isEditor),
        connect: false,
        disableBc: true,
        params: folder ? { folder } : {},
        protocols:
          isEditor && editorToken
            ? ["devshare", "editor." + editorToken]
            : ["devshare"],
      });
    let checkpoint: ReturnType<typeof setTimeout> | undefined;
    if (isEditor)
      p.awareness.setLocalStateField("user", {
        name: name.trim().slice(0, 40),
        color: colors[p.doc.clientID % colors.length],
      });
    else p.awareness.setLocalState({ viewer: true });
    const refreshFiles = () => {
      const result: Array<FileDoc> = [];
      doc.getMap<Y.Map<unknown>>("documents").forEach((item) => {
        result.push({
          id: item.get("id") as string,
          filename: item.get("filename") as string,
          language: item.get("language") as string,
          content: item.get("content") as Y.Text,
          createdAt: item.get("createdAt") as number,
          updatedAt: item.get("updatedAt") as number,
          position: item.get("position") as number,
        });
      });
      result.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      setFiles(result);
      if (
        pendingFile.current &&
        result.some((file) => file.id === pendingFile.current)
      ) {
        setActive(pendingFile.current);
        pendingFile.current = null;
      }
      const catalog = doc.getMap("catalog").get("tree") as
        | CourseTree
        | undefined;
      if (catalog?.folders && catalog?.documents) {
        setTree(catalog);
        setTreeReady(true);
      }
      setBlocks(
        [...doc.getMap<CodeBlock>("codeBlocks").values()].sort(
          (a, b) => a.position - b.position || a.id.localeCompare(b.id),
        ),
      );
      const sharedName = doc.getMap("workspace").get("name");
      if (typeof sharedName === "string")
        setRoom((previous) =>
          previous && previous.name !== sharedName
            ? { ...previous, name: sharedName }
            : previous,
        );
    };
    const presence = () => {
      const result: Person[] = [];
      let viewers = 0;
      p.awareness.getStates().forEach((s, key) => {
        const editor = key === p.doc.clientID ? isEditor : s.role === "editor";
        if (!editor) {
          viewers++;
          return;
        }
        if (s.user)
          result.push({
            id: key,
            name: s.user.name,
            color: s.user.color,
            fileId: s.fileId,
            role:
              key === p.doc.clientID
                ? isEditor
                  ? "editor"
                  : "viewer"
                : s.role === "editor"
                  ? "editor"
                  : "viewer",
          });
      });
      setPeople(result);
      setViewerCount(viewers);
      const me = result.find((person) => person.id === p.doc.clientID);
      if (
        me &&
        result.some((person) => person.id < me.id && person.color === me.color)
      ) {
        const taken = new Set(
          result
            .filter((person) => person.id !== me.id)
            .map((person) => person.color),
        );
        let color = colors.find((c) => !taken.has(c));
        while (!color || taken.has(color)) {
          color =
            "#" +
            Array.from(crypto.getRandomValues(new Uint8Array(3)), (n) =>
              (128 + (n % 96)).toString(16),
            ).join("");
        }
        p.awareness.setLocalStateField("user", { name: me.name, color });
      }
    };
    const connection = ({ status }: { status: string }) => {
      setStatus(status);
      if (status !== "connected") setSynced(false);
    };
    const sync = (value: boolean) => setSynced(value);
    const close = (event: CloseEvent | null) => {
      if (event?.code === 1008) {
        setError(
          event.reason ||
            "The server rejected this change. Refresh to reconnect.",
        );
        p.shouldConnect = false;
        api<CourseTree>("/rooms/" + id + "/tree", "GET", undefined, editorToken)
          .then((value) => {
            setTree(value);
            setTreeReady(true);
          })
          .catch(() => {});
      }
    };
    const changed = (_update: Uint8Array, origin: unknown) => {
      refreshFiles();
      if (isEditor && origin !== p) {
        setSaved(false);
        clearTimeout(checkpoint);
        if (settingsRef.current.autoSave)
          checkpoint = setTimeout(() => {
            if (!p.synced) return;
            roomApi("/rooms/" + id + "/checkpoint", "POST")
              .then(() => setSaved(true))
              .catch(() => setSaved(false));
          }, 2200);
      }
    };
    doc.on("update", changed);
    p.on("status", connection);
    p.on("sync", sync);
    p.on("connection-close", close);
    p.awareness.on("change", presence);
    setProvider(p);
    p.connect();
    presence();
    return () => {
      clearTimeout(checkpoint);
      doc.off("update", changed);
      p.awareness.off("change", presence);
      p.off("status", connection);
      p.off("sync", sync);
      p.off("connection-close", close);
      p.destroy();
      doc.destroy();
    };
  }, [room?.id, room?.access, joining, editorToken, folder]);
  useEffect(() => {
    if (current) {
      setActive(current.id);
      provider?.awareness.setLocalStateField("fileId", current.id);
    }
  }, [current?.id, provider]);
  useEffect(() => {
    if (!provider) return;
    const style = document.createElement("style");
    style.dataset.presence = "true";
    document.head.append(style);
    const update = () => {
      style.textContent = people
        .map((p) => {
          const label = JSON.stringify(p.name).replace(/</g, "\\3c ");
          return `.yRemoteSelection-${p.id}{background:${p.color}30}.yRemoteSelectionHead-${p.id}{border-left:2px solid ${p.color}}.yRemoteSelectionHead-${p.id}::after{content:${label};position:absolute;top:-20px;left:-2px;background:${p.color};color:#11151d;padding:2px 5px;border-radius:3px;font:11px sans-serif;white-space:nowrap;pointer-events:none;}`;
        })
        .join("");
    };
    update();
    return () => style.remove();
  }, [people, provider]);
  async function save() {
    if (!isEditor) return;
    if (!provider?.synced) {
      notify("Reconnect before saving a checkpoint.");
      return;
    }
    try {
      await roomApi("/rooms/" + id + "/checkpoint", "POST");
      setSaved(true);
      notify("Workspace saved");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        setDialog("settings");
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [id, provider, isEditor, editorToken]);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(label + " copied!");
    } catch {
      notify("Clipboard unavailable. Select the text and use Ctrl / ⌘ C.");
    }
  }
  function insertCode(text: string) {
    if (!isEditor) return;
    const target = pasteTarget.current;
    if (
      !target ||
      editorRef.current !== target.editor ||
      target.editor.getModel() !== target.model
    ) {
      notify("The active file changed. Paste again in the file you want.");
      return;
    }
    const selection = target.editor.getSelection();
    if (!selection || !text) {
      notify("There is no code to paste.");
      return;
    }
    const size = new TextEncoder();
    const total = files.reduce(
      (sum, file) => sum + size.encode(file.content.toString()).length,
      blocks.reduce((sum, block) => sum + size.encode(block.content).length, 0),
    );
    if (
      total -
        size.encode(target.model.getValueInRange(selection)).length +
        size.encode(text).length >
      512 * 1024
    ) {
      notify("This paste would exceed this lesson’s 512 KiB code limit.");
      return;
    }
    target.editor.executeEdits("clipboard", [
      { range: selection, text, forceMoveMarkers: true },
    ]);
    setDialog(null);
    target.editor.focus();
    notify("Code pasted");
  }
  async function pasteCode() {
    if (!isEditor) return;
    const target = editorRef.current,
      model = target?.getModel();
    if (!target || !model) return;
    pasteTarget.current = { editor: target, model };
    try {
      insertCode(await navigator.clipboard.readText());
    } catch {
      setPasteDraft("");
      setDialog("paste");
    }
  }
  async function fileSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isEditor) return;
    setBusy(true);
    setModalError("");
    try {
      if (dialog === "new") {
        const result = await roomApi<{ id: string }>(
          "/rooms/" + id + "/documents",
          "POST",
          { filename, language: fileLang },
        );
        setActive(result.id);
      } else if (current)
        await roomApi("/rooms/" + id + "/documents/" + current.id, "PATCH", {
          filename,
        });
      setDialog(null);
    } catch (e) {
      setModalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeLanguage(lang: string) {
    if (!isEditor) return;
    if (!current) return;
    try {
      await roomApi("/rooms/" + id + "/documents/" + current.id, "PATCH", {
        language: lang,
      });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function removeFile() {
    if (!isEditor) return;
    if (!current) return;
    setBusy(true);
    try {
      await roomApi("/rooms/" + id + "/documents/" + current.id, "DELETE");
      setDialog(null);
    } catch (e) {
      setModalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveFile(direction: number) {
    if (!isEditor || !current || !provider?.synced) return;
    const ids = files.map((file) => file.id),
      index = ids.indexOf(current.id);
    if (index + direction < 0 || index + direction >= ids.length) return;
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    try {
      await roomApi("/rooms/" + id + "/documents/order", "PATCH", { ids });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function openFileDialog(type: "new" | "rename" | "delete") {
    if (!isEditor) return;
    setFilename(type === "new" ? "" : (current?.filename ?? ""));
    setFileLang(current?.language ?? "hcl");
    setModalError("");
    setDialog(type);
  }
  function download() {
    if (!current) return;
    const url = URL.createObjectURL(
      new Blob([current.content.toString()], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = current.filename;
    a.click();
    URL.revokeObjectURL(url);
    notify("File downloaded");
  }
  if (error && !provider)
    return (
      <div className="center-state">
        <Logo />
        <h2>We couldn’t open this workspace</h2>
        <p className="error" role="alert">
          {error}
        </p>
        <button className="button primary" onClick={() => navigate("/")}>
          Back to home
        </button>
      </div>
    );
  if (!room)
    return (
      <div className="center-state">
        <Logo />
        <Loader2 size={28} className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  const connected = status === "connected" && synced;
  return (
    <div className="workspace">
      <header className="workspace-nav">
        {isEditor && (
          <button
            className="workspace-back text-button"
            onClick={() => void returnToWorkspaces()}
            title="My Workspaces"
          >
            <ArrowLeft size={16} />
            <span>My Workspaces</span>
          </button>
        )}
        <span className="workspace-brand">
          <Logo />
        </span>
        <span className="nav-divider" />
        <div className="room-title">
          <span className="room-title-label">WORKSPACE</span>
          <strong>{room.name}</strong>
        </div>
        <span
          className={"access-badge " + (isEditor ? "editing" : "view-only")}
          aria-label="Workspace access"
        >
          {isEditor ? <Pencil size={13} /> : <Eye size={14} />}
          <span>{isEditor ? "Editing" : "View Only"}</span>
        </span>
        <div className="toolbar-language">
          {isEditor ? (
            <LanguageSelect
              value={current?.language ?? "hcl"}
              onChange={changeLanguage}
              disabled={!connected || !current}
            />
          ) : (
            <span aria-label="File language">{current?.language ?? "hcl"}</span>
          )}
        </div>
        <div className="nav-right">
          {isEditor && (
            <span
              className="presence-count"
              title={`${viewerCount} anonymous viewers online`}
            >
              <Users size={16} />
              {viewerCount}
              <span className="viewer-count-label">{" viewers"}</span>
            </span>
          )}
          <button
            className="icon-button desktop-tool"
            aria-label="Copy workspace link"
            title="Copy workspace link"
            onClick={() => copy(location.origin + "/w/" + id, "Workspace link")}
          >
            <Link size={17} />
          </button>
          <button
            className="button primary share-button"
            onClick={() => setDialog("share")}
          >
            <Share2 size={15} />
            <span>Share</span>
          </button>
          <span className="nav-divider desktop-tool" />
          <button
            className="icon-button"
            aria-label={isEditor ? "Editor settings" : "Viewing preferences"}
            onClick={() => setDialog("settings")}
          >
            <SettingsIcon size={18} />
          </button>
          {themeButton}
        </div>
      </header>
      <div className="workspace-body">
        {sidebar && (
          <aside className="sidebar">
            <div className="sidebar-heading">
              EXPLORER
              {isEditor && (
                <button
                  className="icon-button"
                  aria-label="New file"
                  onClick={() => openFileDialog("new")}
                  disabled={!connected || !isEditor}
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
            <CourseExplorer
              tree={tree}
              name={room.name}
              folder={folder}
              active={current?.id}
              canEdit={isEditor}
              connected={connected}
              onOpen={openLesson}
              request={(path, method, body) =>
                roomApi("/rooms/" + id + path, method, body)
              }
            />
            {isEditor && (
              <div className="sidebar-people">
                <div className="sidebar-heading">
                  CONNECTED<span>{people.length + viewerCount}</span>
                </div>
                <p className="anonymous-viewers">
                  {viewerCount} anonymous viewers
                </p>
                {people.map((p) => (
                  <div className="person" key={p.id}>
                    <span
                      className="avatar"
                      style={{ background: p.color + "25", color: p.color }}
                    >
                      {initials(p.name)}
                    </span>
                    <span>
                      {p.name}
                      <small className="person-role">
                        {" "}
                        {p.role === "editor" ? "Editor" : "Viewer"}
                      </small>
                      {p.id === provider?.doc.clientID && <small> (you)</small>}
                    </span>
                    <span className="live-dot" />
                  </div>
                ))}
                <button
                  className="invite-link"
                  onClick={() => setDialog("share")}
                >
                  <Plus size={14} />
                  Invite a collaborator
                </button>
              </div>
            )}
            <div className="sidebar-utilities">
              <button
                className="text-button"
                onClick={() => setDialog("shortcuts")}
              >
                <Keyboard size={15} /> Keyboard shortcuts
              </button>
            </div>
            <div className="sidebar-bottom">
              <span className="live-dot" />
              Shared workspace<span>v1.0</span>
            </div>
          </aside>
        )}
        <main className="editor-main">
          <div className="workspace-views" aria-label="Workspace views">
            <button
              className="icon-button"
              aria-label="Toggle explorer"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeft size={16} />
            </button>
            <span className="lesson-name">
              {folder
                ? tree.folders.find((item) => item.id === folder)?.name
                : "Workspace root"}
            </span>
            <button
              className={workspaceView === "editor" ? "active" : ""}
              aria-pressed={workspaceView === "editor"}
              onClick={() => setWorkspaceView("editor")}
            >
              <FileCode2 size={15} /> Files & Editor
            </button>
            <button
              className={workspaceView === "blocks" ? "active" : ""}
              aria-pressed={workspaceView === "blocks"}
              onClick={() => setWorkspaceView("blocks")}
            >
              <Code2 size={16} /> Code Blocks <span>{blocks.length}</span>
            </button>
          </div>
          {workspaceView === "blocks" ? (
            <CodeBlocks
              initialDraft={selectionDraft}
              onDraftConsumed={() => setSelectionDraft(null)}
              blocks={blocks}
              canEdit={isEditor}
              connected={connected}
              dark={dark}
              fontSize={settings.fontSize}
              onCreate={(draft) =>
                roomApi("/rooms/" + id + "/blocks", "POST", draft)
              }
              onUpdate={(blockId, draft) =>
                roomApi("/rooms/" + id + "/blocks/" + blockId, "PATCH", draft)
              }
              onDelete={(blockId) =>
                roomApi("/rooms/" + id + "/blocks/" + blockId, "DELETE")
              }
              onReorder={(ids) =>
                roomApi("/rooms/" + id + "/blocks/order", "PATCH", { ids })
              }
            />
          ) : (
            <>
              <div className="tab-bar">
                <div className="tabs" role="tablist" aria-label="Files">
                  {files.map((f) => (
                    <button
                      role="tab"
                      aria-selected={current?.id === f.id}
                      key={f.id}
                      className={
                        "file-tab " + (current?.id === f.id ? "active" : "")
                      }
                      onClick={() => setActive(f.id)}
                    >
                      <FileCode2 size={15} />
                      {f.filename}
                      <span className="tab-dot" />
                    </button>
                  ))}
                </div>
                {isEditor && (
                  <button
                    className="icon-button"
                    title="New file"
                    aria-label="Add file tab"
                    disabled={!connected || !isEditor}
                    onClick={() => openFileDialog("new")}
                  >
                    <Plus size={17} />
                  </button>
                )}
              </div>
              <div className="editor-breadcrumb">
                <span>{room.name}</span>
                <ChevronRight size={12} />
                <FileCode2 size={13} />
                <span>{current?.filename ?? "Connecting…"}</span>
                <div className="editor-actions">
                  {current?.language === "markdown" && (
                    <div className="markdown-switch" aria-label="Markdown view">
                      <button
                        aria-pressed={markdownMode === "edit"}
                        onClick={() => setMarkdownMode("edit")}
                      >
                        {isEditor ? "Edit" : "Source"}
                      </button>
                      <button
                        aria-pressed={markdownMode === "preview"}
                        onClick={() => setMarkdownMode("preview")}
                      >
                        Preview
                      </button>
                    </div>
                  )}
                  {isEditor && (
                    <>
                      <button
                        className="icon-button"
                        aria-label="Move file up"
                        title="Move file up"
                        disabled={
                          !connected || !current || files[0]?.id === current.id
                        }
                        onClick={() => void moveFile(-1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Move file down"
                        title="Move file down"
                        disabled={
                          !connected ||
                          !current ||
                          files.at(-1)?.id === current.id
                        }
                        onClick={() => void moveFile(1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button"
                    aria-label="Copy code"
                    title="Copy all code in this file"
                    disabled={!current}
                    onClick={() =>
                      current && copy(current.content.toString(), "Code")
                    }
                  >
                    <Copy size={15} />
                  </button>
                  {isEditor && (
                    <button
                      className="icon-button"
                      aria-label="Paste code"
                      title="Paste code at the cursor or replace the selection"
                      disabled={!current || !provider || !isEditor}
                      onClick={pasteCode}
                    >
                      <ClipboardPaste size={15} />
                    </button>
                  )}
                  {isEditor && (
                    <button
                      className="icon-button"
                      aria-label="Rename file"
                      disabled={!connected || !isEditor}
                      onClick={() => openFileDialog("rename")}
                      title="Rename file"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  {isEditor && (
                    <button
                      className="icon-button"
                      aria-label="Delete file"
                      disabled={!connected || !isEditor || !current}
                      onClick={() => openFileDialog("delete")}
                      title="Delete file"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="Find in file"
                    onClick={() =>
                      editorRef.current?.getAction("actions.find")?.run()
                    }
                    title="Find (Ctrl / ⌘ F)"
                  >
                    <Search size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Download file"
                    disabled={!current}
                    onClick={download}
                    title="Download file"
                  >
                    <Download size={15} />
                  </button>
                  {isEditor && (
                    <button
                      disabled={!isEditor}
                      className="save-state"
                      onClick={save}
                      title="Save checkpoint"
                    >
                      <Save size={13} />
                      {saved ? "Saved" : "Save"}
                    </button>
                  )}
                </div>
              </div>
              {error && (
                <div className="connection-warning" role="alert">
                  {error}
                  <button onClick={() => location.reload()}>
                    Refresh workspace
                  </button>
                </div>
              )}
              {!connected && provider && (
                <div className="connection-warning">
                  {status === "connected"
                    ? "Syncing your workspace…"
                    : isEditor
                      ? "Reconnecting… Your edits will sync when the connection returns."
                      : "Reconnecting… Live updates will resume when the connection returns."}
                </div>
              )}
              <div className="editor-surface">
                {provider &&
                current &&
                current.language === "markdown" &&
                markdownMode === "preview" ? (
                  <MarkdownPreview
                    key={current.id}
                    file={current}
                    dark={dark}
                    fontSize={settings.fontSize}
                  />
                ) : provider && current ? (
                  <Suspense
                    fallback={
                      <div className="editor-loading">Loading editor…</div>
                    }
                  >
                    <CodeEditor
                      onCreateBlock={
                        isEditor ? createBlockFromSelection : undefined
                      }
                      key={current.id}
                      file={current}
                      readOnly={!isEditor}
                      provider={provider}
                      settings={settings}
                      dark={dark}
                      onPosition={(line, col) => setPosition({ line, col })}
                      onEditor={(e) => {
                        editorRef.current = e;
                      }}
                    />
                  </Suspense>
                ) : (
                  <div className="editor-loading">
                    {connected ? (
                      <div className="empty-lesson">
                        <FileCode2 size={30} />
                        <p>
                          {isEditor
                            ? "This folder is empty."
                            : "Your instructor’s files will appear here."}
                        </p>
                        {isEditor && (
                          <button
                            className="button primary"
                            onClick={() => openFileDialog("new")}
                          >
                            <Plus size={16} /> New File
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <Loader2 size={22} className="spin" /> Synchronizing
                        files…
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
      <footer className="status-bar">
        <div>
          <span className="status-brand">
            <Code2 size={14} />
            DevShare
          </span>
          <span>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}{" "}
            {connected
              ? isEditor
                ? "Connected"
                : "Live"
              : status === "connected"
                ? "Syncing"
                : "Reconnecting"}
          </span>
        </div>
        <div>
          <span className="status-access">
            {isEditor ? "Editing" : "View Only"}
          </span>
          {!isEditor && people.some((person) => person.role === "editor") && (
            <span className="status-hide">Instructor is editing</span>
          )}
          <span>
            Ln {position.line}, Col {position.col}
          </span>
          <span className="status-hide">Spaces: {settings.tabSize}</span>
          <span className="status-hide">UTF-8</span>
          <span>
            {languages.find((l) => l[0] === current?.language)?.[1] ??
              "Plain Text"}
          </span>
          <button
            aria-label="Keyboard shortcuts"
            onClick={() => setDialog("shortcuts")}
          >
            <Keyboard size={14} />
          </button>
        </div>
      </footer>
      {dialog === "paste" && (
        <Modal title="Paste code" onClose={() => setDialog(null)}>
          <p className="modal-description">
            Your browser couldn’t read the clipboard. Paste here with Ctrl / ⌘
            V, then insert it at your editor cursor. Selected code will be
            replaced.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              insertCode(pasteDraft);
            }}
          >
            <label className="field">
              Code to paste
              <textarea
                className="paste-code-input"
                autoFocus
                value={pasteDraft}
                onChange={(e) => setPasteDraft(e.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              type="submit"
              className="button primary full"
              disabled={!pasteDraft}
            >
              <ClipboardPaste size={16} />
              Insert code
            </button>
          </form>
        </Modal>
      )}
      {joining && isEditor && (
        <Modal title={"Open " + room.name} onClose={() => navigate("/")}>
          <p className="modal-description">
            Your workspace is ready. What should we call you?
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              storeLocal("devshare.name." + id, name.trim());
              setJoining(false);
            }}
          >
            <label className="field">
              Your name
              <input
                autoFocus
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alex"
                required
              />
            </label>
            <button
              className="button primary full"
              disabled={!name.trim()}
              type="submit"
            >
              <Users size={17} />
              Open Workspace
            </button>
            <p className="fine-print">
              {isEditor
                ? "You’re joining with editor access. Keep your private link safe."
                : "You can view, select, and copy code. Only editors can make changes."}
            </p>
          </form>
        </Modal>
      )}
      {dialog === "share" && (
        <AccessShare
          folderId={folder}
          id={id}
          name={room.name}
          editorToken={isEditor ? editorToken : undefined}
          copy={copy}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "settings" && (
        <SettingsPanel
          onDelete={
            isEditor
              ? async () => {
                  await roomApi("/rooms/" + id, "DELETE");
                  forget(id);
                  navigate("/workspaces");
                  notify("Workspace permanently deleted");
                }
              : undefined
          }
          settings={settings}
          canEdit={isEditor}
          workspaceName={room.name}
          onRename={
            isEditor
              ? async (value) => {
                  await roomApi("/rooms/" + id, "PATCH", { name: value });
                  notify("Workspace name updated");
                }
              : undefined
          }
          update={(s) => {
            setSettings(s);
            storeLocal("devshare.settings", s);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog === "new" || dialog === "rename") && (
        <Modal
          title={dialog === "new" ? "Add a file" : "Rename file"}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={fileSubmit}>
            <label className="field">
              Filename
              <input
                autoFocus
                required
                maxLength={80}
                placeholder="e.g. variables.tf"
                value={filename}
                onChange={(e) => {
                  setFilename(e.target.value);
                  if (dialog === "new")
                    setFileLang(inferLanguage(e.target.value));
                }}
              />
            </label>
            {dialog === "new" && (
              <label className="field">
                Language
                <LanguageSelect value={fileLang} onChange={setFileLang} />
              </label>
            )}
            {modalError && (
              <p className="error" role="alert">
                {modalError}
              </p>
            )}
            <button
              className="button primary full"
              disabled={busy}
              type="submit"
            >
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <FileCode2 size={16} />
              )}
              {dialog === "new" ? "Create file" : "Save name"}
            </button>
          </form>
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal title="Delete this file?" onClose={() => setDialog(null)}>
          <p className="modal-description">
            “{current?.filename}” will be removed for everyone in the workspace.
            Download a copy first if you need it.
          </p>
          {modalError && (
            <p className="error" role="alert">
              {modalError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              onClick={removeFile}
              disabled={busy}
            >
              Delete file
            </button>
          </div>
        </Modal>
      )}
      {dialog === "shortcuts" && (
        <Modal title="A few useful shortcuts" onClose={() => setDialog(null)}>
          <div className="shortcut-list">
            {[
              ["Find", "Ctrl / ⌘ F"],
              ...(isEditor
                ? [
                    ["Replace", "Ctrl / ⌘ H"],
                    ["Undo your edits", "Ctrl / ⌘ Z"],
                    ["Redo your edits", "Ctrl / ⌘ Shift Z"],
                    ["Save checkpoint", "Ctrl / ⌘ S"],
                  ]
                : []),
              [
                isEditor ? "Editor settings" : "Viewing preferences",
                "Ctrl / ⌘ Shift P",
              ],
              [isEditor ? "Copy / paste" : "Copy", "Ctrl / ⌘ C / V"],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <p className="fine-print">
            Monaco’s right-click menu offers additional editor actions.
          </p>
        </Modal>
      )}
    </div>
  );
}
