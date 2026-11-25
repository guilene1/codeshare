import * as Y from "yjs";
export const languages = [
  ["hcl", "Terraform / HCL", "tf"],
  ["python", "Python", "py"],
  ["javascript", "JavaScript", "js"],
  ["typescript", "TypeScript", "ts"],
  ["java", "Java", "java"],
  ["go", "Go", "go"],
  ["shell", "Bash / Shell", "sh"],
  ["yaml", "YAML", "yaml"],
  ["json", "JSON", "json"],
  ["dockerfile", "Dockerfile", ""],
  ["sql", "SQL", "sql"],
  ["powershell", "PowerShell", "ps1"],
  ["xml", "XML", "xml"],
  ["ini", "INI / TOML", "ini"],
  ["ruby", "Ruby", "rb"],
  ["markdown", "Markdown", "md"],
  ["html", "HTML", "html"],
  ["css", "CSS", "css"],
  ["plaintext", "Plain Text", "txt"],
];
export function inferLanguage(name: string) {
  if (name === "Dockerfile") return "dockerfile";
  const extension = name.split(".").pop()!;
  const extra: Record<string, string> = {
    yml: "yaml",
    tfvars: "hcl",
    hcl: "hcl",
    bash: "shell",
    toml: "ini",
  };
  return (
    extra[extension] ??
    languages.find((l) => l[2] === extension)?.[0] ??
    "plaintext"
  );
}
export type FileDoc = {
  id: string;
  filename: string;
  language: string;
  content: Y.Text;
  createdAt: number;
  updatedAt: number;
  position?: number;
};
// A lock as the Explorer shows it (the server sends it only on locked items). `canOpen`: this
// person may still open it (the owner, or a delegate with access there). Visibility and time zone
// come only to the people who manage locks.
export type TreeLock = {
  state: "locked" | "inherited";
  releaseAt: number | null;
  canOpen?: true;
  visibility?: "visible" | "hidden";
  zone?: string | null;
  hidden?: boolean;
};
export type CourseTree = {
  folders: Array<{
    id: string;
    parent_id: string | null;
    name: string;
    position: number;
    lock?: TreeLock;
  }>;
  documents: Array<{
    id: string;
    folder_id: string | null;
    filename: string;
    language: string;
    position: number;
    lock?: TreeLock;
  }>;
  // The workspace's own lock (it locks everything in it).
  workspaceLock?: TreeLock;
};
export type LockTarget = { kind: "workspace" | "folder" | "file"; id: string };
// A release time, in the viewer's own time zone: "Mar 9" (or "Mar 9, 2028" in another year)
// and, in full, "Tuesday, March 9, 2027 at 8:00 AM EST".
export function releaseShort(at: number) {
  // The year only when the date is far off (or past), so the usual case stays short: "Mar 15".
  const far = Math.abs(at - Date.now()) > 300 * 86_400_000;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(far ? { year: "numeric" } : {}) });
}
export function releaseLong(at: number) {
  // (dateStyle can't be combined with timeZoneName, so the fields are spelled out.)
  return new Date(at).toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
export function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC", browserTimeZone()];
  }
}
// The wall-clock date ("2027-03-15") and time ("08:00") of an instant in a time zone.
export function wallClock(at: number, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export type CodeBlock = {
  id: string;
  workspace_id: string;
  folder_id?: string | null;
  title: string;
  language: string;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
};
export type Settings = {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoSave: boolean;
  editorTheme: "auto" | "dark" | "light";
  cursorStyle: "line" | "block" | "underline";
};
export const defaults: Settings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  autoSave: true,
  editorTheme: "auto",
  cursorStyle: "line",
};
export function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function storeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsers may restrict storage. */
  }
}
// The CSRF token lives only in memory; the session itself is an HttpOnly cookie.
let csrfToken = "";
export function setCsrfToken(value: string | undefined) {
  csrfToken = value ?? "";
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = { ok: boolean }>(
  path: string,
  method = "GET",
  body?: unknown,
  editorToken?: string,
): Promise<T> {
  const send = () =>
    fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(editorToken ? { Authorization: `Bearer ${editorToken}` } : {}),
        ...(csrfToken && method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let response = await send();
  // A whole class opening a link at once can briefly hit the server's rate limit. Reads
  // are safe to repeat, so wait as the server asks (plus jitter) and try again.
  for (let attempt = 1; response.status === 429 && method === "GET" && attempt <= 3; attempt++) {
    const wait = Math.min(Number(response.headers.get("Retry-After")) || attempt * 2, 10);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000 + Math.random() * 1500));
    response = await send();
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      result.error ??
        // The application is stopped (maintenance, or a guarded rollback): the proxy answers alone.
        ([502, 503, 504].includes(response.status)
          ? "Kodelumi is temporarily unavailable for maintenance. Please try again in a few minutes."
          : "Something went wrong. Try again."),
      response.status,
    );
  return result;
}
export type UploadedImage = { id: string; mime: string; width: number; height: number };
// Sends an image's original bytes unchanged (never resized or re-encoded), into the lesson it
// is added to (folder, or the workspace root): folder Editors may upload only into their own.
export async function uploadImage(workspaceId: string, file: Blob, editorToken?: string, folder?: string | null) {
  const response = await fetch(`/api/rooms/${workspaceId}/images${folder ? "?folder=" + encodeURIComponent(folder) : ""}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      ...(editorToken ? { Authorization: `Bearer ${editorToken}` } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(result.error ?? "The image could not be added.", response.status);
  return result as UploadedImage;
}
// A Live Coding session's own image (its owner and collaborators upload; viewers only read).
export async function uploadLiveImage(sessionId: string, file: Blob) {
  const response = await fetch(`/api/live/${sessionId}/images`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error ?? "The image could not be added.", response.status);
  return result as UploadedImage;
}
export const imageUrl = (workspaceId: string, imageId: string) =>
  `/api/rooms/${workspaceId}/images/${imageId}`;
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
