import { useState, type FormEvent } from "react";
import { Code2 } from "lucide-react";
import Modal from "./Modal";
import { languages } from "../lib";

export type BlockDraft = { language: string; content: string; target?: string };
// Used to insert, edit, or create an inline lesson code block from a selection.
export default function CodeBlockDialog({
  title,
  initial,
  targets,
  submitLabel,
  onSave,
  onClose,
}: {
  title: string;
  initial: BlockDraft;
  // When adding from a source file: Markdown lessons that can receive the block.
  targets?: Array<{ id: string; filename: string }>;
  submitLabel: string;
  onSave: (draft: BlockDraft) => void;
  onClose: () => void;
}) {
  const [language, setLanguage] = useState(initial.language || "shell");
  const [content, setContent] = useState(initial.content);
  const [target, setTarget] = useState(initial.target ?? targets?.[0]?.id ?? "new");
  const tooLarge = new TextEncoder().encode(content).length > 64 * 1024;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!content.trim() || tooLarge) return;
    onSave({ language, content, target });
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="code-block-form">
        {targets && (
          <label className="field">
            Add to lesson document
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.filename}
                </option>
              ))}
              <option value="new">New lesson document (lesson.md)</option>
            </select>
          </label>
        )}
        <label className="field">
          Language
          <select
            aria-label="Code block language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {languages.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Code
          <textarea
            aria-label="Code block content"
            className="paste-code-input"
            autoFocus
            spellCheck={false}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="terraform init"
          />
        </label>
        {tooLarge && (
          <p className="error" role="alert">
            Code blocks can be up to 64 KB.
          </p>
        )}
        <button
          type="submit"
          className="button primary full"
          disabled={!content.trim() || tooLarge}
        >
          <Code2 size={16} /> {submitLabel}
        </button>
      </form>
    </Modal>
  );
}
