import type { DatabaseSync } from "node:sqlite";
import { isShareRole, type ShareRole } from "./access.js";

const httpError = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });

type Person = { userId: string; displayName: string; email: string; role: ShareRole; createdAt: number };
type TeamGrant = { teamId: string; name: string; role: ShareRole; memberCount: number; createdAt: number };
// Where an inherited folder grant comes from: a share on one of the folder's parent folders.
type From = { folderId: string; name: string };

// Folder shares with accounts and teams. Each change re-checks the workspace's live sessions
// (onChange), so a revoked folder closes at once while sessions that keep the same rights
// through another grant stay connected. Who may share is decided by the REST layer (app.ts);
// the rules every folder share must follow live here and in database triggers.
export class FolderSharing {
  constructor(
    private db: DatabaseSync,
    private onChange: (workspaceId: string) => void,
  ) {}
  hasShares(workspaceId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM folder_shares WHERE workspace_id=? UNION ALL SELECT 1 FROM folder_team_shares WHERE workspace_id=? LIMIT 1",
      )
      .get(workspaceId, workspaceId);
  }
  // The folder must belong to the workspace, and the workspace must be Restricted: under
  // "Anyone with the link" a folder share would be meaningless (everything is open).
  private check(workspaceId: string, folderId: string, role: unknown): asserts role is ShareRole {
    if (!isShareRole(role)) throw httpError("Choose Viewer or Editor.", 400);
    const row = this.folder(workspaceId, folderId);
    if (row.visibility !== "private")
      throw httpError("Folders can be shared on their own only in Restricted workspaces.", 409);
  }
  private folder(workspaceId: string, folderId: string) {
    const row = this.db
      .prepare("SELECT f.name, r.visibility FROM folders f JOIN rooms r ON r.id=f.workspace_id WHERE f.id=? AND f.workspace_id=?")
      .get(folderId, workspaceId);
    if (!row) throw httpError("Folder not found.", 404);
    return row as { name: string; visibility: string };
  }
  // The folder's parents, nearest first (a folder is at most 12 levels deep).
  private ancestors(workspaceId: string, folderId: string): From[] {
    return (
      this.db
        .prepare(
          `WITH RECURSIVE chain(id, parent_id, depth) AS (
             SELECT id, parent_id, 0 FROM folders WHERE id=? AND workspace_id=?
             UNION ALL SELECT f.id, f.parent_id, c.depth+1 FROM folders f JOIN chain c ON f.id=c.parent_id
           )
           SELECT c.id AS folderId, f.name FROM chain c JOIN folders f ON f.id=c.id WHERE c.depth>0 ORDER BY c.depth`,
        )
        .all(folderId, workspaceId) as From[]
    );
  }
  private people(folderId: string) {
    return this.db
      .prepare(
        "SELECT s.user_id AS userId,u.display_name AS displayName,u.email,s.role,s.created_at AS createdAt FROM folder_shares s JOIN users u ON u.id=s.user_id WHERE s.folder_id=? ORDER BY s.created_at,u.display_name",
      )
      .all(folderId) as Person[];
  }
  private teams(folderId: string) {
    return this.db
      .prepare(
        "SELECT s.team_id AS teamId,t.name,s.role,s.created_at AS createdAt,(SELECT COUNT(*) FROM team_members m WHERE m.team_id=s.team_id) AS memberCount FROM folder_team_shares s JOIN teams t ON t.id=s.team_id WHERE s.folder_id=? ORDER BY t.name COLLATE NOCASE",
      )
      .all(folderId) as TeamGrant[];
  }
  // A folder's sharing as its managers see it: the folder's own (direct) shares, which can be
  // changed here, and those inherited from parent folders, which can only be changed on the
  // folder that holds them. Workspace-wide access (owner, workspace and team shares) is listed
  // by the workspace's own sharing endpoints.
  list(workspaceId: string, folderId: string) {
    const folder = this.folder(workspaceId, folderId);
    const inherited = this.ancestors(workspaceId, folderId).flatMap((from) => [
      ...this.people(from.folderId).map((p) => ({ ...p, from })),
      ...this.teams(from.folderId).map((t) => ({ ...t, from })),
    ]);
    return {
      folder: { id: folderId, name: folder.name },
      direct: { people: this.people(folderId), teams: this.teams(folderId) },
      inherited: {
        people: inherited.filter((g): g is Person & { from: From } => "userId" in g),
        teams: inherited.filter((g): g is TeamGrant & { from: From } => "teamId" in g),
      },
    };
  }
  // Every folder of the workspace that is shared on its own, with its direct shares.
  overview(workspaceId: string) {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT f.id, f.name, f.parent_id AS parentId FROM folders f
           WHERE f.workspace_id=? AND (EXISTS (SELECT 1 FROM folder_shares s WHERE s.folder_id=f.id)
             OR EXISTS (SELECT 1 FROM folder_team_shares s WHERE s.folder_id=f.id))
           ORDER BY f.name COLLATE NOCASE, f.id`,
        )
        .all(workspaceId) as { id: string; name: string; parentId: string | null }[]
    ).map((f) => ({ ...f, people: this.people(f.id), teams: this.teams(f.id) }));
  }
  // The nearest parent folder whose share covers this person or team, if any.
  private inheritedFrom(workspaceId: string, folderId: string, who: { userId: string } | { teamId: string }) {
    const sql =
      "userId" in who
        ? "SELECT 1 FROM folder_shares WHERE folder_id=? AND user_id=?"
        : "SELECT 1 FROM folder_team_shares WHERE folder_id=? AND team_id=?";
    const id = "userId" in who ? who.userId : who.teamId;
    return this.ancestors(workspaceId, folderId).find((from) => this.db.prepare(sql).get(from.folderId, id));
  }
  // An update or removal of a share the folder doesn't hold itself: inherited ones are refused
  // with where they come from; a share that doesn't exist anywhere is a plain 404.
  private missing(workspaceId: string, folderId: string, who: { userId: string } | { teamId: string }): never {
    const from = this.inheritedFrom(workspaceId, folderId, who);
    if (from)
      throw httpError(
        `This access comes from the parent folder "${from.name}". Change or remove it there.`,
        409,
        { inheritedFrom: from },
      );
    throw httpError("userId" in who ? "That person has no access to this folder." : "That team has no access to this folder.", 404);
  }
  shareWithUser(workspaceId: string, folderId: string, userId: string, role: ShareRole, by: string | null) {
    this.check(workspaceId, folderId, role);
    if (this.db.prepare("SELECT 1 FROM rooms WHERE id=? AND owner_id=?").get(workspaceId, userId))
      throw httpError("The workspace owner already has full access.", 400);
    if (by && userId === by) throw httpError("You can't share a folder with yourself.", 400);
    const now = Date.now();
    const existed = !!this.db.prepare("SELECT 1 FROM folder_shares WHERE folder_id=? AND user_id=?").get(folderId, userId);
    this.db
      .prepare(
        "INSERT INTO folder_shares (folder_id,workspace_id,user_id,role,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(folder_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at",
      )
      .run(folderId, workspaceId, userId, role, by, now, now);
    this.onChange(workspaceId);
    return existed;
  }
  updateUser(workspaceId: string, folderId: string, userId: string, role: unknown) {
    this.check(workspaceId, folderId, role);
    const changed = this.db
      .prepare("UPDATE folder_shares SET role=?,updated_at=? WHERE folder_id=? AND workspace_id=? AND user_id=?")
      .run(role, Date.now(), folderId, workspaceId, userId).changes;
    if (!changed) this.missing(workspaceId, folderId, { userId });
    this.onChange(workspaceId);
  }
  unshareUser(workspaceId: string, folderId: string, userId: string) {
    const removed = this.db
      .prepare("DELETE FROM folder_shares WHERE folder_id=? AND workspace_id=? AND user_id=?")
      .run(folderId, workspaceId, userId).changes;
    if (removed) this.onChange(workspaceId);
    return removed > 0;
  }
  // Removes a direct share; an inherited one is refused (see missing()).
  revokeUser(workspaceId: string, folderId: string, userId: string) {
    this.folder(workspaceId, folderId);
    if (!this.unshareUser(workspaceId, folderId, userId)) this.missing(workspaceId, folderId, { userId });
  }
  shareWithTeam(workspaceId: string, folderId: string, teamId: string, role: ShareRole, by: string | null) {
    this.check(workspaceId, folderId, role);
    if (!this.db.prepare("SELECT 1 FROM teams WHERE id=?").get(teamId)) throw httpError("Team not found.", 404);
    const now = Date.now();
    const existed = !!this.db.prepare("SELECT 1 FROM folder_team_shares WHERE folder_id=? AND team_id=?").get(folderId, teamId);
    this.db
      .prepare(
        "INSERT INTO folder_team_shares (folder_id,workspace_id,team_id,role,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(folder_id,team_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at",
      )
      .run(folderId, workspaceId, teamId, role, by, now, now);
    this.onChange(workspaceId);
    return existed;
  }
  updateTeam(workspaceId: string, folderId: string, teamId: string, role: unknown) {
    this.check(workspaceId, folderId, role);
    const changed = this.db
      .prepare("UPDATE folder_team_shares SET role=?,updated_at=? WHERE folder_id=? AND workspace_id=? AND team_id=?")
      .run(role, Date.now(), folderId, workspaceId, teamId).changes;
    if (!changed) this.missing(workspaceId, folderId, { teamId });
    this.onChange(workspaceId);
  }
  unshareTeam(workspaceId: string, folderId: string, teamId: string) {
    const removed = this.db
      .prepare("DELETE FROM folder_team_shares WHERE folder_id=? AND workspace_id=? AND team_id=?")
      .run(folderId, workspaceId, teamId).changes;
    if (removed) this.onChange(workspaceId);
    return removed > 0;
  }
  revokeTeam(workspaceId: string, folderId: string, teamId: string) {
    this.folder(workspaceId, folderId);
    if (!this.unshareTeam(workspaceId, folderId, teamId)) this.missing(workspaceId, folderId, { teamId });
  }
}
