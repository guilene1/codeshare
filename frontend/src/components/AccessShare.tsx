import { useEffect, useState, type FormEvent } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  Link,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldOff,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import { BRAND } from "../brand";
import type { ShareRole } from "../workspaces";

type Share = {
  userId: string;
  displayName: string;
  email: string;
  role: ShareRole;
};

// Owners add existing registered users so the workspace appears in their Shared with Me.
// Students never need this: the viewer link above works without an account.
function PeopleAccess({ id }: { id: string }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ shares: Share[] }>(`/rooms/${id}/shares`)
      .then((result) => setShares(result.shares))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  async function change(
    run: () => Promise<{ shares: Share[] }>,
  ): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      setShares((await run()).shares);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (
      await change(() =>
        api(`/rooms/${id}/shares`, "POST", { email: email.trim(), role }),
      )
    )
      setEmail("");
  }
  return (
    <section className="access-share-section people-access" aria-label="People with access">
      <h3>
        <UserPlus size={16} />
        People with access
      </h3>
      <p>
        Add someone who already has a {BRAND} account. The workspace appears in
        their Shared with Me list.
      </p>
      <form className="people-add" onSubmit={(e) => void add(e)}>
        <input
          type="email"
          required
          aria-label="Email address"
          placeholder="name@example.com"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          aria-label="Permission"
          value={role}
          onChange={(e) => setRole(e.target.value as ShareRole)}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button className="button primary" disabled={busy || !email.trim()}>
          {busy && <Loader2 size={15} className="spin" />} Share
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {shares === null ? (
        !error && (
          <p className="fine-print">
            <Loader2 size={14} className="spin" /> Loading…
          </p>
        )
      ) : !shares.length ? (
        <p className="fine-print">Not shared with any accounts yet.</p>
      ) : (
        <ul className="people-list">
          {shares.map((share) => (
            <li key={share.userId}>
              <span>
                <strong>{share.displayName}</strong>
                <small>{share.email}</small>
              </span>
              <select
                aria-label={`Permission for ${share.displayName}`}
                value={share.role}
                disabled={busy}
                onChange={(e) =>
                  void change(() =>
                    api(`/rooms/${id}/shares/${share.userId}`, "PATCH", {
                      role: e.target.value,
                    }),
                  )
                }
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                className="icon-button"
                aria-label={`Remove ${share.displayName}`}
                title="Remove access"
                disabled={busy}
                onClick={() =>
                  void change(() =>
                    api(`/rooms/${id}/shares/${share.userId}`, "DELETE"),
                  )
                }
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export default function AccessShare({
  id,
  name,
  editorToken,
  owner,
  hasEditorLink,
  folderId,
  freshToken,
  onFreshToken,
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
  // A link created during this page session. Only its hash is stored on the server, so it
  // lives in memory alone (never browser storage) and is gone after a refresh.
  freshToken: string;
  onFreshToken: (token: string) => void;
  copy: (value: string, label: string) => void;
  onLinkChange: (exists: boolean) => void;
  onClose: () => void;
}) {
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState<"replace" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = location.origin + "/w/" + id;
  const lesson = folderId ? "?folder=" + folderId : "";
  const studentLink = base + lesson;
  const token = owner ? freshToken : editorToken;
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
        onFreshToken(result.token);
        onLinkChange(true);
      } else {
        await api(`/rooms/${id}/editor-link`, "DELETE");
        onFreshToken("");
        onLinkChange(false);
      }
      setShow(false);
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={"Share “" + name + "”"} onClose={onClose}>
      <p className="modal-description">
        Bring your class into the workspace. Students open the link right away,
        with no account or sign-in.
      </p>
      <section className="access-share-section">
        <h3>
          <Users size={16} />
          Students · View only
        </h3>
        <p>Anyone with this link can follow along live. Share it with your whole class.</p>
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
        <section className="access-share-section private-access" aria-label="Editors">
          <h3>
            <LockKeyhole size={16} />
            Editors · Can edit
          </h3>
          <p>
            Anyone with the Edit Link can edit files and manage lesson folders.
            {owner
              ? " Only you can rename, delete or share this workspace."
              : " Keep it private."}
          </p>
          {editorLink ? (
            <>
              <label className="field">
                Edit link
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
                    aria-label={show ? "Hide edit link" : "Show edit link"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Copy edit link"
                    onClick={() => copy(editorLink, "Edit link")}
                  >
                    <Copy size={17} />
                  </button>
                </div>
              </label>
              {owner && (
                <p className="fine-print">
                  Available until you refresh or leave this page. For security,{" "}
                  {BRAND} can't show this link again later.
                </p>
              )}
              <button
                className="button secondary full"
                onClick={() => copy(editorLink, "Edit link")}
              >
                <Link size={16} />
                Copy Edit Link
              </button>
            </>
          ) : (
            owner && (
              <p className="fine-print">
                {hasEditorLink
                  ? `An Edit Link is active, but it can't be displayed again: for security, ${BRAND} keeps only a fingerprint of it and showed it once when it was created. Replace it to get a new link; the current link will stop working.`
                  : "No Edit Link exists yet. Create one to let a co-editor edit without an account."}
              </p>
            )
          )}
          {owner &&
            (confirm ? (
              <div className="share-confirm" role="group" aria-label="Confirm Edit Link change">
                <p>
                  {confirm === "replace"
                    ? "Replace the Edit Link? Anyone using the current link loses editing access right away."
                    : "Revoke the Edit Link? Anyone using it loses editing access right away."}
                </p>
                <div className="dialog-actions">
                  <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void manage(confirm === "replace" ? "POST" : "DELETE")}
                  >
                    {busy && <Loader2 size={15} className="spin" />}
                    {confirm === "replace" ? "Yes, replace link" : "Yes, revoke link"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="dialog-actions">
                {hasEditorLink && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm("revoke")}
                  >
                    <ShieldOff size={15} /> Revoke link
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => (hasEditorLink ? setConfirm("replace") : void manage("POST"))}
                >
                  {busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  {hasEditorLink ? "Replace link" : "Create Edit Link"}
                </button>
              </div>
            ))}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
      {owner && <PeopleAccess id={id} />}
    </Modal>
  );
}
