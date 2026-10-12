import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ImageOff,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type * as Y from "yjs";
import type { FileDoc } from "../lib";
import {
  deleteSegment,
  detectLanguage,
  fence,
  imageMarkdown,
  insertBlock,
  languageId,
  languageLabel,
  moveSegment,
  parseMarkdown,
  replaceSegment,
  setFenceLanguage,
  workspaceImage,
  type CodeSegment,
  type ImageSegment,
  type Segment,
  type TextEdit,
} from "../markdown";
import CodeBlockDialog from "./CodeBlockDialog";
import ImageViewer from "./ImageViewer";
import { imagesIn, type FoundImages } from "../documentImages";
import { findLinks } from "../links";
import HighlightedLines, { languageAccent } from "./HighlightedCode";

// Bare http(s) addresses in prose become links that open in a new tab. Used for
// Markdown text and Plain Text documents; never for inline code or code blocks.
function linkify(text: string): ReactNode[] {
  return findLinks(text).map((part, index) =>
    part.href ? (
      <a key={index} className="doc-link" href={part.href} target="_blank" rel="noopener noreferrer">
        {part.text}
      </a>
    ) : (
      part.text
    ),
  );
}

// Source text is rendered only as React text nodes; links are limited to safe schemes.
function inline(text: string): ReactNode[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g,
  );
  return parts.map((part, index) => {
    if (part.startsWith("`"))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**"))
      return <strong key={index}>{linkify(part.slice(2, -2))}</strong>;
    if (part.startsWith("*")) return <em key={index}>{linkify(part.slice(1, -1))}</em>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      if (/^(https?:\/\/|mailto:|#)/i.test(link[2]))
        return (
          <a
            key={index}
            className="doc-link"
            href={link[2]}
            rel="noopener noreferrer"
            target={link[2].startsWith("#") ? undefined : "_blank"}
          >
            {link[1]}
          </a>
        );
      return <span key={index}>{link[1]}</span>;
    }
    return <Fragment key={index}>{linkify(part)}</Fragment>;
  });
}

