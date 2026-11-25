import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Content locks: a workspace, a folder (with everything inside it) or a single file can be
// locked, so people who would otherwise see it can't open it until it is released. Locks only
// ever take access away; they never grant any. The workspace owner, and accounts the owner
// delegates to (lock_permissions), keep full access to locked content within their scope, and
// still only with the rights their sharing gives them.
//
// Rules:
// - Locks are independent rows. A locked parent restricts everything inside it, so unlocking a
//   child never bypasses a locked parent, and unlocking a parent (or the workspace) leaves
//   individually locked children locked.
// - "visible": people see the name, a padlock and any release date. "hidden": the item (and
//   everything inside it) is left out of every response as if it didn't exist.
// - A scheduled release removes that one lock at the configured instant (see releaseDue). It
//   never touches other locks and never changes sharing.
export type LockKind = "workspace" | "folder" | "file";
export type LockVisibility = "visible" | "hidden";
export const isLockKind = (value: unknown): value is LockKind =>
  value === "workspace" || value === "folder" || value === "file";
export const isLockVisibility = (value: unknown): value is LockVisibility =>
  value === "visible" || value === "hidden";
export type LockRow = {
  kind: LockKind;
  id: string;
  visibility: LockVisibility;
  releaseAt: number | null;
  zone: string | null;
  createdAt: number;
  updatedAt: number;
};
export type LockState = {
  locked: boolean;
  hidden: boolean;
  // The lock on the item itself, if any.
  own?: LockRow;
  // Locked only through a parent (or the workspace): its nearest locking ancestor.
  from?: { kind: LockKind; id: string };
};
// Who is asking. `owner` is the workspace owner (full control of every lock).
export type Principal = { userId?: string; owner: boolean };
// A delegated lock permission: in `folderId` (and everything inside it), or the whole
// workspace when null. `manage` locks and unlocks, `schedule` sets release dates, `access`
// opens locked content (with the rights the person's sharing already gives them).
export type LockGrant = { folderId: string | null; manage: boolean; schedule: boolean; access: boolean };

const key = (kind: LockKind, id: string) => kind + ":" + id;
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

