import { useState } from "react";
import { Copy, Eye, EyeOff, Link, LockKeyhole, Users } from "lucide-react";
import Modal from "./Modal";
export default function AccessShare({
  id,
  name,
  editorToken,
  folderId,
  copy,
  onClose,
}: {
  id: string;
  name: string;
  editorToken?: string;
  folderId?: string | null;
  copy: (value: string, label: string) => void;
  onClose: () => void;
}) {
  const [show, setShow] = useState(false);
  const base = location.origin + "/w/" + id;
  const lesson = folderId ? "?folder=" + folderId : "";
  const studentLink = base + lesson;
  const editorLink = editorToken ? base + "/edit/" + editorToken + lesson : "";
  return (
    <Modal title={"Share “" + name + "”"} onClose={onClose}>
      <p className="modal-description">
        Bring your class into the workspace. Students can view and copy every
        example.
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
      {editorToken && (
        <section className="access-share-section private-access">
          <h3>
            <LockKeyhole size={16} />
            Private editor access
          </h3>
          <p>
            Anyone with this private link can edit code and manage files. Keep
            it private.
          </p>
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
          <button
            className="button primary full"
            onClick={() => copy(editorLink, "Editor link")}
          >
            <Copy size={16} />
            Copy Editor Link
          </button>
        </section>
      )}
    </Modal>
  );
}
