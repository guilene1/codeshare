import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type * as Y from "yjs";
import type { FileDoc } from "../lib";
import {
  deleteSegment,
  fence,
  insertBlock,
  languageId,
  languageLabel,
  moveSegment,
  parseMarkdown,
  replaceSegment,
  type CodeSegment,
  type Segment,
  type TextEdit,
} from "../markdown";
import CodeBlockDialog from "./CodeBlockDialog";

// Source text is rendered only as React text nodes; links are limited to safe schemes.
function inline(text: string): ReactNode[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g,
  );
  return parts.map((part, index) => {
    if (part.startsWith("`"))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**"))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      if (/^(https?:\/\/|mailto:|#)/i.test(link[2]))
        return (
          <a
            key={index}
            href={link[2]}
            rel="noopener noreferrer"
            target={link[2].startsWith("#") ? undefined : "_blank"}
          >
            {link[1]}
          </a>
        );
      return <span key={index}>{link[1]}</span>;
    }
    return part;
  });
}

function InlineCodeBlock({
  segment,
  dark,
  actions,
  firstLine,
  codeLines,
  closeLine,
}: {
  segment: CodeSegment;
  dark: boolean;
  actions?: ReactNode;
  // 1-based source line of the opening fence, number of code lines, closing fence line.
  firstLine: number;
  codeLines: number;
  closeLine?: number;
}) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let canceled = false;
    setHtml("");
    import("./CodeEditor")
      .then((module) =>
        // Monaco's colorizer escapes the code; the result contains only its own spans.
        module.colorizeCode(segment.content, languageId(segment.language), dark),
      )
      .then((value) => {
        if (!canceled) setHtml(value);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [segment.content, segment.language, dark]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const plainLines = segment.content.split("\n");
  const colored = html
    .replace(/^\s*<div[^>]*>/, "")
    .replace(/<\/div>\s*$/, "")
    .split(/<br\s*\/?>/);
  const lineHtml = html && colored.length === plainLines.length ? colored : null;
  return (
    <div className="markdown-code inline-block" data-language={segment.language}>
      <div className="inline-block-header pv-line" data-line={firstLine}>
        <span className="inline-block-label">
          {languageLabel(segment.language)}
        </span>
        <span className="inline-block-actions">
          {actions}
          <button
            className="snippet-copy"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(segment.content);
                setCopied(true);
                setError("");
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 2000);
              } catch {
                setError("Select the code and press Ctrl / ⌘ C.");
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied!" : "Copy code"}
          </button>
        </span>
      </div>
      <pre>
        <code>
          {Array.from({ length: codeLines }, (_, k) =>
            // Monaco's colorizer joins lines with <br/>; each line gets its own number.
            lineHtml?.[k] !== undefined ? (
              <span
                key={k}
                className="pv-line pv-code-line"
                data-line={firstLine + 1 + k}
                dangerouslySetInnerHTML={{ __html: lineHtml[k] }}
              />
            ) : (
              <span key={k} className="pv-line pv-code-line" data-line={firstLine + 1 + k}>
                {plainLines[k]}
              </span>
            ),
          )}
        </code>
      </pre>
      {closeLine !== undefined && (
        <div className="pv-line pv-fence-end" data-line={closeLine} />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

// Applies a text edit only if the targeted element is still exactly as rendered, so a
// collaborator's concurrent change is never silently overwritten.
function applyEdit(
  text: Y.Text,
  expected: { start: number; raw: string },
  edit: (source: string, segments: Segment[], index: number) => TextEdit | null,
) {
  const source = text.toString(),
    segments = parseMarkdown(source);
  const index = segments.findIndex(
    (s) =>
      s.start === expected.start && source.slice(s.start, s.end) === expected.raw,
  );
  if (index < 0) return false;
  const change = edit(source, segments, index);
  if (!change) return true;
  text.doc!.transact(() => {
    if (change.remove) text.delete(change.start, change.remove);
    if (change.insert) text.insert(change.start, change.insert);
  });
  return true;
}

export default function MarkdownPreview({
  file,
  dark,
  fontSize,
  canEdit = false,
  plain = false,
  notify,
}: {
  file: FileDoc;
  dark: boolean;
  fontSize: number;
  canEdit?: boolean;
  plain?: boolean;
  notify?: (message: string) => void;
}) {
  const [source, setSource] = useState(() => file.content.toString());
  const [editing, setEditing] = useState<
    { segment: CodeSegment; raw: string } | "new" | null
  >(null);
  useEffect(() => {
    const update = () => setSource(file.content.toString());
    update();
    file.content.observe(update);
    return () => file.content.unobserve(update);
  }, [file.content]);
  const segments = parseMarkdown(source, plain);
  // Source line numbers: students see the same numbers as the instructor's editor.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++)
    if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let low = 0,
      high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const sourceLine = (n: number) =>
    source
      .slice(lineStarts[n], (lineStarts[n + 1] ?? source.length + 1) - 1)
      .replace(/\r$/, "");
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const blank = (n: number) => (
    <div key={"blank-" + n} className="pv-line pv-blank" data-line={n + 1} />
  );
  const codeIndexes = segments
    .map((segment, index) => (segment.type === "code" ? index : -1))
    .filter((index) => index >= 0);
  function closedFence(line: number) {
    return /^\s*(`{3,}|~{3,})\s*$/.test(sourceLine(line));
  }
  const run = (
    segment: Segment,
    edit: (source: string, segments: Segment[], index: number) => TextEdit | null,
    raw = source.slice(segment.start, segment.end),
  ) => {
    if (!applyEdit(file.content, { start: segment.start, raw }, edit))
      notify?.("This lesson just changed. Try again.");
  };
  const rendered = segments.map((segment, index) => {
    const key = segment.start;
    const first = lineOf(segment.start),
      last = lineOf(segment.end);
    switch (segment.type) {
      case "code": {
        const position = codeIndexes.indexOf(index);
        return (
          <InlineCodeBlock
            key={key}
            segment={segment}
            dark={dark}
            firstLine={first + 1}
            codeLines={closedFence(last) ? last - first - 1 : last - first}
            closeLine={closedFence(last) ? last + 1 : undefined}
            actions={
              canEdit && (
                <>
                  <button
                    className="icon-button"
                    aria-label="Edit code block"
                    title="Edit code block"
                    onClick={() =>
                      setEditing({
                        segment,
                        raw: source.slice(segment.start, segment.end),
                      })
                    }
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Move code block up"
                    title="Move up"
                    disabled={index === 0}
                    onClick={() =>
                      run(segment, (s, all, i) => moveSegment(s, all, i, -1))
                    }
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Move code block down"
                    title="Move down"
                    disabled={index === segments.length - 1}
                    onClick={() =>
                      run(segment, (s, all, i) => moveSegment(s, all, i, 1))
                    }
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Delete code block"
                    title="Delete code block"
                    onClick={() => {
                      if (confirm("Delete this code block from the lesson?"))
                        run(segment, (s, all, i) => deleteSegment(s, all[i]));
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                  <span className="sr-only">Code block {position + 1}</span>
                </>
              )
            }
          />
        );
      }
      case "heading": {
        const text = inline(segment.text);
        const line = { className: "pv-line", "data-line": first + 1 };
        return segment.level === 1 ? (
          <h1 key={key} {...line}>{text}</h1>
        ) : segment.level === 2 ? (
          <h2 key={key} {...line}>{text}</h2>
        ) : (
          <h3 key={key} {...line}>{text}</h3>
        );
      }
      case "hr":
        return (
          <div key={key} className="pv-line pv-hr" data-line={first + 1}>
            <hr />
          </div>
        );
      case "quote":
        return (
          <blockquote key={key}>
            {range(first, last).map((n) => (
              <span key={n} className="pv-line" data-line={n + 1}>
                {inline(sourceLine(n).replace(/^\s*>\s?/, ""))}
              </span>
            ))}
          </blockquote>
        );
      case "list": {
        const items = segment.items.map((item, i) => (
          <li key={i} className="pv-line" data-line={first + 1 + i}>
            {inline(item)}
          </li>
        ));
        return segment.ordered ? (
          <ol key={key}>{items}</ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      default:
        // Plain Text documents keep their prose literally; Markdown gets inline formatting.
        return (
          <p key={key}>
            {range(first, last).map((n) => (
              <span key={n} className="pv-line" data-line={n + 1}>
                {plain ? sourceLine(n) : inline(sourceLine(n))}
              </span>
            ))}
          </p>
        );
    }
  });
  // Interleave numbered blank lines so numbering matches the source exactly.
  const output: ReactNode[] = [];
  let next = 0;
  segments.forEach((segment, index) => {
    const first = lineOf(segment.start);
    range(next, first - 1).forEach((n) => output.push(blank(n)));
    output.push(rendered[index]);
    next = lineOf(segment.end) + 1;
  });
  if (source) range(next, lineStarts.length - 1).forEach((n) => output.push(blank(n)));
  return (
    <article
      className="markdown-preview numbered"
      aria-label="Markdown preview"
      style={{ fontSize }}
    >
      {output.length ? (
        output
      ) : (
        <p className="muted">Notes for this lesson will appear here.</p>
      )}
      {canEdit && (
        <button
          className="button secondary add-inline-block"
          onClick={() => setEditing("new")}
        >
          <Plus size={15} /> Add code block
        </button>
      )}
      {editing && (
        <CodeBlockDialog
          title={editing === "new" ? "Add code block" : "Edit code block"}
          submitLabel={editing === "new" ? "Add code block" : "Save code block"}
          initial={
            editing === "new"
              ? { language: "shell", content: "" }
              : {
                  language: languageId(editing.segment.language),
                  content: editing.segment.content,
                }
          }
          onClose={() => setEditing(null)}
          onSave={({ language, content }) => {
            // Keep the author's fence spelling (e.g. ```bash) when the language is unchanged.
            const info =
              editing !== "new" &&
              languageId(editing.segment.language) === language
                ? editing.segment.language
                : language;
            const block = fence(info, content);
            if (editing === "new") {
              const text = file.content,
                current = text.toString(),
                change = insertBlock(current, current.length, block);
              text.insert(change.start, change.insert);
            } else
              run(
                editing.segment,
                (_s, all, i) => replaceSegment(all[i], block),
                editing.raw,
              );
            setEditing(null);
          }}
        />
      )}
    </article>
  );
}
