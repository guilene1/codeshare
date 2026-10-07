import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Modal from "./Modal";
import { languages, type CodeBlock } from "../lib";

type Draft = Pick<CodeBlock, "title" | "language" | "content">;
type Props = {
  initialDraft?: Draft | null;
  onDraftConsumed?: () => void;
  blocks: CodeBlock[];
  canEdit: boolean;
  connected: boolean;
  dark: boolean;
  fontSize: number;
  onCreate: (draft: Draft) => Promise<unknown>;
  onUpdate: (id: string, draft: Draft) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onReorder: (ids: string[]) => Promise<unknown>;
};

function BlockCard({
  block,
  dark,
  fontSize,
  canEdit,
  busy,
  first,
  last,
  onEdit,
  onDelete,
  onMove,
}: {
  block: CodeBlock;
  dark: boolean;
  fontSize: number;
  canEdit: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: number) => void;
}) {
  const [highlighted, setHighlighted] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let canceled = false;
    setHighlighted("");
    import("./CodeEditor")
      .then((module) =>
        module.colorizeCode(block.content, block.language, dark),
      )
      .then((html) => {
        if (!canceled) setHighlighted(html);
      })
      .catch(() => {
        /* Plain code remains visible if highlighting cannot load. */
      });
    return () => {
      canceled = true;
    };
  }, [block.content, block.language, dark]);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(block.content);
      setCopied(true);
      setError("");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Select the code and press Ctrl / ⌘ C to copy.");
    }
  }
  const compact = !/[\r\n]/.test(block.content) && !block.title;
  const code = (
    <pre
      className="snippet-code"
      style={{ fontSize }}
      tabIndex={0}
      aria-label="Snippet code"
    >
      <code>
        {highlighted ? (
          <span dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          block.content
        )}
      </code>
    </pre>
  );
  const copyButton = (
    <button
      className={"snippet-copy" + (copied ? " copied" : "")}
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy"}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
      {copied ? "Copied" : "Copy"}
    </button>
  );
  const label =
    languages.find((lang) => lang[0] === block.language)?.[1] ?? block.language;
  return (
    <article
      className={"snippet-card" + (compact ? " compact" : "")}
      data-block-id={block.id}
      aria-label={block.title || block.content.split(/\r?\n/)[0].slice(0, 80)}
    >
      {compact ? (
        <div className="snippet-command">
          {code}
          {copyButton}
        </div>
      ) : (
        <>
          <header className="snippet-header">
            <strong>{block.title || "Code snippet"}</strong>
            <span className="snippet-language">{label}</span>
            {copyButton}
          </header>
          {code}
        </>
      )}
      {error && (
        <p className="snippet-error" role="alert">
          {error}
        </p>
      )}
      {canEdit && (
        <footer className="snippet-controls">
          {compact && <span className="snippet-language">{label}</span>}
          <button
            className="icon-button"
            title="Move block up"
            aria-label="Move block up"
            disabled={busy || first}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="icon-button"
            title="Move block down"
            aria-label="Move block down"
            disabled={busy || last}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={14} />
          </button>
          <button className="snippet-edit" disabled={busy} onClick={onEdit}>
            <Pencil size={13} /> Edit
          </button>
          <button
            className="icon-button"
            title="Delete block"
            aria-label="Delete block"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </footer>
      )}
    </article>
  );
}

