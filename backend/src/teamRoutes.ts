import type express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validEmail, type Session } from "./auth.js";

// Teams: an owner, admins and members. Membership on its own grants no access to any
// workspace; workspaces are shared with a team explicitly (a later phase). Every route
// re-reads the caller's role from the database, so a removed or demoted member loses
// rights at once. Non-members get 404 for everything about a team, so team names and IDs
// are never revealed to them.
export type TeamRole = "owner" | "admin" | "member";
const ID = /^[0-9a-f-]{36}$/;
const MAX_MEMBERS = 200, MAX_PENDING = 200, MAX_TEAMS_PER_USER = 100;

const teamName = (value: unknown) => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 80) throw new Error("Team names must be 1–80 characters.");
  return name;
};
const teamDescription = (value: unknown) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 400)
    throw new Error("Descriptions must be at most 400 characters.");
  return value.trim();
};
const limiter = (windowMs: number, limit: number, error: string) =>
  rateLimit({ windowMs, limit, standardHeaders: "draft-8", legacyHeaders: false, message: { error } });

export function teamRoutes(
  app: express.Express,
  db: DatabaseSync,
  // Re-checks one workspace's live sessions after team-derived access may have changed.
  revalidate: (workspaceId: string) => void,
) {
  const one = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).get(...params);
  const count = (sql: string, ...params: string[]) => Number(db.prepare(sql).get(...params)?.n);
  const roleIn = (teamId: string, userId: string) =>
    one("SELECT role FROM team_members WHERE team_id=? AND user_id=?", teamId, userId)?.role as TeamRole | undefined;
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const session = (res: express.Response) => res.locals.session as Session;
  const requireSession: express.RequestHandler = (_req, res, next) => {
    if (!res.locals.session) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    next();
  };
  // Resolves the team and the caller's role; anyone who isn't a member gets a 404.
  const member: express.RequestHandler = (req, res, next) => {
    const teamId = String(req.params.teamId);
    const role = ID.test(teamId) ? roleIn(teamId, session(res).user.id) : undefined;
    if (!role) {
      res.status(404).json({ error: "Team not found." });
      return;
    }
    res.locals.teamId = teamId;
    res.locals.teamRole = role;
    next();
  };
  const allow = (res: express.Response, roles: TeamRole[], error: string) => {
    if (roles.includes(res.locals.teamRole)) return true;
    res.status(403).json({ error });
    return false;
  };
  const summary = (teamId: string, userId: string) => {
    const team = one("SELECT id,name,description,created_at,updated_at FROM teams WHERE id=?", teamId)!;
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
      role: roleIn(teamId, userId),
      memberCount: count("SELECT COUNT(*) AS n FROM team_members WHERE team_id=?", teamId),
    };
  };
  // Members see names and roles; owners and admins also see emails and pending invitations.
  const detail = (teamId: string, userId: string) => {
    const base = summary(teamId, userId);
    const managing = base.role === "owner" || base.role === "admin";
    const members = db
      .prepare(
        "SELECT m.user_id AS userId,u.display_name AS displayName,u.email,m.role,m.created_at AS joinedAt FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE",
      )
      .all(teamId)
      .map(({ email, ...rest }) => ({ ...rest, ...(managing ? { email } : {}), you: rest.userId === userId }));
    return {
      ...base,
      members,
      ...(managing
        ? {
            invitations: db
              .prepare(
                "SELECT i.id,i.user_id AS userId,u.display_name AS displayName,u.email,i.role,i.created_at AS invitedAt,b.display_name AS invitedBy FROM team_invitations i JOIN users u ON u.id=i.user_id LEFT JOIN users b ON b.id=i.invited_by WHERE i.team_id=? ORDER BY i.created_at",
              )
              .all(teamId),
          }
        : {}),
    };
  };
  // Workspaces shared with a team: their live sessions are re-checked whenever membership
  // changes, so a removed member is disconnected and a new member reconnects with access.
  const sharedWorkspaces = (teamId: string) =>
    (db.prepare("SELECT workspace_id FROM workspace_team_shares WHERE team_id=?").all(teamId) as { workspace_id: string }[]).map((r) => r.workspace_id);
  const membershipChanged = (workspaceIds: string[]) => workspaceIds.forEach(revalidate);
  const membershipLimit = (userId: string) => {
    if (count("SELECT COUNT(*) AS n FROM team_members WHERE user_id=?", userId) >= MAX_TEAMS_PER_USER)
      throw new Error(`An account can belong to up to ${MAX_TEAMS_PER_USER} teams.`);
  };

  app.get("/api/teams", requireSession, (_req, res) => {
    const userId = session(res).user.id;
    res.json({
      teams: (db
        .prepare("SELECT t.id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=? ORDER BY t.name COLLATE NOCASE")
        .all(userId) as { id: string }[]).map(({ id }) => summary(id, userId)),
    });
  });
  app.post(
    "/api/teams",
    requireSession,
    limiter(10 * 60_000, 20, "Too many new teams. Wait a few minutes and try again."),
    (req, res) => {
      const user = session(res).user;
      const name = teamName(req.body?.name), description = teamDescription(req.body?.description);
      membershipLimit(user.id);
      const id = randomUUID(), now = Date.now();
      transaction(() => {
        db.prepare("INSERT INTO teams (id,name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, name, description, user.id, now, now);
        db.prepare("INSERT INTO team_members (team_id,user_id,role,created_at,updated_at) VALUES (?,?,'owner',?,?)").run(id, user.id, now, now);
      });
      res.status(201).json(detail(id, user.id));
    },
  );
  app.use("/api/teams/:teamId", requireSession, member);
  app.get("/api/teams/:teamId", (_req, res) => {
    res.json(detail(res.locals.teamId, session(res).user.id));
  });
  app.patch("/api/teams/:teamId", (req, res) => {
    if (!allow(res, ["owner", "admin"], "Only the team owner and admins can rename this team.")) return;
    const current = one("SELECT name,description FROM teams WHERE id=?", res.locals.teamId)!;
    const name = req.body?.name === undefined ? (current.name as string) : teamName(req.body.name);
    const description = req.body?.description === undefined ? (current.description as string) : teamDescription(req.body.description);
    db.prepare("UPDATE teams SET name=?,description=?,updated_at=? WHERE id=?").run(name, description, Date.now(), res.locals.teamId);
    res.json(detail(res.locals.teamId, session(res).user.id));
  });
  app.delete("/api/teams/:teamId", (_req, res) => {
    if (!allow(res, ["owner"], "Only the team owner can delete this team.")) return;
    // Members, invitations and the team's workspace shares go with it (ON DELETE CASCADE);
    // the shared workspaces are read first so their sessions can be re-checked.
    const workspaces = sharedWorkspaces(res.locals.teamId);
    db.prepare("DELETE FROM teams WHERE id=?").run(res.locals.teamId);
    membershipChanged(workspaces);
    res.json({ ok: true });
  });

  // Workspaces shared with this team, for its members (never the members' other workspaces).
  app.get("/api/teams/:teamId/workspaces", (_req, res) => {
    res.json({
      workspaces: db
        .prepare(
          "SELECT r.id,r.name,r.description,r.updated_at AS updatedAt,s.role,s.created_at AS sharedAt,u.display_name AS ownerName FROM workspace_team_shares s JOIN rooms r ON r.id=s.workspace_id LEFT JOIN users u ON u.id=r.owner_id WHERE s.team_id=? ORDER BY r.updated_at DESC",
        )
        .all(res.locals.teamId),
    });
  });
  // Invitations: existing accounts only. Admins invite Members; the owner also invites Admins.
  app.post(
    "/api/teams/:teamId/invitations",
    limiter(10 * 60_000, 60, "Too many invitations. Wait a few minutes and try again."),
    (req, res) => {
      if (!allow(res, ["owner", "admin"], "Only the team owner and admins can invite people.")) return;
      const teamId = res.locals.teamId as string, inviter = session(res).user;
      const role = req.body?.role ?? "member";
      if (role !== "member" && role !== "admin") throw new Error("Choose Member or Admin.");
      if (role === "admin" && res.locals.teamRole !== "owner") {
        res.status(403).json({ error: "Only the team owner can invite admins." });
        return;
      }
      const email = validEmail(req.body?.email);
      const user = one("SELECT id,display_name FROM users WHERE email=?", email);
      if (!user) {
        res.status(404).json({ error: "No Kodelumi account uses that email. Ask them to create an account first." });
        return;
      }
      if (roleIn(teamId, user.id as string)) {
        res.status(400).json({ error: user.id === inviter.id ? "You're already in this team." : "That person is already in this team." });
        return;
      }
      if (count("SELECT COUNT(*) AS n FROM team_members WHERE team_id=?", teamId) >= MAX_MEMBERS)
        throw new Error(`A team can have up to ${MAX_MEMBERS} members.`);
      const existing = one("SELECT id FROM team_invitations WHERE team_id=? AND user_id=?", teamId, user.id as string);
      if (!existing && count("SELECT COUNT(*) AS n FROM team_invitations WHERE team_id=?", teamId) >= MAX_PENDING)
        throw new Error(`A team can have up to ${MAX_PENDING} pending invitations.`);
      // Inviting again refreshes the pending invitation (and its role) rather than duplicating it.
      db.prepare(
        "INSERT INTO team_invitations (id,team_id,user_id,role,invited_by,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role,invited_by=excluded.invited_by,created_at=excluded.created_at",
      ).run(randomUUID(), teamId, user.id as string, role, inviter.id, Date.now());
      res.status(existing ? 200 : 201).json(detail(teamId, inviter.id));
    },
  );
  app.delete("/api/teams/:teamId/invitations/:invitationId", (req, res) => {
    if (!allow(res, ["owner", "admin"], "Only the team owner and admins can cancel invitations.")) return;
    const invitation = one("SELECT role FROM team_invitations WHERE id=? AND team_id=?", String(req.params.invitationId), res.locals.teamId);
    if (!invitation) {
      res.status(404).json({ error: "That invitation no longer exists." });
      return;
    }
    if (invitation.role === "admin" && res.locals.teamRole !== "owner") {
      res.status(403).json({ error: "Only the team owner can cancel an admin invitation." });
      return;
    }
    db.prepare("DELETE FROM team_invitations WHERE id=?").run(String(req.params.invitationId));
    res.json(detail(res.locals.teamId, session(res).user.id));
  });

  // Members: the owner changes roles and removes anyone else; admins remove Members only.
  app.patch("/api/teams/:teamId/members/:userId", (req, res) => {
    if (!allow(res, ["owner"], "Only the team owner can change roles.")) return;
    const teamId = res.locals.teamId as string, target = String(req.params.userId);
    const role = req.body?.role;
    if (role !== "member" && role !== "admin") throw new Error("Choose Member or Admin. Use Transfer ownership to make someone the owner.");
    const current = roleIn(teamId, target);
    if (!current) {
      res.status(404).json({ error: "That person is not in this team." });
      return;
    }
    if (current === "owner") {
      res.status(400).json({ error: "Transfer ownership to change the owner's role." });
      return;
    }
    db.prepare("UPDATE team_members SET role=?,updated_at=? WHERE team_id=? AND user_id=?").run(role, Date.now(), teamId, target);
    res.json(detail(teamId, session(res).user.id));
  });
  app.delete("/api/teams/:teamId/members/:userId", (req, res) => {
    const teamId = res.locals.teamId as string, target = String(req.params.userId), me = session(res).user.id;
    if (target === me) {
      res.status(400).json({ error: "Use Leave team to remove yourself." });
      return;
    }
    const current = roleIn(teamId, target);
    if (!current) {
      res.status(404).json({ error: "That person is not in this team." });
      return;
    }
    const mine = res.locals.teamRole as TeamRole;
    if (current === "owner" || mine === "member" || (mine === "admin" && current !== "member")) {
      res.status(403).json({
        error: current === "owner" ? "The team owner can't be removed." : mine === "admin" ? "Admins can remove Members only." : "Only the team owner and admins can remove people.",
      });
      return;
    }
    db.prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").run(teamId, target);
    membershipChanged(sharedWorkspaces(teamId));
    res.json(detail(teamId, me));
  });
  app.post("/api/teams/:teamId/leave", (_req, res) => {
    if (res.locals.teamRole === "owner") {
      res.status(409).json({ error: "Transfer ownership to another member before leaving, or delete the team." });
      return;
    }
    db.prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").run(res.locals.teamId, session(res).user.id);
    membershipChanged(sharedWorkspaces(res.locals.teamId));
    res.json({ ok: true });
  });
  // The owner hands the team to an existing member and stays on as an admin.
  app.post("/api/teams/:teamId/transfer", (req, res) => {
    if (!allow(res, ["owner"], "Only the team owner can transfer ownership.")) return;
    const teamId = res.locals.teamId as string, me = session(res).user.id, target = String(req.body?.userId ?? "");
    if (target === me) throw new Error("You already own this team.");
    if (!roleIn(teamId, target)) {
      res.status(404).json({ error: "Choose someone who is already in this team." });
      return;
    }
    const now = Date.now();
    transaction(() => {
      // Demote first: the one-owner index never sees two owners, even briefly.
      db.prepare("UPDATE team_members SET role='admin',updated_at=? WHERE team_id=? AND user_id=? AND role='owner'").run(now, teamId, me);
      db.prepare("UPDATE team_members SET role='owner',updated_at=? WHERE team_id=? AND user_id=?").run(now, teamId, target);
    });
    res.json(detail(teamId, me));
  });

  // The signed-in user's own pending invitations.
  const myInvitation = (req: express.Request, res: express.Response) => {
    const id = String(req.params.invitationId);
    const invitation = ID.test(id) ? one("SELECT id,team_id,role FROM team_invitations WHERE id=? AND user_id=?", id, session(res).user.id) : undefined;
    if (!invitation) res.status(404).json({ error: "That invitation no longer exists." });
    return invitation;
  };
  app.get("/api/me/invitations", requireSession, (_req, res) => {
    res.json({
      invitations: db
        .prepare(
          "SELECT i.id,i.team_id AS teamId,t.name AS teamName,t.description AS teamDescription,i.role,i.created_at AS invitedAt,b.display_name AS invitedBy FROM team_invitations i JOIN teams t ON t.id=i.team_id LEFT JOIN users b ON b.id=i.invited_by WHERE i.user_id=? ORDER BY i.created_at DESC",
        )
        .all(session(res).user.id),
    });
  });
  app.post("/api/me/invitations/:invitationId/accept", requireSession, (req, res) => {
    const invitation = myInvitation(req, res);
    if (!invitation) return;
    const me = session(res).user.id, teamId = invitation.team_id as string;
    membershipLimit(me);
    if (count("SELECT COUNT(*) AS n FROM team_members WHERE team_id=?", teamId) >= MAX_MEMBERS)
      throw new Error(`This team already has ${MAX_MEMBERS} members.`);
    const now = Date.now();
    transaction(() => {
      db.prepare("INSERT INTO team_members (team_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(team_id,user_id) DO NOTHING").run(teamId, me, invitation.role as string, now, now);
      db.prepare("DELETE FROM team_invitations WHERE id=?").run(invitation.id as string);
    });
    // A new member's open sessions (e.g. as a link viewer) reconnect with the team's role.
    membershipChanged(sharedWorkspaces(teamId));
    res.json(detail(teamId, me));
  });
  app.post("/api/me/invitations/:invitationId/decline", requireSession, (req, res) => {
    const invitation = myInvitation(req, res);
    if (!invitation) return;
    db.prepare("DELETE FROM team_invitations WHERE id=?").run(invitation.id as string);
    res.json({ ok: true });
  });
}
