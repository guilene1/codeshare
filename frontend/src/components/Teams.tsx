import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Crown,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib";
import {
  relativeTime,
  teamRoleLabel,
  type MyInvitation,
  type TeamDetail,
  type TeamMember,
  type TeamRole,
  type TeamSummary,
  type TeamWorkspace,
} from "../workspaces";

// My Teams and Team Workspaces. Every action shown here is also enforced by the server
// for the caller's current role; the UI only hides what that role can't do.

type Confirm = { title: string; text: ReactNode; action: string; danger?: boolean; typed?: string; run: () => Promise<void> };

function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [typed, setTyped] = useState("");
  return (
    <Modal title={confirm.title} onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await confirm.run();
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <p className="modal-description">{confirm.text}</p>
        {confirm.typed !== undefined && (
          <label className="field">
            Type the team name to confirm
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={"button " + (confirm.danger ? "danger" : "primary")}
            disabled={busy || (confirm.typed !== undefined && typed !== confirm.typed)}
          >
            {busy && <Loader2 size={15} className="spin" />} {confirm.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TeamForm({
  title,
  initial,
  submit,
  onClose,
}: {
  title: string;
  initial?: { name: string; description: string };
  submit: (value: { name: string; description: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? ""), [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await submit({ name: name.trim(), description });
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Team name
          <input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="DevOps Team" />
        </label>
        <label className="field">
          Description <span className="optional">optional</span>
          <textarea maxLength={400} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Platform and infrastructure engineers" />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 size={15} className="spin" />} {initial ? "Save team" : "Create team"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The existing workspace card, for a workspace shared with a team.
export function TeamWorkspaceCard({ item, team, open }: { item: TeamWorkspace; team: string; open: (id: string) => void }) {
  return (
    <article className="workspace-card" aria-label={item.name}>
      <div className="workspace-card-top">
        <span className="workspace-card-icon">
          <Users size={19} />
        </span>
      </div>
      <h3>{item.name}</h3>
      <p className="workspace-description">{item.description || "Lessons, files and code examples."}</p>
      <div className="workspace-card-counts">
        <span className={"role-badge " + item.role}>{item.role === "editor" ? "Editor" : "Viewer"}</span>
        <span className="card-badge team" title={`Shared with ${team}`}>
          <Users size={11} /> Team
        </span>
        {item.ownerName && <> Shared by {item.ownerName}</>}
      </div>
      <div className="workspace-card-bottom">
        <span>Updated {relativeTime(item.updatedAt)}</span>
        <button className="text-button" onClick={() => open(item.id)}>
          Open <ArrowRight size={15} />
        </button>
      </div>
    </article>
  );
}

function TeamView({
  id,
  notify,
  open,
  onBack,
  onChanged,
}: {
  id: string;
  notify: (message: string) => void;
  open: (id: string) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<TeamWorkspace[] | null>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState(""), [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editing, setEditing] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  async function load() {
    try {
      const [detail, shared] = await Promise.all([
        api<TeamDetail>(`/teams/${id}`),
        api<{ workspaces: TeamWorkspace[] }>(`/teams/${id}/workspaces`),
      ]);
      setTeam(detail);
      setWorkspaces(shared.workspaces);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  if (error)
    return (
      <div>
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={15} /> My Teams
        </button>
        <p className="error" role="alert">
          {error}
        </p>
      </div>
    );
  if (!team)
    return (
      <p className="dashboard-empty">
        <Loader2 size={20} className="spin" /> Loading team…
      </p>
    );
  const owner = team.role === "owner", managing = owner || team.role === "admin";
  const apply = async (run: () => Promise<TeamDetail | { ok: boolean }>, message: string) => {
    await run();
    notify(message);
    await load();
    onChanged();
  };
  const canRemove = (member: TeamMember) =>
    !member.you && member.role !== "owner" && (owner || (team.role === "admin" && member.role === "member"));
  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      setTeam(await api<TeamDetail>(`/teams/${id}/invitations`, "POST", { email: email.trim(), role }));
      setEmail("");
      notify("Invitation sent");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const others = team.members.filter((m) => !m.you);
  return (
    <div className="team-view">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={15} /> My Teams
      </button>
      <div className="dashboard-heading team-heading">
        <div>
          <h2>{team.name}</h2>
          <p>
            {team.description || "No description."} · {team.memberCount} member{team.memberCount === 1 ? "" : "s"} ·{" "}
            {owner ? "You own this team" : team.role === "admin" ? "You're an Admin" : "You're a Member"}
          </p>
        </div>
        <div className="team-actions">
          {managing && (
            <button className="button secondary" onClick={() => setEditing(true)}>
              <Pencil size={15} /> Rename
            </button>
          )}
          {!owner && (
            <button
              className="button secondary"
              onClick={() =>
                setConfirm({
                  title: "Leave team?",
                  text: `You lose access to the workspaces shared with “${team.name}” right away, unless you have another way in.`,
                  action: "Leave team",
                  danger: true,
                  run: async () => {
                    await api(`/teams/${id}/leave`, "POST", {});
                    notify("You left the team");
                    onChanged();
                    onBack();
                  },
                })
              }
            >
              <LogOut size={15} /> Leave
            </button>
          )}
          {owner && (
            <button
              className="button danger"
              onClick={() =>
                setConfirm({
                  title: "Delete team?",
                  text: `“${team.name}” is deleted for everyone. Its members lose access to the workspaces shared with it right away. The workspaces themselves are not deleted.`,
                  action: "Delete team",
                  danger: true,
                  typed: team.name,
                  run: async () => {
                    await api(`/teams/${id}`, "DELETE");
                    notify("Team deleted");
                    onChanged();
                    onBack();
                  },
                })
              }
            >
              <Trash2 size={15} /> Delete
            </button>
          )}
        </div>
      </div>

      <section className="team-section" aria-label="Members">
        <h3>
          <Users size={16} /> Members
        </h3>
        <ul className="people-list team-members">
          {team.members.map((member) => (
            <li key={member.userId}>
              <span>
                <strong>
                  {member.displayName}
                  {member.you && " (you)"}
                </strong>
                {member.email && <small>{member.email}</small>}
              </span>
              {owner && member.role !== "owner" ? (
                <select
                  aria-label={`Role for ${member.displayName}`}
                  value={member.role}
                  onChange={(e) =>
                    void apply(() => api(`/teams/${id}/members/${member.userId}`, "PATCH", { role: e.target.value }), "Role updated").catch((err) => notify((err as Error).message))
                  }
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <span className={"team-role " + member.role}>
                  {member.role === "owner" && <Crown size={12} />} {teamRoleLabel(member.role)}
                </span>
              )}
              {canRemove(member) && (
                <button
                  className="icon-button"
                  aria-label={`Remove ${member.displayName}`}
                  title="Remove from team"
                  onClick={() =>
                    setConfirm({
                      title: "Remove from team?",
                      text: `${member.displayName} loses access to the workspaces shared with “${team.name}” right away, unless they have another way in.`,
                      action: "Remove",
                      danger: true,
                      run: () => apply(() => api(`/teams/${id}/members/${member.userId}`, "DELETE"), "Removed from the team"),
                    })
                  }
                >
                  <X size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {owner && others.length > 0 && (
          <div className="team-transfer">
            <label className="field">
              Transfer ownership
              <select aria-label="New owner" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                <option value="">Choose a member…</option>
                {others.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={!transferTo}
              onClick={() => {
                const next = others.find((m) => m.userId === transferTo)!;
                setConfirm({
                  title: "Transfer ownership?",
                  text: `${next.displayName} becomes the owner of “${team.name}”. You stay in the team as an Admin and can then leave it.`,
                  action: "Transfer ownership",
                  run: async () => {
                    await apply(() => api(`/teams/${id}/transfer`, "POST", { userId: next.userId }), "Ownership transferred");
                    setTransferTo("");
                  },
                });
              }}
            >
              <Crown size={15} /> Transfer
            </button>
          </div>
        )}
        {owner && others.length === 0 && <p className="fine-print">Invite someone before you can transfer ownership or leave.</p>}
      </section>

      {managing && (
        <section className="team-section" aria-label="Invite people">
          <h3>
            <UserPlus size={16} /> Invite people
          </h3>
          <p className="fine-print">Invite someone who already has a Kodelumi account. They accept or decline from My Teams.</p>
          <form className="people-add" onSubmit={(e) => void invite(e)}>
            <input type="email" required aria-label="Email address" placeholder="name@example.com" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            <select aria-label="Team role" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              {owner && <option value="admin">Admin</option>}
            </select>
            <button className="button primary" disabled={busy || !email.trim()}>
              {busy && <Loader2 size={15} className="spin" />} Invite
            </button>
          </form>
          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}
          {!!team.invitations?.length && (
            <ul className="people-list" aria-label="Pending invitations">
              {team.invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span>
                    <strong>{invitation.displayName}</strong>
                    <small>
                      {invitation.email} · Invited as {teamRoleLabel(invitation.role)}
                    </small>
                  </span>
                  <span className="team-role pending">Pending</span>
                  {(owner || invitation.role === "member") && (
                    <button
                      className="icon-button"
                      aria-label={`Cancel invitation for ${invitation.displayName}`}
                      title="Cancel invitation"
                      onClick={() => void apply(() => api(`/teams/${id}/invitations/${invitation.id}`, "DELETE"), "Invitation cancelled").catch((err) => notify((err as Error).message))}
                    >
                      <X size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="team-section" aria-label="Shared with this team">
        <h3>Shared with this team</h3>
        {!workspaces ? null : !workspaces.length ? (
          <p className="fine-print">No workspaces are shared with this team yet. Workspace owners share from a workspace’s Share button.</p>
        ) : (
          <div className="workspace-grid">
            {workspaces.map((item) => (
              <TeamWorkspaceCard key={item.id} item={item} team={team.name} open={open} />
            ))}
          </div>
        )}
      </section>

      {editing && (
        <TeamForm
          title="Rename team"
          initial={{ name: team.name, description: team.description }}
          submit={(value) => apply(() => api(`/teams/${id}`, "PATCH", value), "Team updated")}
          onClose={() => setEditing(false)}
        />
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

export function MyTeams({
  team,
  onSelect,
  notify,
  open,
  onInvitations,
}: {
  team: string | null;
  onSelect: (id: string | null) => void;
  notify: (message: string) => void;
  open: (id: string) => void;
  onInvitations: (count: number) => void;
}) {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [invitations, setInvitations] = useState<MyInvitation[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  async function load() {
    try {
      const [mine, pending] = await Promise.all([
        api<{ teams: TeamSummary[] }>("/teams"),
        api<{ invitations: MyInvitation[] }>("/me/invitations"),
      ]);
      setTeams(mine.teams);
      setInvitations(pending.invitations);
      onInvitations(pending.invitations.length);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function answer(invitation: MyInvitation, accept: boolean) {
    setAnswering(invitation.id);
    try {
      await api(`/me/invitations/${invitation.id}/${accept ? "accept" : "decline"}`, "POST", {});
      notify(accept ? `You joined ${invitation.teamName}` : "Invitation declined");
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setAnswering(null);
    }
  }
  if (team) return <TeamView id={team} notify={notify} open={open} onBack={() => onSelect(null)} onChanged={() => void load()} />;
  return (
    <section className="my-teams" aria-label="My Teams">
      <div className="dashboard-heading">
        <div>
          <h2>My Teams</h2>
          <p>Teams you belong to. Share a workspace with a team to collaborate with everyone in it.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Create Team
        </button>
      </div>
      {!!invitations.length && (
        <section className="team-invitations" aria-label="Invitations">
          <h3>Invitations</h3>
          {invitations.map((invitation) => (
            <div className="team-invitation" key={invitation.id}>
              <Users size={18} />
              <span>
                <strong>{invitation.teamName}</strong>
                <small>
                  {invitation.invitedBy ? `${invitation.invitedBy} invited you` : "You're invited"} as {teamRoleLabel(invitation.role)}
                </small>
              </span>
              <button className="button secondary" disabled={answering === invitation.id} onClick={() => void answer(invitation, false)}>
                Decline
              </button>
              <button className="button primary" disabled={answering === invitation.id} onClick={() => void answer(invitation, true)}>
                {answering === invitation.id ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Accept
              </button>
            </div>
          ))}
        </section>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : !teams ? (
        <p className="dashboard-empty">
          <Loader2 size={20} className="spin" /> Loading your teams…
        </p>
      ) : !teams.length ? (
        <div className="dashboard-empty">
          <Users size={30} />
          <h3>No teams yet.</h3>
          <p>Create a team to share workspaces with a group of people at once.</p>
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Create Team
          </button>
        </div>
      ) : (
        <div className="workspace-grid">
          {teams.map((item) => (
            <article className="workspace-card" key={item.id} aria-label={item.name}>
              <div className="workspace-card-top">
                <span className="workspace-card-icon">
                  <Users size={19} />
                </span>
                <span className={"team-role " + item.role}>
                  {item.role === "owner" && <Crown size={12} />} {teamRoleLabel(item.role as TeamRole)}
                </span>
              </div>
              <h3>{item.name}</h3>
              <p className="workspace-description">{item.description || "A team for sharing workspaces."}</p>
              <div className="workspace-card-counts">
                <Users size={14} /> {item.memberCount} member{item.memberCount === 1 ? "" : "s"}
              </div>
              <div className="workspace-card-bottom">
                <span>Updated {relativeTime(item.updatedAt)}</span>
                <button className="text-button" onClick={() => onSelect(item.id)}>
                  Open <ArrowRight size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {creating && (
        <TeamForm
          title="Create Team"
          submit={async (value) => {
            const created = await api<TeamDetail>("/teams", "POST", value);
            notify("Team created");
            await load();
            onSelect(created.id);
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}

export function TeamWorkspaces({ open }: { open: (id: string) => void }) {
  const [groups, setGroups] = useState<Array<{ team: TeamSummary; workspaces: TeamWorkspace[] }> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const { teams } = await api<{ teams: TeamSummary[] }>("/teams");
        setGroups(
          await Promise.all(
            teams.map(async (team) => ({ team, workspaces: (await api<{ workspaces: TeamWorkspace[] }>(`/teams/${team.id}/workspaces`)).workspaces })),
          ),
        );
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);
  const withWorkspaces = (groups ?? []).filter((g) => g.workspaces.length);
  return (
    <section className="team-workspaces" aria-label="Team Workspaces">
      <div className="dashboard-heading">
        <div>
          <h2>Team Workspaces</h2>
          <p>Workspaces shared with your teams.</p>
        </div>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : !groups ? (
        <p className="dashboard-empty">
          <Loader2 size={20} className="spin" /> Loading team workspaces…
        </p>
      ) : !withWorkspaces.length ? (
        <p className="dashboard-empty">
          {groups.length
            ? "No workspaces are shared with your teams yet."
            : "You're not in a team yet. Create one or accept an invitation in My Teams."}
        </p>
      ) : (
        withWorkspaces.map(({ team, workspaces }) => (
          <section className="team-section" key={team.id} aria-label={team.name}>
            <h3>
              <Users size={16} /> {team.name}
            </h3>
            <div className="workspace-grid">
              {workspaces.map((item) => (
                <TeamWorkspaceCard key={item.id} item={item} team={team.name} open={open} />
              ))}
            </div>
          </section>
        ))
      )}
    </section>
  );
}