export default function CodeBlocks({
  initialDraft,
  onDraftConsumed,
  blocks,
  canEdit,
  connected,
  dark,
  fontSize,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
}: Props) {
  const [dialog, setDialog] = useState<"new" | "edit" | "delete" | null>(null);
  const [selected, setSelected] = useState<CodeBlock | null>(null);
  const [draft, setDraft] = useState<Draft>({
    title: "",
    language: "hcl",
    content: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fromSelection, setFromSelection] = useState(false);
  useEffect(() => {
    if (initialDraft && canEdit) {
      setFromSelection(true);
      setSelected(null);
      setDraft(initialDraft);
      setError("");
      setDialog("new");
      onDraftConsumed?.();
    }
  }, [initialDraft, canEdit]);
  function open(mode: "new" | "edit" | "delete", block?: CodeBlock) {
    if (!canEdit) return;
    setFromSelection(false);
    setSelected(block ?? null);
    setDraft(
      block
        ? {
            title: block.title,
            language: block.language,
            content: block.content,
          }
        : { title: "", language: "hcl", content: "" },
    );
    setError("");
    setDialog(mode);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !connected || busy) return;
    setBusy(true);
    setError("");
    try {
      if (dialog === "delete" && selected) await onDelete(selected.id);
      else if (dialog === "edit" && selected)
        await onUpdate(selected.id, draft);
      else await onCreate(draft);
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function move(index: number, direction: number) {
    if (!canEdit || !connected || busy) return;
    const ids = blocks.map((block) => block.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    setBusy(true);
    setError("");
    try {
      await onReorder(ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="code-blocks-panel" aria-label="Code blocks">
      <div className="blocks-heading">
        <div>
          <h2>
            Code Blocks <span>{blocks.length}</span>
          </h2>
          <p>Examples and commands. Copy exactly what you need.</p>
        </div>
        {canEdit && (
          <button
            className="button primary"
            disabled={!connected || busy}
            onClick={() => open("new")}
          >
            <Plus size={16} /> Add Code Block
          </button>
        )}
      </div>
      {error && !dialog && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {blocks.length ? (
        <div className="snippet-list">
          {blocks.map((block, index) => (
            <BlockCard
              key={block.id}
              block={block}
              dark={dark}
              fontSize={fontSize}
              canEdit={canEdit}
              busy={busy || !connected}
              first={index === 0}
              last={index === blocks.length - 1}
              onEdit={() => open("edit", block)}
              onDelete={() => open("delete", block)}
              onMove={(direction) => void move(index, direction)}
            />
          ))}
        </div>
      ) : (
        <div className="blocks-empty">
          <Code2 size={32} />
          <h3>
            {canEdit
              ? "Save reusable snippets for your class."
              : "Your instructor’s snippets will appear here."}
          </h3>
          <p>
            {canEdit
              ? "Add a Terraform example, a short command, or any code students need to copy."
              : "Every block has its own Copy button. Instructor changes appear live."}
          </p>
        </div>
      )}
      {dialog && canEdit && (
        <Modal
          title={
            dialog === "new"
              ? fromSelection
                ? "Create Code Block"
                : "Add Code Block"
              : dialog === "edit"
                ? "Edit Code Block"
                : "Delete Code Block"
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form onSubmit={submit}>
            {dialog === "delete" ? (
              <p className="modal-description">
                Delete{" "}
                {selected?.title ? `“${selected.title}”` : "this snippet"} for
                everyone in the workspace?
              </p>
            ) : (
              <>
                <label className="field">
                  Title <span className="optional">optional</span>
                  <input
                    autoFocus
                    maxLength={120}
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                    placeholder="e.g. Terraform Provider"
                  />
                </label>
                <label className="field">
                  Language
                  <select
                    value={draft.language}
                    onChange={(event) =>
                      setDraft({ ...draft, language: event.target.value })
                    }
                  >
                    {languages.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Code
                  <textarea
                    className="block-draft"
                    required
                    spellCheck={false}
                    rows={9}
                    value={draft.content}
                    onChange={(event) =>
                      setDraft({ ...draft, content: event.target.value })
                    }
                    placeholder={'provider "aws" {\n  region = "us-east-1"\n}'}
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
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={
                  busy ||
                  !connected ||
                  (dialog !== "delete" && !draft.content.trim())
                }
              >
                {busy && <Loader2 className="spin" size={15} />}
                {dialog === "new"
                  ? fromSelection
                    ? "Create Block"
                    : "Add Block"
                  : dialog === "edit"
                    ? "Save Block"
                    : "Delete Block"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