// One consistent view of a workspace's locks and structure, read once per request.
export class LockSnapshot {
  rows = new Map<string, LockRow>();
  parents = new Map<string, string | null>();
  fileFolder = new Map<string, string | null>();
  constructor(
    db: DatabaseSync,
    public workspaceId: string,
  ) {
    for (const row of db
      .prepare(
        "SELECT target_kind,target_id,visibility,release_at,release_zone,created_at,updated_at FROM content_locks WHERE workspace_id=?",
      )
      .all(workspaceId) as Record<string, unknown>[])
      this.rows.set(key(row.target_kind as LockKind, row.target_id as string), {
        kind: row.target_kind as LockKind,
        id: row.target_id as string,
        visibility: row.visibility as LockVisibility,
        releaseAt: (row.release_at as number | null) ?? null,
        zone: (row.release_zone as string | null) ?? null,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      });
    for (const row of db.prepare("SELECT id,parent_id FROM folders WHERE workspace_id=?").all(workspaceId))
      this.parents.set(row.id as string, (row.parent_id as string | null) ?? null);
    for (const row of db.prepare("SELECT id,folder_id FROM documents WHERE room_id=?").all(workspaceId))
      this.fileFolder.set(row.id as string, (row.folder_id as string | null) ?? null);
  }
  get empty() {
    return this.rows.size === 0;
  }
  // The folder and its ancestors, nearest first (at most 12 levels; bounded against cycles).
  ancestry(folderId: string | null) {
    const chain: string[] = [];
    for (let id = folderId, guard = 0; id && guard < 32; guard++) {
      chain.push(id);
      id = this.parents.get(id) ?? null;
    }
    return chain;
  }
  // Is `folderId` the folder `scope` or inside it? (A null scope covers everything.)
  within(scope: string | null, folderId: string | null) {
    return scope === null || (folderId !== null && this.ancestry(folderId).includes(scope));
  }
  private state(chain: Array<{ kind: LockKind; id: string }>): LockState {
    // chain: the item itself first, then its parents outwards, the workspace last.
    let locked = false,
      hidden = false,
      from: LockState["from"];
    const own = this.rows.get(key(chain[0].kind, chain[0].id));
    for (const [index, link] of chain.entries()) {
      const row = this.rows.get(key(link.kind, link.id));
      if (!row) continue;
      locked = true;
      if (row.visibility === "hidden") hidden = true;
      if (index > 0 && !from) from = { kind: link.kind, id: link.id };
    }
    return { locked, hidden, ...(own ? { own } : {}), ...(own ? {} : from ? { from } : {}) };
  }
  // A lesson: the workspace root (null) or a folder.
  folderState(folderId: string | null): LockState {
    const chain = [
      ...this.ancestry(folderId).map((id) => ({ kind: "folder" as const, id })),
      { kind: "workspace" as const, id: this.workspaceId },
    ];
    return this.state(chain);
  }
  fileState(fileId: string, folderId?: string | null): LockState {
    const folder = folderId !== undefined ? folderId : (this.fileFolder.get(fileId) ?? null);
    return this.state([
      { kind: "file", id: fileId },
      ...this.ancestry(folder).map((id) => ({ kind: "folder" as const, id })),
      { kind: "workspace", id: this.workspaceId },
    ]);
  }
  // Files of one lesson that are locked themselves (the lesson itself being unlocked).
  lockedFilesIn(folderId: string | null, fileIds: Iterable<string>) {
    const locked = new Set<string>();
    for (const id of fileIds) if (this.rows.has(key("file", id))) locked.add(id);
    void folderId;
    return locked;
  }
  // Is anything inside this folder (subfolders or files, at any depth) locked?
  lockInside(folderId: string) {
    for (const row of this.rows.values()) {
      if (row.kind === "folder" && row.id !== folderId && this.ancestry(row.id).includes(folderId)) return true;
      if (row.kind === "file") {
        const folder = this.fileFolder.get(row.id);
        if (folder && this.ancestry(folder).includes(folderId)) return true;
      }
    }
    return false;
  }
}

// What a live socket of a lesson receives: the lesson itself ("main"), a filtered copy without
// locked files ("view"; `blank` when the whole lesson is locked, so nothing of it is sent), or
// nothing at all ("hidden": the lesson is hidden from this person).
export type SocketMode =
  | { mode: "main" }
  | { mode: "hidden" }
  | { mode: "view"; blank: boolean; hidden: Set<string> };

