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
export type CourseTree = {
  folders: Array<{
    id: string;
    parent_id: string | null;
    name: string;
    position: number;
  }>;
  documents: Array<{
    id: string;
    folder_id: string | null;
    filename: string;
    language: string;
    position: number;
  }>;
};
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
      result.error ?? "Something went wrong. Try again.",
      response.status,
    );
  return result;
}
export type UploadedImage = { id: string; mime: string; width: number; height: number };
// Sends an image's original bytes unchanged (never resized or re-encoded).
export async function uploadImage(workspaceId: string, file: Blob, editorToken?: string) {
  const response = await fetch(`/api/rooms/${workspaceId}/images`, {
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