function InlineCodeBlock({
  segment,
  actions,
  firstLine,
  codeLines,
  closeLine,
  onSetLanguage,
}: {
  segment: CodeSegment;
  actions?: ReactNode;
  // 1-based source line of the opening fence, number of code lines, closing fence line.
  firstLine: number;
  codeLines: number;
  closeLine?: number;
  // Editors only: writes a detected language into the block's opening fence.
  onSetLanguage?: (language: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const detected = segment.language ? null : detectLanguage(segment.content);
  const language = detected ?? languageId(segment.language);
  const plainLines = segment.content.split("\n");
  const lines = Array.from({ length: codeLines }, (_, k) => plainLines[k] ?? "");
  return (
    <div
      className="markdown-code inline-block"
      data-language={segment.language}
      style={{ "--lang": languageAccent(language) } as CSSProperties}
    >
      <div className="inline-block-header pv-line" data-line={firstLine}>
        <span className="inline-block-title">
          <span className="inline-block-label">
            {detected ? languageLabel(detected) : languageLabel(segment.language)}
          </span>
          {detected && (
            <span
              className="inline-block-detected"
              title="This block has no language set; colours are detected automatically."
            >
              auto
            </span>
          )}
        </span>
        <span className="inline-block-actions">
          {detected && onSetLanguage && (
            <button
              className="inline-block-set"
              title="Save this language in the document"
              onClick={() => onSetLanguage(detected)}
            >
              Set as {languageLabel(detected)}
            </button>
          )}
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
      <div className="code-body">
        {/* Source line numbers sit in the document's number column, outside the scrolling
            code, so long lines scroll sideways while every number stays visible. */}
        <div className="code-gutter" aria-hidden="true">
          {lines.map((_, k) => (
            <div key={k} className="pv-line pv-code-line" data-line={firstLine + 1 + k} />
          ))}
        </div>
        <pre tabIndex={0} aria-label={`${languageLabel(language)} code`}>
          <code>
            <HighlightedLines lines={lines} language={language} />
          </code>
        </pre>
      </div>
      {closeLine !== undefined && (
        <div className="pv-line pv-fence-end" data-line={closeLine} />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

// An inline document image: original resolution, never cropped or upscaled; large
// images fill the document width. Clicking opens the full-screen zoom viewer.
function DocImage({
  segment,
  line,
  onResize,
}: {
  segment: ImageSegment;
  line: number;
  // Editors only: saves a display width in pixels (undefined = original size).
  onResize?: (width: number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // A busy moment (e.g. a whole class loading at once) can briefly refuse an image;
  // retry a few times with growing pauses before showing it as unavailable.
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const width = dragWidth ?? segment.width;
  if (!workspaceImage(segment.src))
    return (
      <p className="pv-line doc-image-missing" data-line={line}>
        <ImageOff size={14} /> Image not shown: only images added to Kodelumi are displayed
        {segment.alt ? ` (${segment.alt})` : ""}.
      </p>
    );
  return (
    <figure
      ref={figure}
      className={"pv-line doc-image" + (width ? " sized" : "")}
      data-line={line}
    >
      {failed ? (
        <span className="doc-image-missing">
          <ImageOff size={14} /> This image could not be loaded{segment.alt ? `: ${segment.alt}` : ""}.
        </span>
      ) : (
        <button
          type="button"
          className="doc-image-open"
          aria-label={`Open image full screen${segment.alt ? ": " + segment.alt : ""}`}
          title="Click to zoom"
          onClick={() => setOpen(true)}
          style={width ? { width } : undefined}
        >
          <img
            src={attempt ? `${segment.src}?retry=${attempt}` : segment.src}
            alt={segment.alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => {
              if (attempt >= 3) setFailed(true);
              else retry.current = setTimeout(() => setAttempt((n) => n + 1), (attempt + 1) * 2000 + Math.random() * 1000);
            }}
          />
        </button>
      )}
      {onResize && !failed && (
        <span
          className="doc-image-resize"
          role="separator"
          aria-label="Resize image (double-click for original size)"
          title="Drag to resize · double-click for original size"
          onDoubleClick={() => onResize(undefined)}
          onPointerDown={(event) => {
            const img = figure.current?.querySelector("img");
            if (!img) return;
            event.preventDefault();
            const handle = event.currentTarget;
            handle.setPointerCapture(event.pointerId);
            const startX = event.clientX,
              startWidth = img.getBoundingClientRect().width,
              available = figure.current!.clientWidth;
            let next = startWidth;
            const move = (e: PointerEvent) => {
              next = Math.round(Math.min(available, Math.max(80, startWidth + e.clientX - startX)));
              setDragWidth(next);
            };
            const up = () => {
              handle.removeEventListener("pointermove", move);
              handle.removeEventListener("pointerup", up);
              setDragWidth(null);
              // Full width is the default, so it is stored as "no width".
              if (Math.abs(next - startWidth) >= 2)
                onResize(next >= available - 2 ? undefined : next);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
          }}
        />
      )}
      {open && (
        <ImageViewer src={segment.src} alt={segment.alt} onClose={() => setOpen(false)} />
      )}
    </figure>
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
  fontSize,
  canEdit = false,
  plain = false,
  notify,
  onImages,
}: {
  file: FileDoc;
  fontSize: number;
  canEdit?: boolean;
  plain?: boolean;
  notify?: (message: string) => void;
  // Editors in Preview: images pasted or dropped here are added at the end.
  onImages?: (found: FoundImages) => void;
}) {
  const imagesRef = useRef(onImages);
  imagesRef.current = onImages;
  // Preview has no text cursor, so Ctrl+V anywhere outside an input adds images.
  useEffect(() => {
    if (!canEdit) return;
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !imagesRef.current ||
        target?.closest("input, textarea, select, [contenteditable], .monaco-editor, [role=dialog]")
      )
        return;
      const found = imagesIn(event.clipboardData);
      if (!found.files.length && !found.urls.length && !found.unsupported) return;
      event.preventDefault();
      imagesRef.current(found);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [canEdit]);
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
            firstLine={first + 1}
            codeLines={closedFence(last) ? last - first - 1 : last - first}
            closeLine={closedFence(last) ? last + 1 : undefined}
            onSetLanguage={
              canEdit
                ? (language) =>
                    run(segment, (s, all, i) => setFenceLanguage(s, all[i], language))
                : undefined
            }
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
      case "image":
        return (
          <DocImage
            key={key}
            segment={segment}
            line={first + 1}
            onResize={
              canEdit
                ? (width) =>
                    run(segment, (_s, all, i) => {
                      const image = all[i] as ImageSegment;
                      return replaceSegment(image, imageMarkdown(image.alt, image.src, width));
                    })
                : undefined
            }
          />
        );
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
                {plain ? linkify(sourceLine(n)) : inline(sourceLine(n))}
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
      onDragOver={(event) => {
        if (canEdit && onImages && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (!canEdit || !onImages) return;
        const found = imagesIn(event.dataTransfer, false);
        if (!found.files.length && !found.unsupported) return;
        event.preventDefault();
        onImages(found);
      }}
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
