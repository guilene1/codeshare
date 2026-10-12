// Markdown lesson parsing with source offsets. Inline code blocks are standard fenced
// blocks inside the shared Markdown text, so editing, moving and deleting them is a
// precise text edit that collaborates through Yjs like any other change.
import { languages } from "./lib";

type Base = { start: number; end: number };
export type CodeSegment = Base & {
  type: "code";
  language: string;
  content: string;
};
export type ImageSegment = Base & {
  type: "image";
  alt: string;
  src: string;
  width?: number;
};
export type Segment =
  | CodeSegment
  | ImageSegment
  | (Base & { type: "heading"; level: number; text: string })
  | (Base & { type: "hr" })
  | (Base & { type: "quote"; text: string })
  | (Base & { type: "list"; ordered: boolean; items: string[] })
  | (Base & { type: "paragraph"; text: string });

export const aliases: Record<string, string> = {
  bash: "shell",
  sh: "shell",
  zsh: "shell",
  console: "shell",
  shellsession: "shell",
  terraform: "hcl",
  tf: "hcl",
  tfvars: "hcl",
  js: "javascript",
  jsx: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  yml: "yaml",
  k8s: "yaml",
  kubernetes: "yaml",
  helm: "yaml",
  docker: "dockerfile",
  containerfile: "dockerfile",
  jsonc: "json",
  golang: "go",
  ps1: "powershell",
  pwsh: "powershell",
  toml: "ini",
  env: "ini",
  dotenv: "ini",
  properties: "ini",
  rb: "ruby",
  md: "markdown",
  text: "plaintext",
  txt: "plaintext",
};
// Maps a fence info string to a supported Monaco language id.
export function languageId(info: string) {
  const value = info.toLowerCase();
  const id = aliases[value] ?? value;
  return languages.some(([known]) => known === id) ? id : "plaintext";
}
export function languageLabel(info: string) {
  if (!info) return "Plain text";
  return languages.find(([id]) => id === languageId(info))?.[1] ?? info;
}