export class Locks {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private db: DatabaseSync,
    // Called after locks of a workspace changed (manually or by a scheduled release).
    private onChange: (workspaceId: string) => void,
  ) {}
  any(workspaceId: string) {
    return !!this.db.prepare("SELECT 1 FROM content_locks WHERE workspace_id=? LIMIT 1").get(workspaceId);
  }
  snapshot(workspaceId: string) {
    return new LockSnapshot(this.db, workspaceId);
  }
  // The caller's own delegated lock permissions (directly, or through their teams).
  grants(workspaceId: string, userId: string | undefined): LockGrant[] {
    if (!userId) return [];
    return (
      this.db
        .prepare(
          `SELECT p.folder_id, p.can_manage, p.can_schedule, p.can_access FROM lock_permissions p
           WHERE p.workspace_id=? AND (p.user_id=? OR p.team_id IN (SELECT team_id FROM team_members WHERE user_id=?))`,
        )
        .all(workspaceId, userId, userId) as Record<string, unknown>[]
    ).map((row) => ({
      folderId: (row.folder_id as string | null) ?? null,
      manage: row.can_manage === 1,
      schedule: row.can_schedule === 1,
      access: row.can_access === 1,
    }));
  }
  // May this person open locked content in this lesson (null: the workspace root)?
  exempt(snap: LockSnapshot, who: Principal, folderId: string | null, grants = this.grants(snap.workspaceId, who.userId)) {
    if (who.owner) return true;
    return grants.some((g) => g.access && snap.within(g.folderId, folderId));
  }
  // Where a target sits, for permission checks: its lesson (a file's folder; a folder itself).
  private targetFolder(snap: LockSnapshot, kind: LockKind, id: string) {
    if (kind === "folder") return id;
    if (kind === "file") return snap.fileFolder.get(id) ?? null;
    return null;
  }
  canManage(snap: LockSnapshot, who: Principal, kind: LockKind, id: string, grants = this.grants(snap.workspaceId, who.userId)) {
    if (who.owner) return true;
    const folder = this.targetFolder(snap, kind, id);
    return grants.some((g) => g.manage && (kind === "workspace" ? g.folderId === null : snap.within(g.folderId, folder)));
  }
  canSchedule(snap: LockSnapshot, who: Principal, kind: LockKind, id: string, grants = this.grants(snap.workspaceId, who.userId)) {
    if (who.owner) return true;
    const folder = this.targetFolder(snap, kind, id);
    return grants.some(
      (g) => g.manage && g.schedule && (kind === "workspace" ? g.folderId === null : snap.within(g.folderId, folder)),
    );
  }
  socketMode(snap: LockSnapshot, exempt: boolean, folderId: string | null, fileIds: Iterable<string>): SocketMode {
    if (exempt || snap.empty) return { mode: "main" };
    const lesson = snap.folderState(folderId);
    if (lesson.locked) {
      // The workspace root always exists for someone who can open the workspace: it shows as
      // locked (blank). A hidden folder looks like one that doesn't exist.
      if (lesson.hidden && folderId !== null) return { mode: "hidden" };
      return { mode: "view", blank: true, hidden: new Set() };
    }
    const hidden = snap.lockedFilesIn(folderId, fileIds);
    return hidden.size ? { mode: "view", blank: false, hidden } : { mode: "main" };
  }
  // ---- Changes. Each records history, and onChange tells live sessions and open explorers.
  record(
    workspaceId: string,
    target: { kind: LockKind; id: string; name: string },
    action: string,
    detail: string,
    actor: { kind: "user"; id: string; name: string } | { kind: "schedule" },
  ) {
    this.db
      .prepare(
        "INSERT INTO lock_events (id,workspace_id,target_kind,target_id,target_name,action,detail,actor_id,actor_name,actor_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        workspaceId,
        target.kind,
        target.id,
        target.name.slice(0, 120),
        action,
        detail.slice(0, 200),
        actor.kind === "user" ? actor.id : null,
        actor.kind === "user" ? actor.name.slice(0, 40) : null,
        actor.kind,
        Date.now(),
      );
  }
  history(workspaceId: string, target?: { kind: LockKind; id: string }, limit = 50) {
    return (
      this.db
        .prepare(
          `SELECT id,target_kind,target_id,target_name,action,detail,actor_name,actor_kind,created_at FROM lock_events
           WHERE workspace_id=?${target ? " AND target_kind=? AND target_id=?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...([workspaceId, ...(target ? [target.kind, target.id] : []), limit] as string[])) as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id,
      kind: row.target_kind,
      targetId: row.target_id,
      name: row.target_name,
      action: row.action,
      detail: row.detail,
      actor: row.actor_kind === "schedule" ? "Scheduled release" : ((row.actor_name as string | null) ?? "Someone"),
      createdAt: row.created_at,
    }));
  }
  changed(workspaceId: string) {
    this.onChange(workspaceId);
    this.schedule();
  }
  // ---- Scheduled releases: one timer for the whole server, set for the next due release
  // (re-armed after every change), plus a sweep from the server's regular 15-second timer.
  // Each release is a single conditional DELETE, so it happens exactly once even if the timer
  // and the sweep run together, and a release whose date was changed meanwhile is left alone.
  // Overdue releases (the server was stopped at the time) are processed at startup.
  releaseDue(now = Date.now()) {
    const due = this.db
      .prepare(
        "SELECT workspace_id,target_kind,target_id,release_at FROM content_locks WHERE release_at IS NOT NULL AND release_at<=? ORDER BY release_at LIMIT 500",
      )
      .all(now) as Array<{ workspace_id: string; target_kind: LockKind; target_id: string; release_at: number }>;
    const touched = new Set<string>();
    for (const row of due) {
      const removed = this.db
        .prepare("DELETE FROM content_locks WHERE workspace_id=? AND target_kind=? AND target_id=? AND release_at=?")
        .run(row.workspace_id, row.target_kind, row.target_id, row.release_at).changes;
      if (!removed) continue;
      this.record(
        row.workspace_id,
        { kind: row.target_kind, id: row.target_id, name: targetName(this.db, row.workspace_id, row.target_kind, row.target_id) },
        "released",
        "Released as scheduled",
        { kind: "schedule" },
      );
      touched.add(row.workspace_id);
    }
    for (const workspaceId of touched) this.onChange(workspaceId);
    return touched.size;
  }
  schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const next = this.db.prepare("SELECT MIN(release_at) AS t FROM content_locks WHERE release_at IS NOT NULL").get()?.t as
      | number
      | null
      | undefined;
    if (next === null || next === undefined) return;
    // Long waits are re-armed hourly (timers can't wait more than ~24 days, and clocks drift).
    const delay = Math.min(Math.max(next - Date.now(), 0), 60 * 60_000);
    this.timer = setTimeout(() => {
      try {
        this.releaseDue();
      } catch (error) {
        console.error("Scheduled release failed; the next sweep retries.", error);
      }
      this.schedule();
    }, delay + 5);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

// What the Explorer shows about a lock. Everyone sees the state and any release date of what
// they can see; people who manage locks also see how each lock is set up.
export type TreeLock = {
  state: "locked" | "inherited";
  releaseAt: number | null;
  visibility?: LockVisibility;
  zone?: string | null;
  hidden?: boolean;
  // This person may still open it (the owner, or a delegate with access there).
  canOpen?: true;
};
function treeLock(state: LockState, detail: boolean, canOpen: boolean): TreeLock | undefined {
  if (!state.locked) return undefined;
  return {
    state: state.own ? "locked" : "inherited",
    releaseAt: state.own?.releaseAt ?? null,
    ...(canOpen ? { canOpen: true as const } : {}),
    ...(detail ? { visibility: state.own?.visibility ?? "visible", zone: state.own?.zone ?? null, hidden: state.hidden } : {}),
  };
}
type Tree = { folders: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>> };
// A tree as one person may see it: hidden items (and everything inside them) are left out for
// people locks restrict there; every remaining item carries its lock state.
export function lockTree<T extends Tree>(
  tree: T,
  snapshot: LockSnapshot | undefined,
  exempt: (folderId: string | null) => boolean,
  detail: boolean,
) {
  if (!snapshot || snapshot.empty) return tree;
  const folders = tree.folders.flatMap((folder) => {
    const id = folder.id as string;
    const state = snapshot.folderState(id);
    const open = exempt(id);
    if (state.hidden && !open) return [];
    const lock = treeLock(state, detail, open);
    return [lock ? { ...folder, lock } : folder];
  });
  const documents = tree.documents.flatMap((file) => {
    const folderId = (file.folder_id as string | null) ?? null;
    const state = snapshot.fileState(file.id as string, folderId);
    const open = exempt(folderId);
    if (state.hidden && !open) return [];
    const lock = treeLock(state, detail, open);
    return [lock ? { ...file, lock } : file];
  });
  const root = treeLock(snapshot.folderState(null), detail, exempt(null));
  return { ...tree, folders, documents, ...(root ? { workspaceLock: root } : {}) };
}
// Names of the items hidden from one person (hidden locks outside their exemption), so activity
// entries naming them (activity rows carry a name, not an ID) are left out of what they see.
export function hiddenNames(snapshot: LockSnapshot, exempt: (folderId: string | null) => boolean, db: DatabaseSync) {
  const names = new Set<string>();
  if (snapshot.empty) return names;
  for (const row of db.prepare("SELECT id,name FROM folders WHERE workspace_id=?").all(snapshot.workspaceId) as { id: string; name: string }[])
    if (snapshot.folderState(row.id).hidden && !exempt(row.id)) names.add(row.name);
  for (const row of db.prepare("SELECT id,folder_id,filename FROM documents WHERE room_id=?").all(snapshot.workspaceId) as {
    id: string;
    folder_id: string | null;
    filename: string;
  }[])
    if (snapshot.fileState(row.id, row.folder_id ?? null).hidden && !exempt(row.folder_id ?? null)) names.add(row.filename);
  return names;
}
// May a person restricted by locks load this image? Only when a lesson they can open uses it
// in a file they may open, or it sits unused in such a lesson (just uploaded). An image that only
// locked files use stays out of reach, even with its ID.
export function imageUnlocked(
  db: DatabaseSync,
  snapshot: LockSnapshot,
  exempt: (folderId: string | null) => boolean,
  canReadLesson: (folderId: string | null) => boolean,
  imageId: string,
) {
  const lessons = db
    .prepare("SELECT folder_id FROM image_refs WHERE image_id=? AND workspace_id=?")
    .all(imageId, snapshot.workspaceId) as { folder_id: string | null }[];
  for (const { folder_id } of lessons) {
    const folder = folder_id ?? null;
    if (!canReadLesson(folder)) continue;
    if (exempt(folder)) return true;
    if (snapshot.folderState(folder).locked) continue;
    const users = db
      .prepare("SELECT id FROM documents WHERE room_id=? AND folder_id IS ? AND instr(content, ?) > 0")
      .all(snapshot.workspaceId, folder, "/images/" + imageId) as { id: string }[];
    if (!users.length || users.some((d) => !snapshot.fileState(d.id, folder).locked)) return true;
  }
  return false;
}

// The display name of a lock target (folder or file name; the workspace's name).
export function targetName(db: DatabaseSync, workspaceId: string, kind: LockKind, id: string) {
  const row =
    kind === "workspace"
      ? db.prepare("SELECT name FROM rooms WHERE id=?").get(workspaceId)
      : kind === "folder"
        ? db.prepare("SELECT name FROM folders WHERE id=? AND workspace_id=?").get(id, workspaceId)
        : db.prepare("SELECT filename AS name FROM documents WHERE id=? AND room_id=?").get(id, workspaceId);
  return String(row?.name ?? (kind === "file" ? "A file" : kind === "folder" ? "A folder" : "Workspace"));
}

// ---- Time zones. A release is entered as a wall-clock date and time in an IANA time zone and
// stored as one UTC instant. A time skipped by a daylight-saving change (e.g. 02:30 when clocks
// jump from 02:00 to 03:00) doesn't exist and is refused; a time that happens twice (clocks go
// back) means its first occurrence.
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(zone: string, instant: number) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
export function zonedToUtc(date: unknown, time: unknown, zone: unknown) {
  const d = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  const t = typeof time === "string" ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  if (!d || !t) throw httpError("Choose a date and a time.", 400);
  if (!validTimeZone(zone)) throw httpError("Choose a valid time zone.", 400);
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  const wanted = Date.UTC(y, mo - 1, da, h, mi);
  const check = new Date(wanted);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da || h > 23 || mi > 59)
    throw httpError("Choose a valid date and time.", 400);
  // Offsets around the wanted time (a day either side covers every real-world change).
  const candidates = new Set<number>();
  for (const probe of [wanted - 86_400_000, wanted, wanted + 86_400_000]) {
    const offset = wallClock(zone, probe) - probe;
    candidates.add(wanted - offset);
  }
  const matches = [...candidates].filter((instant) => wallClock(zone, instant) === wanted).sort((a, b) => a - b);
  if (!matches.length)
    throw httpError(
      `That time doesn't exist in ${zone} (the clocks skip it for daylight saving). Choose another time.`,
      400,
    );
  return matches[0];
}
