import type { Settings } from "../lib";
import Modal from "./Modal";
import { useState } from "react";
export default function SettingsPanel({
  settings,
  update,
  onClose,
  canEdit,
  workspaceName,
  onRename,
  onDelete,
}: {
  settings: Settings;
  update: (s: Settings) => void;
  onClose: () => void;
  canEdit: boolean;
  workspaceName: string;
  onRename?: (name: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(workspaceName),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const set = (key: keyof Settings, value: unknown) =>
    update({ ...settings, [key]: value });
  return (
    <Modal title="Editor settings" onClose={onClose}>
      <p className="modal-description">
        Make this workspace yours. Preferences stay on this device.
      </p>
      {canEdit && onRename && (
        <form
          className="workspace-settings"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onRename(name);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            Workspace name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button secondary full"
            disabled={busy || !name.trim() || name === workspaceName}
            type="submit"
          >
            Save workspace name
          </button>
          <p className="fine-print">
            This name is shared with everyone in the workspace.
          </p>
        </form>
      )}
      {canEdit && onDelete && (
        <details className="delete-workspace">
          <summary>Delete workspace permanently</summary>
          <p className="fine-print">
            Deletes all lesson folders, files and code blocks. Type the
            workspace name to confirm.
          </p>
          <label className="field">
            Confirm workspace name
            <input
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
            />
          </label>
          <button
            className="button secondary full"
            disabled={busy || deleteName !== workspaceName}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onDelete();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Delete workspace
          </button>
        </details>
      )}
      <div className="settings-list">
        <label>
          Font size
          <select
            value={settings.fontSize}
            onChange={(e) => set("fontSize", Number(e.target.value))}
          >
            {[12, 14, 16, 18, 20, 24].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </label>
        <label>
          Indentation
          <select
            value={settings.tabSize}
            onChange={(e) => set("tabSize", Number(e.target.value))}
          >
            {[2, 4, 8].map((n) => (
              <option key={n} value={n}>
                {n} spaces
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["wordWrap", "Word wrap"],
            ["minimap", "Minimap"],
            ["autoSave", "Auto-save checkpoint"],
          ] as const
        )
          .filter(([key]) => canEdit || key !== "autoSave")
          .map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="checkbox"
                role="switch"
                checked={settings[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
            </label>
          ))}
        <label>
          Editor theme
          <select
            value={settings.editorTheme}
            onChange={(e) => set("editorTheme", e.target.value)}
          >
            <option value="auto">Match application</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          Cursor style
          <select
            value={settings.cursorStyle}
            onChange={(e) => set("cursorStyle", e.target.value)}
          >
            <option value="line">Line</option>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
          </select>
        </label>
      </div>
      <p className="fine-print">
        {canEdit
          ? "Live changes always sync and the server checkpoints them for durability. Auto-save also requests a checkpoint from this browser. Use Ctrl / ⌘ S to save manually."
          : "Your preferences change only your view. Instructor edits appear automatically, and you can select and copy code."}
      </p>
      <button className="button primary full" onClick={onClose}>
        Done
      </button>
    </Modal>
  );
}