// Best guess for a block whose fence names no language. It only chooses colours: the
// document is never changed, and anything ambiguous stays plain text.
export function detectLanguage(content: string): string | null {
  const text = content.trim();
  if (!text) return null;
  const firstLine = text.split("\n")[0];
  if (/^#!.*\b(ba|z|k)?sh\b/.test(firstLine)) return "shell";
  if (/^#!.*\bpython/.test(firstLine)) return "python";
  if (/^[[{]/.test(text))
    try {
      JSON.parse(text);
      return "json";
    } catch {
      /* Not JSON; keep looking. */
    }
  const code = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() && !/^\s*(#|\/\/)/.test(line));
  if (!code.length) return null;
  const share = (pattern: RegExp) =>
    code.filter((line) => pattern.test(line)).length / code.length;
  if (/^apiVersion:\s*\S/m.test(text) && /^kind:\s*\S/m.test(text)) return "yaml";
  if (
    /^(FROM|ARG)\s+\S/i.test(code[0]) &&
    share(
      /^(FROM|RUN|CMD|COPY|ADD|ENV|ARG|EXPOSE|WORKDIR|ENTRYPOINT|USER|LABEL|VOLUME|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL)\s|^\s+\S/i,
    ) >= 0.8
  )
    return "dockerfile";
  if (/^\s*(resource|data|provider|variable|output|module|terraform|locals)\b[^\n{]*\{\s*$/m.test(text))
    return "hcl";
  const yamlKey = /^\s*(-\s+)?("[^"]*"|'[^']*'|[\w./-]+)\s*:(\s|$)/;
  if (
    code.filter((line) => yamlKey.test(line)).length >= 2 &&
    share(/^\s*(-\s+)?("[^"]*"|'[^']*'|[\w./-]+)\s*:(\s|$)|^\s*-(\s|$)|^\s+\S/) >= 0.8 &&
    !code.some((line) => /[;{]\s*$/.test(line))
  )
    return "yaml";
  if (
    /^\s*(def\s+\w+\s*\(|class\s+\w+\s*[(:]|import\s+\w+|from\s+[\w.]+\s+import\s)/m.test(text) &&
    !code.some((line) => /[;{]\s*$/.test(line))
  )
    return "python";
  if (
    share(
      /^\s*(\$\s+)?(sudo\s+)?(kubectl|docker|podman|terraform|helm|aws|az|gcloud|git|npm|npx|yarn|pnpm|pip3?|cd|ls|cat|echo|export|curl|wget|ssh|scp|chmod|chown|mkdir|rm|cp|mv|apt(-get)?|yum|dnf|brew|systemctl|journalctl|make|minikube|kind|eksctl|ansible(-playbook)?|vagrant|packer|openssl|grep|tail|source|tar|unzip|touch|whoami)\b/,
    ) >= 0.6
  )
    return "shell";
  return null;
}

const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/;
// Markdown for an inserted image; the alt text never contains brackets or newlines.
export function imageMarkdown(alt: string, src: string, width?: number) {
  const label = alt.replace(/[[\]|\n\r]/g, " ").trim().slice(0, 120);
  return `![${label}${width ? "|" + Math.round(width) : ""}](${src})`;
}
// Workspace images uploaded to Kodelumi; other sources are not loaded (the content
// security policy would block them, and they could track viewers).
export const workspaceImage = (src: string) =>
  /^\/api\/rooms\/[A-Za-z0-9_-]{16}\/images\/[A-Za-z0-9_-]{22}$/.test(src);

// `plain` (Plain Text documents): only fenced code blocks and image lines are special;
// all other text stays literal paragraphs, so "# note" or "- item" are not reformatted.
export function parseMarkdown(source: string, plain = false): Segment[] {
  const lines = source.split("\n");
  const offsets: number[] = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    position += line.length + 1;
  }
  const lineEnd = (index: number) => offsets[index] + lines[index].length;
  const clean = (line: string) => line.replace(/\r$/, "");
  const segments: Segment[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = clean(lines[index]);
    if (!line.trim()) {
      index++;
      continue;
    }
    const start = offsets[index];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      const code: string[] = [];
      let last = index++;
      while (index < lines.length && !close.test(clean(lines[index])))
        code.push(clean(lines[index++]));
      if (index < lines.length) last = index++;
      else last = index - 1;
      segments.push({
        type: "code",
        start,
        end: lineEnd(last),
        language: fence[2],
        content: code.join("\n"),
      });
      continue;
    }
    // An image on its own line (documents of either kind): ![alt|width](src).
    const image = IMAGE_LINE.exec(line);
    if (image) {
      const [, label, src] = image;
      const sized = /^(.*?)\|(\d{2,5})$/.exec(label);
      segments.push({
        type: "image",
        start,
        end: lineEnd(index),
        alt: sized ? sized[1] : label,
        src,
        ...(sized ? { width: Number(sized[2]) } : {}),
      });
      index++;
      continue;
    }
    const heading = plain ? null : /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      segments.push({
        type: "heading",
        start,
        end: lineEnd(index),
        level: heading[1].length,
        text: heading[2],
      });
      index++;
      continue;
    }
    if (!plain && /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      segments.push({ type: "hr", start, end: lineEnd(index) });
      index++;
      continue;
    }
    if (!plain && /^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]))
        quote.push(clean(lines[index++]).replace(/^\s*>\s?/, ""));
      segments.push({ type: "quote", start, end: lineEnd(index - 1), text: quote.join(" ") });
      continue;
    }
    if (!plain && /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)) {
      const ordered = /^\s*\d+\./.test(line),
        items: string[] = [];
      while (
        index < lines.length &&
        (ordered
          ? /^\s*\d+\.\s+/.test(lines[index])
          : /^\s*[-*+]\s+/.test(lines[index]))
      )
        items.push(clean(lines[index++]).replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, ""));
      segments.push({ type: "list", start, end: lineEnd(index - 1), ordered, items });
      continue;
    }
    const paragraph = [line];
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !IMAGE_LINE.test(clean(lines[index])) &&
      !(plain
        ? /^\s*(?:`{3}|~{3})/
        : /^\s*(?:#{1,6}\s|`{3}|~{3}|>|[-*+]\s|\d+\.\s)/
      ).test(lines[index])
    )
      paragraph.push(clean(lines[index++]));
    segments.push({
      type: "paragraph",
      start,
      end: lineEnd(index - 1),
      text: paragraph.join("\n"),
    });
  }
  return segments;
}

// A fence longer than any backtick run inside the code keeps the block intact.
export function fence(language: string, content: string) {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${content.replace(/\n$/, "")}\n${marks}`;
}

export type TextEdit = { start: number; remove: number; insert: string };
export function replaceSegment(segment: Segment, text: string): TextEdit {
  return { start: segment.start, remove: segment.end - segment.start, insert: text };
}
// Rewrites only the opening fence line's language; the code itself is untouched.
export function setFenceLanguage(
  source: string,
  segment: Segment,
  language: string,
): TextEdit | null {
  const end = source.indexOf("\n", segment.start);
  const opening = source.slice(segment.start, end < 0 ? source.length : end).replace(/\r$/, "");
  const marks = /^(\s*)(`{3,}|~{3,})/.exec(opening);
  if (!marks) return null;
  return {
    start: segment.start,
    remove: opening.length,
    insert: marks[1] + marks[2] + (language === "plaintext" ? "" : language),
  };
}
// Swaps a block with its neighbouring element, keeping the whitespace between them.
export function moveSegment(
  source: string,
  segments: Segment[],
  index: number,
  direction: -1 | 1,
): TextEdit | null {
  const other = segments[index + direction];
  if (!other) return null;
  const [first, second] =
    direction < 0 ? [other, segments[index]] : [segments[index], other];
  const between = source.slice(first.end, second.start);
  return {
    start: first.start,
    remove: second.end - first.start,
    insert:
      source.slice(second.start, second.end) +
      between +
      source.slice(first.start, first.end),
  };
}
export function deleteSegment(source: string, segment: Segment): TextEdit {
  let end = segment.end;
  // Also remove the line break(s) that followed the block.
  while (end < source.length && end - segment.end < 2 && source[end] === "\n") end++;
  let start = segment.start;
  if (end === source.length)
    while (start > 0 && segment.start - start < 2 && source[start - 1] === "\n") start--;
  return { start, remove: end - start, insert: "" };
}
// Inserts a block at an offset, padded with blank lines so it stays its own element.
export function insertBlock(source: string, offset: number, block: string): TextEdit {
  const before = source.slice(0, offset),
    after = source.slice(offset);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return { start: offset, remove: 0, insert: lead + block + trail };
}

// Documents (Markdown lessons and Plain Text notes) support inline code blocks.
// Programming source files never do, so backticks there stay ordinary characters.
export const isDocumentLanguage = (language: string | undefined) =>
  language === "markdown" || language === "plaintext";
// True for words that name a supported language (e.g. "bash", "py", "terraform").
export function isLanguageName(word: string) {
  const value = word.trim().toLowerCase();
  return (
    !!value &&
    (Object.hasOwn(aliases, value) || languages.some(([id]) => id === value))
  );
}
export const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
export type FenceBlock = { open: number; close: number; info: string; marks: string };
// Pairs fence lines in order; line numbers are 0-based. An unclosed fence has close -1.
export function fenceBlocks(lines: string[]): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  let current: FenceBlock | null = null;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (!current) {
      const open = FENCE.exec(line);
      if (open) current = { open: index, close: -1, info: open[3], marks: open[2] };
    } else if (
      new RegExp(`^\\s*${current.marks[0] === "`" ? "`" : "~"}{${current.marks.length},}\\s*$`).test(line)
    ) {
      current.close = index;
      blocks.push(current);
      current = null;
    }
  });
  if (current) blocks.push(current);
  return blocks;
}
