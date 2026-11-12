import { useEffect, useState, type FormEvent } from "react";
import { Copy, CornerLeftUp, Link, Loader2, LockKeyhole, UserPlus, Users, X } from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import { BRAND } from "../brand";
import type { ShareRole, TeamSummary } from "../workspaces";

// One folder's sharing, as the server lists it to the people who manage it (the workspace
// owner and direct Editors): its own (direct) shares, which can be changed here, and those it
// inherits from parent folders, which are read-only here and name the folder they come from.
type From = { folderId: string; name: string };
type Person = { userId: string; displayName: string; email: string; role: ShareRole; createdAt: number };
type Team = { teamId: string; name: string; role: ShareRole; memberCount: number; createdAt: number };
type Sharing = {
  folder: { id: string; name: string };
  direct: { people: Person[]; teams: Team[] };
  inherited: { people: (Person & { from: From })[]; teams: (Team & { from: From })[] };
};
// A revocation waiting for confirmation.
type Removal = { kind: "person"; id: string; name: string } | { kind: "team"; id: string; name: string };

const roleLabel = (role: ShareRole) => (role === "editor" ? "Editor" : "Viewer");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function FolderShare({
  workspaceId,
  folder,
  visibility,
  selfId,
  copy,
  onChange,
  onClose,
}: {
  workspaceId: string;
  folder: { id: string; name: string };
  // Folder sharing exists only in Restricted workspaces; this popup never changes that.
  visibility: "link" | "private";
  selfId?: string;
  copy: (value: string, label: string) => void;
  // After any change, so the Explorer's shared-folder indicators follow.
  onChange: () => void;
  onClose: () => void;
}) {
  const restricted = visibility === "private";
  const base = `/rooms/${workspaceId}/folders/${folder.id}`;
  const link = `${location.origin}/w/${workspaceId}?folder=${folder.id}`;
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [teamId, setTeamId] = useState("");
  const [teamRole, setTeamRole] = useState<ShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [peopleError, setPeopleError] = useState("");
  const [teamError, setTeamError] = useState("");
  const [removing, setRemoving] = useState<Removal | null>(null);
  useEffect(() => {
    if (!restricted) return;
    api<Sharing>(`${base}/shares`)
      .then(setSharing)
      .catch((e) => setPeopleError((e as Error).message));
    api<{ teams: TeamSummary[] }>("/teams")
      .then((result) => setTeams(result.teams))
      .catch((e) => setTeamError((e as Error).message));
  }, [base, restricted]);
  // Every change returns the folder's sharing as it now stands.
  async function change(run: () => Promise<Sharing>, setError: (message: string) => void) {
    setBusy(true);
    setPeopleError("");
    setTeamError("");
    try {
      setSharing(await run());
      onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function addPerson(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    // Friendly checks first; the server checks the same and decides.
    if (!EMAIL.test(value)) {
      setPeopleError("Enter a complete email address, like name@example.com.");
      return;
    }
    const existing = sharing?.direct.people.find((p) => p.email.toLowerCase() === value.toLowerCase());
    if (existing) {
      setPeopleError(
        `${existing.displayName} already has ${roleLabel(existing.role)} access to this folder. Change their permission in the list below.`,
      );
      return;
    }
    if (await change(() => api<Sharing>(`${base}/shares`, "POST", { email: value, role }), setPeopleError)) setEmail("");
  }
  async function addTeam(event: FormEvent) {
    event.preventDefault();
    if (await change(() => api<Sharing>(`${base}/team-shares`, "POST", { teamId, role: teamRole }), setTeamError))
      setTeamId("");
  }
  const inheritedNote = (from: From) => (
    <small className="inherited-from">
      <CornerLeftUp size={11} /> From “{from.name}”
    </small>
  );
  const availableTeams = (teams ?? []).filter((t) => !(sharing?.direct.teams ?? []).some((s) => s.teamId === t.id));
  return (
    <Modal title={"Share folder “" + folder.name + "”"} onClose={onClose}>
      <p className="modal-description">
        People and teams you add can open this folder and everything inside it, and nothing else in
        the workspace. They see the folder’s name and yours, never the workspace’s name or its other
        folders.
      </p>
      <section className="access-share-section" aria-label="Folder link">
        <h3>
          <Link size={16} />
          Folder link
        </h3>
        <p>Only people with access to this folder can open it, after signing in to {BRAND}.</p>
        <label className="field">
          Folder link
          <div className="copy-field">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="icon-button" aria-label="Copy link from the Folder link field" title="Copy link" onClick={() => copy(link, "Folder link")}>
              <Copy size={17} />
            </button>
          </div>
        </label>
        <button className="button secondary full" onClick={() => copy(link, "Folder link")}>
          <Link size={16} />
          Copy Folder Link
        </button>
      </section>
      {!restricted ? (
        <section className="access-share-section private-access" aria-label="Folder sharing unavailable">
          <h3>
            <LockKeyhole size={16} />
            Restricted workspaces only
          </h3>
          <p>
            Anyone with the workspace link can already view every folder, so a folder can be shared on its
            own only when the workspace’s General access is Restricted. You can change that in the
            workspace’s Share popup; nothing changes automatically.
          </p>
        </section>
      ) : (
        <>
          <section className="access-share-section people-access" aria-label="People with access">
            <h3>
              <UserPlus size={16} />
              People with access
            </h3>
            <p>Add someone who already has a {BRAND} account. The folder appears in their Shared with Me list.</p>
            <form className="people-add" onSubmit={(e) => void addPerson(e)} noValidate>
              <input
                type="email"
                required
                aria-label="Email address"
                placeholder="name@example.com"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <select aria-label="Permission" value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button className="button primary" disabled={busy || !email.trim()}>
                {busy && <Loader2 size={15} className="spin" />} Share
              </button>
            </form>
            {peopleError && (
              <p className="error" role="alert">
                {peopleError}
              </p>
            )}
            {sharing === null ? (
              !peopleError && (
                <p className="fine-print">
                  <Loader2 size={14} className="spin" /> Loading…
                </p>
              )
            ) : (
              <>
                {!sharing.direct.people.length ? (
                  <p className="fine-print">Not shared with any accounts yet.</p>
                ) : (
                  <ul className="people-list" aria-label="People with direct access">
                    {sharing.direct.people.map((person) => (
                      <li key={person.userId}>
                        <span>
                          <strong>
                            {person.displayName}
                            {person.userId === selfId && " (you)"}
                          </strong>
                          <small>{person.email}</small>
                        </span>
                        <select
                          aria-label={`Permission for ${person.displayName}`}
                          value={person.role}
                          disabled={busy}
                          onChange={(e) =>
                            void change(
                              () => api<Sharing>(`${base}/shares/${person.userId}`, "PATCH", { role: e.target.value }),
                              setPeopleError,
                            )
                          }
                        >
                          <option value="viewer">Viewer</option>
                          <option value="editor">Editor</option>
                        </select>
                        <button
                          className="icon-button"
                          aria-label={`Remove ${person.displayName}`}
                          title="Remove access"
                          disabled={busy}
                          onClick={() => setRemoving({ kind: "person", id: person.userId, name: person.displayName })}
                        >
                          <X size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!!sharing.inherited.people.length && (
                  <>
                    <h4 className="inherited-heading">From parent folders · change them there</h4>
                    <ul className="people-list inherited" aria-label="People with inherited access">
                      {sharing.inherited.people.map((person) => (
                        <li key={person.from.folderId + person.userId}>
                          <span>
                            <strong>{person.displayName}</strong>
                            <small>{person.email}</small>
                            {inheritedNote(person.from)}
                          </span>
                          <span className={"role-badge " + person.role}>{roleLabel(person.role)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
          <section className="access-share-section team-access" aria-label="Teams with access">
            <h3>
              <Users size={16} />
              Teams with access
            </h3>
            <p>Share with a team you belong to. Everyone in the team gets this access, and people who join later get it too.</p>
            {teams === null ? null : !teams.length ? (
              <p className="fine-print">
                You're not in a team yet. <a href="/workspaces?view=teams">Create one in My Teams</a>.
              </p>
            ) : (
              <form className="people-add" onSubmit={(e) => void addTeam(e)}>
                <select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!availableTeams.length}>
                  <option value="">{availableTeams.length ? "Choose a team…" : "All your teams have access"}</option>
                  {availableTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
                <select aria-label="Team permission" value={teamRole} onChange={(e) => setTeamRole(e.target.value as ShareRole)}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button className="button primary" disabled={busy || !teamId}>
                  {busy && <Loader2 size={15} className="spin" />} Share
                </button>
              </form>
            )}
            {teamError && (
              <p className="error" role="alert">
                {teamError}
              </p>
            )}
            {sharing && (
              <>
                {!sharing.direct.teams.length ? (
                  <p className="fine-print">Not shared with any teams yet.</p>
                ) : (
                  <ul className="people-list" aria-label="Teams with direct access">
                    {sharing.direct.teams.map((team) => (
                      <li key={team.teamId}>
                        <span>
                          <strong>{team.name}</strong>
                          <small>
                            {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
                          </small>
                        </span>
                        <select
                          aria-label={`Permission for ${team.name}`}
                          value={team.role}
                          disabled={busy}
                          onChange={(e) =>
                            void change(
                              () => api<Sharing>(`${base}/team-shares/${team.teamId}`, "PATCH", { role: e.target.value }),
                              setTeamError,
                            )
                          }
                        >
                          <option value="viewer">Viewer</option>
                          <option value="editor">Editor</option>
                        </select>
                        <button
                          className="icon-button"
                          aria-label={`Remove ${team.name}`}
                          title="Remove team access"
                          disabled={busy}
                          onClick={() => setRemoving({ kind: "team", id: team.teamId, name: team.name })}
                        >
                          <X size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {!!sharing.inherited.teams.length && (
                  <>
                    <h4 className="inherited-heading">From parent folders · change them there</h4>
                    <ul className="people-list inherited" aria-label="Teams with inherited access">
                      {sharing.inherited.teams.map((team) => (
                        <li key={team.from.folderId + team.teamId}>
                          <span>
                            <strong>{team.name}</strong>
                            <small>
                              {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
                            </small>
                            {inheritedNote(team.from)}
                          </span>
                          <span className={"role-badge " + team.role}>{roleLabel(team.role)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
          {removing && (
            <div className="share-confirm" role="group" aria-label="Confirm folder access removal">
              <p>
                Remove {removing.name}’s access to this folder?{" "}
                {removing.kind === "team" ? "Its members lose" : "They lose"} it right away, unless they have
                another way in (a parent folder, the workspace itself, or a team).
              </p>
              <div className="dialog-actions">
                <button className="button secondary" disabled={busy} onClick={() => setRemoving(null)}>
                  Cancel
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  autoFocus
                  onClick={() => {
                    const target = removing;
                    setRemoving(null);
                    void change(
                      () =>
                        api<Sharing>(
                          target.kind === "person" ? `${base}/shares/${target.id}` : `${base}/team-shares/${target.id}`,
                          "DELETE",
                        ),
                      target.kind === "person" ? setPeopleError : setTeamError,
                    );
                  }}
                >
                  {busy && <Loader2 size={15} className="spin" />} Remove access
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
