import { useState } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  Link,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldOff,
  Users,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import { BRAND } from "../brand";
export default function AccessShare({
  id,
  name,
  editorToken,
  owner,
  hasEditorLink,
  folderId,
  copy,
  onLinkChange,
  onClose,
}: {
  id: string;
  name: string;
  editorToken?: string;
  owner: boolean;
  hasEditorLink?: boolean;
  folderId?: string | null;
  copy: (value: string, label: string) => void;
  onLinkChange: (exists: boolean) => void;
  onClose: () => void;
}) {
  const [show, setShow] = useState(false);
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = location.origin + "/w/" + id;
  const lesson = folderId ? "?folder=" + folderId : "";
  const studentLink = base + lesson;
  const token = fresh || (owner ? "" : editorToken);
  const editorLink = token ? base + "/edit/" + token + lesson : "";
  async function manage(method: "POST" | "DELETE") {
    setBusy(true);
    setError("");
    try {
      if (method === "POST") {
        const result = await api<{ token: string }>(
          `/rooms/${id}/editor-link`,
          "POST",
          {},
        );
        setFresh(result.token);
        setShow(true);
        onLinkChange(true);
      } else {
        await api(`/rooms/${id}/editor-link`, "DELETE");
        setFresh("");
        onLinkChange(false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={"Share “" + name + "”"} onClose={onClose}>
      <p className="modal-description">
        Bring your class into the workspace. Students can view and copy every
        example without an account.
      </p>
      <section className="access-share-section">
        <h3>
          <Users size={16} />
          Students · View only
        </h3>
        <p>Anyone with this link can follow along, select, and copy code.</p>
        <label className="field">
          Student link
          <div className="copy-field">
            <input
              readOnly
              value={studentLink}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="icon-button"
              aria-label="Copy student link"
              onClick={() => copy(studentLink, "Student link")}
            >
              <Copy size={17} />
            </button>
          </div>
        </label>
        <button
          className="button secondary full"
          onClick={() => copy(studentLink, "Student link")}
        >
          <Link size={16} />
          Copy Student Link
        </button>
        <div className="share-room-code">
          Workspace code <code>{id}</code>
          <button
            className="icon-button"
            aria-label="Copy workspace code"
            onClick={() => copy(id, "Workspace code")}
          >
            <Copy size={14} />
          </button>
        </div>
      </section>
      {(owner || editorToken) && (
        <section className="access-share-section private-access">
          <h3>
            <LockKeyhole size={16} />
            Co-editor access
          </h3>
          <p>
            Anyone with the private editor link can edit code and manage files.
            {owner
              ? " Only you can rename, delete or share ownership of this workspace."
              : " Keep it private."}
          </p>
          {editorLink ? (
            <>
              <label className="field">
                Private editor link
                <div className="copy-field">
                  <input
                    type={show ? "text" : "password"}
                    readOnly
                    value={editorLink}
                    autoComplete="off"
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    className="icon-button"
                    aria-label={show ? "Hide editor link" : "Show editor link"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
              {fresh && (
                <p className="fine-print">
                  Copy it now: for security, {BRAND} shows a new link only
                  once.
                </p>
              )}
              <button
                className="button primary full"
                onClick={() => copy(editorLink, "Editor link")}
              >
                <Copy size={16} />
                Copy Editor Link
              </button>
            </>
          ) : (
            owner && (
              <p className="fine-print">
                {hasEditorLink
                  ? "A co-editor link is active. It was shown once when created; replace it to get a new one."
                  : "No co-editor link exists. You edit through your account."}
              </p>
            )
          )}
          {owner && (
            <div className="dialog-actions">
              {hasEditorLink && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void manage("DELETE")}
                >
                  <ShieldOff size={15} /> Revoke link
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void manage("POST")}
              >
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                {hasEditorLink ? "Replace link" : "Create co-editor link"}
              </button>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </Modal>
  );
}
