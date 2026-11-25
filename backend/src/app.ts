import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase, vouchImages } from "./database.js";
import {
  Rooms,
  CONTENT_ACTIONS,
  activityEntry,
  addDocument,
  contentVersion,
  fileTooLarge,
  filename,
  language,
  lessonLimit,
  MAX_CONTENT,
  MAX_DOCUMENT,
  normalizeNewlines,
  replaceContent,
  tooLarge,
  type Room,
} from "./rooms.js";
import { Images, MAX_IMAGE_BYTES, fetchImage } from "./images.js";
import { setupWebsocket } from "./websocket.js";
import * as Y from "yjs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  canEditAccess,
  canReadAccess,
  folderRole,
  folderScope,
  hashEditorToken,
  higherAccess,
  isShareRole,
  isVisibility,
  TOKEN_PATTERN,
  workspaceAccess,
  type Access,
  type ShareRole,
} from "./access.js";
import { classify, imageInScope, scopedInfo, scopedTree, type Target } from "./scope.js";
import { FolderSharing } from "./folderSharing.js";
import {
  hiddenNames,
  imageUnlocked,
  isLockKind,
  isLockVisibility,
  lockTree,
  Locks,
  targetName,
  zonedToUtc,
  type LockKind,
  type LockSnapshot,
} from "./locks.js";
import { liveRoutes, LiveSessions } from "./live.js";
import {
  Accounts,
  csrfFor,
  equalSecret,
  newToken,
  validEmail,
  type Session,
} from "./auth.js";
import { accountRoutes, authLimits, type AuthLimits } from "./accountRoutes.js";
import { migrateSnippets } from "./migrate.js";
import { LinkVault } from "./linkVault.js";
import { teamRoutes } from "./teamRoutes.js";
import {
  createMailer,
  EmailOutbox,
  emailConfig,
  type EmailConfig,
  type Mailer,
  type OutboxOptions,
} from "./mailer.js";
import { templates } from "./templates.js";
import {
  blockFields,
  createBlock,
  orderedBlocks,
  reorderBlocks,
  validateBlockCapacity,
  validateLessonCapacity,
  type CodeBlock,
} from "./blocks.js";

// The refusal for a request that touches locked content, or undefined when it may proceed.
// Hidden content answers exactly like content that doesn't exist (404); visibly locked content
// says it is locked (423) with its release date, if any. Folder changes inside a locked lesson
// are refused, and so is deleting a folder that holds locked content (nobody restricted may
// remove what they can't see).
const LOCKED_MESSAGE = "This content is locked. It becomes available when your instructor releases it.";
function lockRefusal(
  snapshot: LockSnapshot,
  exempt: (folderId: string | null) => boolean,
  target: Target,
  method: string,
  path: string,
): { status: number; body: Record<string, unknown> } | undefined {
  const lesson = (folderId: string | null, missing = "Lesson folder not found.") => {
    if (exempt(folderId)) return undefined;
    const state = snapshot.folderState(folderId);
    if (!state.locked) return undefined;
    if (state.hidden && folderId !== null) return { status: 404, body: { error: missing } };
    return { status: 423, body: { error: LOCKED_MESSAGE, locked: true, releaseAt: state.own?.releaseAt ?? null } };
  };
  if (target.kind === "lesson") {
    const refused = lesson(target.folderId);
    if (refused) return refused;
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "documents" && parts[1] && parts[1] !== "order") {
      const folder = snapshot.fileFolder.has(parts[1]) ? (snapshot.fileFolder.get(parts[1]) ?? null) : target.folderId;
      if (exempt(folder)) return undefined;
      const state = snapshot.fileState(parts[1], folder);
      if (!state.locked) return undefined;
      if (state.hidden) return { status: 404, body: { error: "File not found." } };
      return { status: 423, body: { error: LOCKED_MESSAGE, locked: true, releaseAt: state.own?.releaseAt ?? null } };
    }
    return undefined;
  }
  if (target.kind === "upload") return lesson(target.folderId);
  if (target.kind === "manage") {
    const parent = lesson(target.parentId);
    if (parent) return parent;
    if (!target.folderId) return undefined;
    const own = lesson(target.folderId, "Folder not found.");
    if (own) return own;
    if (method === "DELETE" && !exempt(target.folderId) && snapshot.lockInside(target.folderId))
      return { status: 423, body: { error: "This folder holds locked content, so it can't be deleted.", locked: true } };
  }
  return undefined;
}
// A new order for items of which a person restricted by locks sees only some: the items they
// see take the order they asked for, in the slots those items had; everything else stays put.
function mergeOrder(current: string[], visible: Set<string>, requested: string[]) {
  const queue = [...requested];
  return current.map((id) => (visible.has(id) ? queue.shift()! : id));
}
// A whole number from an environment variable within [min, max], else the default (with a
// warning), so a typo can't remove a limit or stop the server from starting.
function boundedEnv(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (/^\d+$/.test(value.trim()) && n >= min && n <= max) return n;
  console.warn(`Expected a whole number from ${min} to ${max}; using ${fallback}.`);
  return fallback;
}

export function createApp(
  options: {
    dbPath?: string;
    origins?: string[];
    checkpointMs?: number;
    // Lessons kept in memory at once (default: MAX_ACTIVE_LESSONS, else 16).
    maxLessons?: number;
    staticPath?: string;
    cookieSecure?: boolean;
    authLimits?: Partial<AuthLimits>;
    email?: Partial<EmailConfig>;
    mailer?: Mailer;
    outbox?: OutboxOptions;
  } = {},
) {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dbPath =
    options.dbPath ??
    process.env.DB_PATH ??
    resolve(projectRoot, "data/devshare.sqlite");
  const rooms = new Rooms(
    openDatabase(dbPath),
    options.checkpointMs,
    options.maxLessons ?? lessonLimit(process.env.MAX_ACTIVE_LESSONS),
  );
  const images = new Images(rooms.db);
  const links = new LinkVault(dbPath);
  // Content locks: every change (manual or a scheduled release) re-checks the workspace's live
  // sockets at once and refreshes open Explorers. Overdue releases are processed at startup.
  const locks = new Locks(rooms.db, (workspaceId) => {
    rooms.relock(workspaceId);
    live?.workspaceChanged(workspaceId);
  });
  rooms.locks = locks;
  const origins = new Set(
    options.origins ??
      (
        process.env.ALLOWED_ORIGINS ??
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
      )
        .split(",")
        .map((s) => s.trim()),
  );
  // Secure cookies by default in production; the plain-HTTP local preview opts out.
  const accounts = new Accounts(
    rooms.db,
    options.cookieSecure ??
      (process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === "1"
        : process.env.NODE_ENV === "production"),
  );
  // Transactional email (welcome + admin notifications) via a persistent SQLite outbox.
  const mail = { ...emailConfig(), ...options.email };
  const outbox = new EmailOutbox(
    rooms.db,
    mail,
    options.mailer ?? createMailer(mail),
    options.outbox,
  );
  outbox.recover();
  outbox.kick();
  // Live Coding sessions (live.ts): their own bounded set of loaded sessions and viewers.
  const live: LiveSessions = new LiveSessions(rooms.db, accounts, links, locks, {
    maxSessions: boundedEnv(process.env.MAX_LIVE_SESSIONS, 8, 1, 64),
    maxViewers: boundedEnv(process.env.MAX_LIVE_VIEWERS, 300, 1, 2000),
    checkpointMs: options.checkpointMs ?? 1500,
  });
  locks.releaseDue();
  locks.schedule();
  // One startup line to confirm the email setup; it never includes the key itself.
  if (mail.enabled && !options.mailer)
    console.log(
      `Email enabled: provider=${mail.provider}, from=${mail.from}, admins=${mail.admins.length}` +
        (mail.provider === "resend" && !process.env.RESEND_API_KEY ? " (WARNING: RESEND_API_KEY is not set)" : ""),
    );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          workerSrc: ["'self'", "blob:"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          fontSrc: ["'self'", "data:"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // File text routes (create, content update) accept documents up to MAX_DOCUMENT: JSON escaping
  // can double the size of code, and content updates may also be sent as raw text/plain. Their
  // bodies are parsed only inside those routes, i.e. after the rate limit, session/CSRF and
  // access checks, so unauthorised clients never make the server parse a large body. The
  // decoded text is checked against the real limits in the route. Every other route keeps the
  // small limits (128 KB parsed, 16 KB serialized; code blocks are checked per block instead).
  const fileText = /^\/api\/rooms\/[\w-]{16}\/documents(?:\/[\w-]{36}\/content)?$/;
  const fileTextLimit = 2 * MAX_DOCUMENT + 64 * 1024;
  const smallJson = express.json({ limit: "128kb" }),
    fileJson = express.json({ limit: fileTextLimit }),
    fileRaw = express.text({ type: "text/plain", limit: fileTextLimit });
  const fileBody: express.RequestHandler = (req, res, next) =>
    fileRaw(req, res, (error?: unknown) => (error ? next(error) : fileJson(req, res, next)));
  app.use((req, res, next) => {
    if (req.method !== "GET" && fileText.test(req.path)) return next();
    smallJson(req, res, next);
  });
  app.use((req, res, next) => {
    if (
      !/^\/api\/rooms\/[\w-]{16}\/blocks(?:\/|$)/.test(req.path) &&
      !fileText.test(req.path) &&
      Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16 * 1024
    ) {
      res.status(413).json({ error: "Request too large." });
      return;
    }
    next();
  });
  // Per-IP limits by risk. A class often shares one public IP (school NAT), so opening a
  // share link (a handful of reads plus each image) for 100+ students must fit easily,
  // while changes keep the strict budget. Sign-in/sign-up keep their own tighter limits.
  const perMinute = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests right now. Please wait a moment and try again." },
    });
  const writeLimit = perMinute(240),
    readLimit = perMinute(1200),
    imageLimit = perMinute(3000);
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return writeLimit(req, res, next);
    // Image bytes are immutable and cached by browsers; they are streamed in small chunks.
    if (/^\/rooms\/[\w-]{16}\/images\/[\w-]{22}$/.test(req.path)) return imageLimit(req, res, next);
    return readLimit(req, res, next);
  });
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      !origins.has(req.headers.origin)
    ) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  });
  // Resolve the session cookie. Cookie-authenticated writes need an allowed Origin and
  // the per-session CSRF token header (SameSite=Lax alone is not relied upon).
  app.use("/api", (req, res, next) => {
    const token = accounts.tokenFrom(req);
    const session = accounts.session(token);
    if (token && !session) res.append("Set-Cookie", accounts.clearCookie());
    res.locals.session = session;
    if (session && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const supplied = req.headers["x-csrf-token"];
      if (
        !req.headers.origin ||
        !origins.has(req.headers.origin) ||
        typeof supplied !== "string" ||
        !equalSecret(supplied, csrfFor(session.token))
      ) {
        res.status(403).json({
          error: "Your session check failed. Refresh the page and try again.",
        });
        return;
      }
    }
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/metrics", (req, res) => {
    const expected = process.env.METRICS_TOKEN;
    const supplied =
      req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    if (
      !expected ||
      Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      res.status(404).json({ error: "Endpoint not found." });
      return;
    }
    res.json({
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      cpuMicroseconds: process.cpuUsage(),
      activeSessions: rooms.active.size,
      // Lesson capacity: the limit, idle lessons unloaded to make space, failed unloads
      // (a save error; the lesson stays loaded) and lessons refused because all were in use.
      lessonLimit: rooms.maxRooms,
      lessonEvictions: rooms.capacity.evictions,
      lessonEvictionFailures: rooms.capacity.evictionFailures,
      lessonRefusals: rooms.capacity.refusals,
      websocketConnections: [...rooms.active.values()].reduce(
        (sum, session) => sum + rooms.peerCount(session),
        0,
      ),
      sessions: [...rooms.active.values()].map((session) => ({
        workspaceId: session.workspaceId,
        folderId: session.folderId,
        connections: rooms.peerCount(session),
        ...(session.view ? { filteredConnections: session.view.peers.size } : {}),
      })),
      liveSessions: live.metrics(),
      persistedWorkspaces: Number(
        rooms.db.prepare("SELECT COUNT(*) AS n FROM rooms").get()?.n,
      ),
    });
  });
  accountRoutes(app, accounts, rooms, origins, outbox, {
    ...authLimits(),
    ...options.authLimits,
  });
  liveRoutes(app, live, {
    rooms,
    accounts,
    workspaceImages: images,
    locks,
    record: (workspaceId, action, label, actor) => rooms.record(workspaceId, action, label, actor),
  });
  teamRoutes(app, rooms.db, (workspaceId) => {
    rooms.revalidate(
      workspaceId,
      (hash, user) => accounts.sessionValid(hash, user),
      "Your access to this workspace changed. Refresh to continue.",
    );
    // A deleted team takes its folder shares with it; managers' Explorer marks follow.
    rooms.notifySharing(workspaceId);
  });
  // Folder shares (accounts and teams). Every change re-checks that workspace's live sockets,
  // so a revoked folder closes at once while other grants keep their sessions, then tells the
  // workspace's sharing managers (only them) to re-read which folders are shared.
  const folderSharing = new FolderSharing(rooms.db, (workspaceId) => {
    rooms.revalidate(
      workspaceId,
      (hash, user) => accounts.sessionValid(hash, user),
      "Your access to this folder changed. Refresh to continue.",
    );
    rooms.notifySharing(workspaceId);
  });
  app.post(
    "/api/rooms",
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    (req, res) => {
      // Every new workspace has an owner.
      const session = res.locals.session as Session | undefined;
      if (!session) {
        res
          .status(401)
          .json({ error: "Sign in or create an account to create a workspace." });
        return;
      }
      const name = req.body.name ?? "Untitled workspace";
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        throw new Error("Workspace names must be 1–80 characters.");
      const description = req.body.description ?? "";
      if (typeof description !== "string" || description.length > 400)
        throw new Error("Descriptions must be at most 400 characters.");
      if (
        req.body.template !== undefined &&
        (typeof req.body.template !== "string" ||
          !Object.hasOwn(templates, req.body.template))
      )
        throw new Error("Choose a supported workspace template.");
      // New workspaces are private unless the creator asks for link access.
      const visibility = req.body.visibility ?? "private";
      if (!isVisibility(visibility))
        throw new Error("Choose who can open this workspace.");
      const room = rooms.create(
        name.trim(),
        language(req.body.language ?? "hcl"),
        null,
        req.body.template,
        description.trim(),
        session.user.id,
        { kind: "user", id: session.user.id, name: session.user.displayName },
        visibility,
      );
      res.status(201).json({ id: room.id, name: room.name });
    },
  );
  // One message for "doesn't exist" and "private, no access", so they can't be told apart.
  const notFound =
    "Workspace not found. It may have been deleted, or it is private: sign in if it was shared with you.";
  app.use("/api/rooms/:roomId", (req, res, next) => {
    if (!/^[A-Za-z0-9_-]{16}$/.test(req.params.roomId)) {
      res
        .status(404)
        .json({
          error: "Workspace not found. Check your link or workspace code.",
        });
      return;
    }
    const room = rooms.info(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: notFound });
      return;
    }
    room.touched = Date.now();
    res.locals.workspace = room;
    const credential = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const tokenHash =
      credential && TOKEN_PATTERN.test(credential)
        ? hashEditorToken(credential)
        : undefined;
    const linkValid = rooms.canEditHash(room.id as string, tokenHash);
    const session = res.locals.session as Session | undefined;
    const workspaceId = room.id as string;
    // An invalid or revoked link grants nothing, so access is the same with or without it.
    const workspace = workspaceAccess(
      rooms.db,
      (hash, user) => accounts.sessionValid(hash, user),
      workspaceId,
      { userId: session?.user.id, sessionHash: session?.tokenHash, tokenHash },
    );
    // Folder grants (account or team) add rights inside the shared folders only, for a
    // signed-in account whose workspace access doesn't already include editing.
    const folderGrant = (folderId: string | null): Access =>
      folderId && session && !canEditAccess(workspace)
        ? (folderRole(rooms.db, workspaceId, folderId, session.user.id) ?? "none")
        : "none";
    let scope: Map<string, ShareRole> | undefined;
    const folderScopeOf = () =>
      (scope ??= session && !canReadAccess(workspace) ? folderScope(rooms.db, workspaceId, session.user.id) : new Map());
    // What this request touches decides which grants count (see scope.ts).
    const target = classify(rooms.db, workspaceId, req.method, req.path, req.query, req.body);
    let access: Access = workspace,
      readable = canReadAccess(workspace);
    if (target.kind === "lesson" || target.kind === "upload") {
      access = higherAccess(workspace, folderGrant(target.folderId));
      readable = canReadAccess(access);
    } else if (target.kind === "manage") {
      // Editing needs rights on the parent lesson; seeing the folder at all needs rights on
      // the folder (or its parent, when creating or reordering).
      access = higherAccess(workspace, folderGrant(target.parentId));
      readable = canReadAccess(higherAccess(access, folderGrant(target.folderId)));
    } else if (target.kind === "image" && !readable) {
      readable = imageInScope(rooms.db, workspaceId, target.imageId, folderScopeOf());
      if (readable) access = "viewer";
    } else if ((target.kind === "info" || target.kind === "tree" || target.kind === "roles") && !readable)
      readable = folderScopeOf().size > 0;
    // No access at all (a private workspace and no grant, or a folder-only recipient asking
    // for anything outside their folders): the same 404 as a workspace that doesn't exist,
    // so neither its existence nor its name is revealed. This gate covers every
    // /api/rooms/:roomId route (content, files, images, tree, blocks, sharing). It runs
    // before the link check: a fake or revoked link must not tell "private" from "missing".
    if (!readable) {
      res.status(404).json({ error: notFound });
      return;
    }
    // Only someone who can already open the workspace learns that their link is not valid
    // (the editor then reopens it view-only, or through their account's share).
    if (req.headers.authorization && !linkValid) {
      res.status(403).json({
        error: "This private editor link is invalid or has been revoked.",
      });
      return;
    }
    // Content locks (only in workspaces that have any): who may open what. The owner and
    // delegates with locked-content access (in their scope) are exempt; everyone else is
    // refused locked lessons, files, folder changes and images, the same way on every route.
    const who = { userId: session?.user.id, owner: workspace === "owner" };
    const lockGrants = locks.grants(workspaceId, who.userId);
    res.locals.lockGrants = lockGrants;
    res.locals.lockPrincipal = who;
    let lockSnapshot: LockSnapshot | undefined;
    let lockExempt = (_folderId: string | null) => true;
    if (locks.any(workspaceId)) {
      const snapshot = (lockSnapshot = locks.snapshot(workspaceId));
      lockExempt = (folderId) => locks.exempt(snapshot, who, folderId, lockGrants);
      const refusal = lockRefusal(snapshot, lockExempt, target, req.method, req.path);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      if (
        target.kind === "image" &&
        !who.owner &&
        !imageUnlocked(
          rooms.db,
          snapshot,
          lockExempt,
          (folderId) => canReadAccess(workspace) || (folderId !== null && folderScopeOf().has(folderId)),
          target.imageId,
        )
      ) {
        res.status(404).json({ error: "Image not found." });
        return;
      }
    }
    res.locals.lockSnapshot = lockSnapshot;
    res.locals.lockExempt = lockExempt;
    // Lock details (visibility, time zone) for the people who manage locks.
    const lockDetail = who.owner || lockGrants.some((g) => g.manage);
    res.locals.lockDetail = lockDetail;
    // Folder-only recipients: their own view of the workspace, nothing beyond their folders.
    if (!canReadAccess(workspace) && (target.kind === "info" || target.kind === "tree")) {
      res.json(
        target.kind === "info"
          ? scopedInfo(rooms.db, workspaceId, folderScopeOf())
          : lockTree(scopedTree(rooms.db, workspaceId, folderScopeOf()), lockSnapshot, lockExempt, lockDetail),
      );
      return;
    }
    // The shared folder itself can't be renamed, reordered or deleted by its recipients.
    if (target.kind === "manage" && target.folderId && !canEditAccess(access) && canEditAccess(folderGrant(target.folderId))) {
      res.status(403).json({ error: "A shared folder itself can't be renamed, moved or deleted by the people it's shared with." });
      return;
    }
    res.locals.access = access;
    // Workspace-level rights alone (folder grants never manage, share or see presence).
    res.locals.workspaceAccess = workspace;
    res.locals.linkValid = linkValid;
    res.locals.canEdit = canEditAccess(access);
    // Who a change is attributed to: the verified account, else a private-link guest.
    res.locals.actor = session
      ? { kind: "user", id: session.user.id, name: session.user.displayName }
      : canEditAccess(access)
        ? { kind: "link" }
        : undefined;
    // Owners manage their workspace; unclaimed legacy workspaces keep v1 link management.
    res.locals.canManage =
      workspace === "owner" || (workspace === "editor" && !room.owner_id);
    // Read on every request, so a removed or downgraded share loses sharing at once.
    const share = session
      ? rooms.db
          .prepare(
            "SELECT role FROM workspace_shares WHERE workspace_id=? AND user_id=?",
          )
          .get(room.id, session.user.id)
      : undefined;
    res.locals.sharedRole = share?.role;
    // Sharing (Edit Link and account shares): the owner and signed-in editor shares.
    // Edit Link guests, viewer shares and students never manage sharing.
    res.locals.canShare =
      workspace === "owner" || (workspace === "editor" && share?.role === "editor");
    next();
  });
  app.get("/api/rooms/:roomId", (_req, res) => {
    const room = res.locals.workspace;
    const sharedRole = res.locals.sharedRole;
    res.json({
      ...(sharedRole ? { sharedRole } : {}),
      id: room.id,
      name: room.name,
      description: room.description,
      access: res.locals.access,
      visibility: room.visibility,
      owned: !!room.owner_id,
      // A valid editor link for an unowned workspace can be claimed once.
      claimable: !room.owner_id && res.locals.linkValid,
      canShare: res.locals.canShare,
      ...(res.locals.canShare
        ? { hasEditorLink: !!room.has_editor_link }
        : {}),
      // Lock management (the owner, and accounts the owner delegated to); never sent otherwise.
      ...(res.locals.lockDetail ? { canManageLocks: true } : {}),
    });
  });
  // The caller's own folder grants in this workspace (each granted folder and everything inside
  // it, with the best role), so the interface can offer editing exactly where the server allows
  // it. Opaque folder IDs only; empty without a signed-in account or folder grants.
  app.get("/api/rooms/:roomId/folder-roles", (_req, res) => {
    const session = res.locals.session as Session | undefined;
    res.json({
      roles: session ? Object.fromEntries(folderScope(rooms.db, res.locals.workspace.id, session.user.id)) : {},
    });
  });
  app.get("/api/rooms/:roomId/summary", (_req, res) => {
    if (!res.locals.canManage) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    const id = res.locals.workspace.id;
    const info = rooms.info(id)!;
    res.json({
      id: info.id,
      name: info.name,
      description: info.description,
      created_at: info.created_at,
      updated_at: info.updated_at,
      files: Number(
        rooms.db
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE room_id=?")
          .get(id)?.n,
      ),
      blocks: Number(
        rooms.db
          .prepare("SELECT COUNT(*) AS n FROM code_blocks WHERE workspace_id=?")
          .get(id)?.n,
      ),
      folders: Number(
        rooms.db
          .prepare("SELECT COUNT(*) AS n FROM folders WHERE workspace_id=?")
          .get(id)?.n,
      ),
      activity: rooms.db
        .prepare(
          "SELECT id,action,label,created_at FROM activity WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30",
        )
        .all(id),
    });
  });
  // Recent content activity for Owners and Editors. Viewers get the same 404 as an unknown
  // endpoint, so the response reveals nothing. Paged by (created_at, id) cursor.
  app.get("/api/rooms/:roomId/activity", (req, res) => {
    if (!res.locals.canEdit) {
      res.status(404).json({ error: "Endpoint not found." });
      return;
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const before = Number(req.query.before),
      beforeId = typeof req.query.beforeId === "string" ? req.query.beforeId : "";
    const cursor = Number.isSafeInteger(before) && before > 0;
    const actions = CONTENT_ACTIONS.map(() => "?").join(",");
    const rows = rooms.db
      .prepare(
        `SELECT id,action,label,created_at,actor_name,actor_kind FROM activity WHERE workspace_id=? AND action IN (${actions})` +
          (cursor ? " AND (created_at<? OR (created_at=? AND id<?))" : "") +
          " ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(
        res.locals.workspace.id,
        ...CONTENT_ACTIONS,
        ...(cursor ? [before, before, beforeId] : []),
        limit + 1,
      );
    // People locks restrict don't see activity naming items hidden from them.
    const snapshot = res.locals.lockSnapshot as LockSnapshot | undefined;
    const hidden = snapshot ? hiddenNames(snapshot, res.locals.lockExempt, rooms.db) : undefined;
    res.json({
      entries: rows
        .slice(0, limit)
        .filter((row) => !hidden?.has(String(row.label)))
        .map(activityEntry),
      hasMore: rows.length > limit,
    });
  });
  // ---- Content locks: managed by the workspace owner and by accounts the owner delegates to,
  // within their scope (lock_permissions). Delegation itself is the owner's alone. These routes
  // check their own rights (a delegate may be a workspace Viewer), so they come before the
  // general view-only guard below. Every change is one transaction, recorded in the lock
  // history, and applied to live sessions at once (Locks.changed -> Rooms.relock).
  const lockChanges = rateLimit({
    windowMs: 10 * 60_000,
    limit: 240,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many lock changes. Wait a few minutes and try again." },
  });
  const lockRows = (workspaceId: string) =>
    rooms.db
      .prepare(
        "SELECT target_kind AS kind,target_id AS id,visibility,release_at AS releaseAt,release_zone AS zone,created_at AS createdAt,updated_at AS updatedAt FROM content_locks WHERE workspace_id=? ORDER BY created_at,target_id",
      )
      .all(workspaceId);
  const lockManager = (res: express.Response) => {
    const session = res.locals.session as Session | undefined;
    if (!session || !res.locals.lockDetail) {
      res.status(404).json({ error: "Endpoint not found." });
      return undefined;
    }
    return { kind: "user" as const, id: session.user.id, name: session.user.displayName };
  };
  const formatRelease = (at: number, zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(at) + ` (${zone})`;
  app.get("/api/rooms/:roomId/locks", (_req, res) => {
    if (!lockManager(res)) return;
    const who = res.locals.lockPrincipal as { owner: boolean };
    res.json({
      owner: who.owner,
      // Where this person manages locks (null: the whole workspace).
      scopes: who.owner
        ? [{ folderId: null, manage: true, schedule: true, access: true }]
        : res.locals.lockGrants,
      locks: lockRows(res.locals.workspace.id),
    });
  });
  app.get("/api/rooms/:roomId/locks/history", (req, res) => {
    if (!lockManager(res)) return;
    const kind = req.query.kind,
      id = req.query.id;
    const target =
      isLockKind(kind) && typeof id === "string" && /^[\w-]{16,36}$/.test(id) ? { kind, id } : undefined;
    res.json({ events: locks.history(res.locals.workspace.id, target, 100) });
  });
  app.put("/api/rooms/:roomId/locks", lockChanges, (req, res) => {
    const actor = lockManager(res);
    if (!actor) return;
    const workspaceId = res.locals.workspace.id as string;
    const body = (req.body ?? {}) as Record<string, any>;
    const action = body.action;
    if (!["lock", "unlock", "schedule", "cancel", "visibility"].includes(action))
      throw new Error("Choose whether to lock, unlock or schedule.");
    if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 500)
      throw new Error("Choose what to lock or unlock.");
    const snapshot = locks.snapshot(workspaceId);
    const who = res.locals.lockPrincipal,
      grants = res.locals.lockGrants;
    const seen = new Set<string>();
    const targets: Array<{ kind: LockKind; id: string }> = [];
    for (const raw of body.targets) {
      if (!raw || !isLockKind(raw.kind) || (raw.kind !== "workspace" && typeof raw.id !== "string"))
        throw new Error("Choose what to lock or unlock.");
      const target = { kind: raw.kind as LockKind, id: raw.kind === "workspace" ? workspaceId : String(raw.id) };
      const exists =
        target.kind === "workspace" ||
        (target.kind === "folder" ? snapshot.parents.has(target.id) : snapshot.fileFolder.has(target.id));
      if (!exists) {
        res.status(404).json({ error: "One of these items no longer exists. Refresh and try again." });
        return;
      }
      const key = target.kind + ":" + target.id;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
    const release = action === "schedule" || (action === "lock" && body.release) ? body.release : undefined;
    for (const target of targets) {
      if (!locks.canManage(snapshot, who, target.kind, target.id, grants)) {
        res.status(403).json({ error: "You can't manage locks for one of these items." });
        return;
      }
      if ((release || action === "cancel") && !locks.canSchedule(snapshot, who, target.kind, target.id, grants)) {
        res.status(403).json({ error: "You can't schedule releases for one of these items." });
        return;
      }
    }
    let releaseAt: number | null = null,
      zone: string | null = null;
    if (release) {
      releaseAt = zonedToUtc(release.date, release.time, release.timeZone);
      zone = release.timeZone as string;
      if (releaseAt <= Date.now() + 30_000) throw new Error("Choose a release time in the future.");
    }
    if (body.visibility !== undefined && !isLockVisibility(body.visibility))
      throw new Error("Choose whether locked content is shown or hidden.");
    const visibility = body.visibility as "visible" | "hidden" | undefined;
    if (action === "visibility" && !visibility) throw new Error("Choose whether locked content is shown or hidden.");
    const now = Date.now();
    const upsert = rooms.db.prepare(
      `INSERT INTO content_locks (workspace_id,target_kind,target_id,visibility,release_at,release_zone,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,target_kind,target_id) DO UPDATE SET
       visibility=excluded.visibility, release_at=excluded.release_at, release_zone=excluded.release_zone, updated_at=excluded.updated_at`,
    );
    let changed = 0;
    rooms.db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of targets) {
        const existing = snapshot.rows.get(target.kind + ":" + target.id);
        const named = { ...target, name: targetName(rooms.db, workspaceId, target.kind, target.id) };
        const shown = visibility ?? existing?.visibility ?? "visible";
        if (action === "lock" || action === "schedule") {
          const at = releaseAt ?? (action === "lock" ? (existing?.releaseAt ?? null) : null);
          const atZone = releaseAt !== null ? zone : (existing?.zone ?? null);
          upsert.run(workspaceId, target.kind, target.id, shown, at, atZone, actor.id, existing?.createdAt ?? now, now);
          changed++;
          if (!existing) locks.record(workspaceId, named, "locked", shown === "hidden" ? "Hidden until released" : "Name and status shown", actor);
          else if (existing.visibility !== shown)
            locks.record(workspaceId, named, "visibility", shown === "hidden" ? "Hidden until released" : "Name and status shown", actor);
          if (releaseAt !== null)
            locks.record(workspaceId, named, existing?.releaseAt ? "rescheduled" : "scheduled", "Available from " + formatRelease(releaseAt, zone!), actor);
        } else if (action === "unlock") {
          if (!existing) continue;
          rooms.db
            .prepare("DELETE FROM content_locks WHERE workspace_id=? AND target_kind=? AND target_id=?")
            .run(workspaceId, target.kind, target.id);
          changed++;
          locks.record(workspaceId, named, "unlocked", "Unlocked now", actor);
        } else if (action === "cancel") {
          if (!existing?.releaseAt) continue;
          rooms.db
            .prepare("UPDATE content_locks SET release_at=NULL,release_zone=NULL,updated_at=? WHERE workspace_id=? AND target_kind=? AND target_id=?")
            .run(now, workspaceId, target.kind, target.id);
          changed++;
          locks.record(workspaceId, named, "schedule.canceled", "Stays locked until unlocked", actor);
        } else if (action === "visibility") {
          if (!existing || existing.visibility === shown) continue;
          rooms.db
            .prepare("UPDATE content_locks SET visibility=?,updated_at=? WHERE workspace_id=? AND target_kind=? AND target_id=?")
            .run(shown, now, workspaceId, target.kind, target.id);
          changed++;
          locks.record(workspaceId, named, "visibility", shown === "hidden" ? "Hidden until released" : "Name and status shown", actor);
        }
      }
      rooms.db.exec("COMMIT");
    } catch (error) {
      rooms.db.exec("ROLLBACK");
      throw error;
    }
    if (changed) {
      const verb = { lock: "Locked", unlock: "Unlocked", schedule: "Scheduled", cancel: "Release canceled", visibility: "Visibility changed" }[
        action as "lock"
      ];
      rooms.record(workspaceId, "locks.changed", `${verb}: ${changed} item${changed === 1 ? "" : "s"}`, actor);
      locks.changed(workspaceId);
    }
    res.json({ changed, locks: lockRows(workspaceId) });
  });
  // Delegated lock permissions: the owner allows accounts or teams (who already have access
  // through sharing) to manage locks, schedule releases and open locked content, in the whole
  // workspace or one folder. They never grant access to anything by themselves.
  const lockOwner = (res: express.Response) => {
    if (!(res.locals.lockPrincipal as { owner: boolean }).owner) {
      res.status(403).json({ error: "Only the workspace owner can choose who manages locks." });
      return false;
    }
    return true;
  };
  const permissionList = (workspaceId: string) =>
    rooms.db
      .prepare(
        `SELECT p.id, p.user_id AS userId, u.display_name AS displayName, u.email, p.team_id AS teamId, t.name AS teamName,
           p.folder_id AS folderId, f.name AS folderName, p.can_manage AS manage, p.can_schedule AS schedule, p.can_access AS access, p.created_at AS createdAt
         FROM lock_permissions p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN folders f ON f.id=p.folder_id
         WHERE p.workspace_id=? ORDER BY p.created_at`,
      )
      .all(workspaceId)
      .map((row) => ({ ...row, manage: row.manage === 1, schedule: row.schedule === 1, access: row.access === 1 }));
  app.get("/api/rooms/:roomId/lock-permissions", (_req, res) => {
    if (!lockManager(res) || !lockOwner(res)) return;
    res.json({ permissions: permissionList(res.locals.workspace.id) });
  });
  app.post("/api/rooms/:roomId/lock-permissions", lockChanges, (req, res) => {
    const actor = lockManager(res);
    if (!actor || !lockOwner(res)) return;
    const workspaceId = res.locals.workspace.id as string;
    const body = (req.body ?? {}) as Record<string, any>;
    const folderId = body.folderId ?? null;
    if (
      folderId !== null &&
      (typeof folderId !== "string" || !rooms.db.prepare("SELECT 1 FROM folders WHERE id=? AND workspace_id=?").get(folderId, workspaceId))
    ) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    let userId: string | null = null,
      teamId: string | null = null,
      who = "";
    if (body.teamId !== undefined) {
      const team = TEAM_ID.test(String(body.teamId))
        ? rooms.db
            .prepare("SELECT t.id,t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.team_id=? AND m.user_id=?")
            .get(String(body.teamId), actor.id)
        : undefined;
      if (!team) {
        res.status(404).json({ error: "Choose one of your teams." });
        return;
      }
      teamId = team.id as string;
      who = `Team ${team.name}`;
    } else {
      const user = rooms.db.prepare("SELECT id,display_name FROM users WHERE email=?").get(validEmail(body.email));
      if (!user) {
        res.status(404).json({ error: "No Kodelumi account uses that email." });
        return;
      }
      if (user.id === actor.id) {
        res.status(400).json({ error: "You already manage every lock in this workspace." });
        return;
      }
      userId = user.id as string;
      who = String(user.display_name);
    }
    const manage = body.manage !== false,
      schedule = manage && body.schedule === true,
      access = body.access !== false;
    if (!manage && !access) throw new Error("Choose at least one permission.");
    rooms.db.exec("BEGIN IMMEDIATE");
    try {
      rooms.db
        .prepare("DELETE FROM lock_permissions WHERE workspace_id=? AND user_id IS ? AND team_id IS ? AND folder_id IS ?")
        .run(workspaceId, userId, teamId, folderId);
      rooms.db
        .prepare(
          "INSERT INTO lock_permissions (id,workspace_id,user_id,team_id,folder_id,can_manage,can_schedule,can_access,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(randomUUID(), workspaceId, userId, teamId, folderId, manage ? 1 : 0, schedule ? 1 : 0, access ? 1 : 0, actor.id, Date.now());
      rooms.db.exec("COMMIT");
    } catch (error) {
      rooms.db.exec("ROLLBACK");
      throw error;
    }
    const scope = folderId
      ? { kind: "folder" as const, id: folderId, name: targetName(rooms.db, workspaceId, "folder", folderId) }
      : { kind: "workspace" as const, id: workspaceId, name: targetName(rooms.db, workspaceId, "workspace", workspaceId) };
    locks.record(
      workspaceId,
      scope,
      "permission.added",
      `${who}: ${[manage && "manage locks", schedule && "schedule releases", access && "open locked content"].filter(Boolean).join(", ")}`,
      actor,
    );
    locks.changed(workspaceId);
    res.status(201).json({ permissions: permissionList(workspaceId) });
  });
  app.delete("/api/rooms/:roomId/lock-permissions/:permissionId", lockChanges, (req, res) => {
    const actor = lockManager(res);
    if (!actor || !lockOwner(res)) return;
    const workspaceId = res.locals.workspace.id as string;
    const row = rooms.db
      .prepare(
        "SELECT p.folder_id, COALESCE(u.display_name, 'Team ' || t.name) AS who FROM lock_permissions p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN teams t ON t.id=p.team_id WHERE p.id=? AND p.workspace_id=?",
      )
      .get(String(req.params.permissionId), workspaceId);
    if (!row) {
      res.status(404).json({ error: "That permission no longer exists." });
      return;
    }
    rooms.db.prepare("DELETE FROM lock_permissions WHERE id=? AND workspace_id=?").run(String(req.params.permissionId), workspaceId);
    const folderId = (row.folder_id as string | null) ?? null;
    locks.record(
      workspaceId,
      folderId
        ? { kind: "folder", id: folderId, name: targetName(rooms.db, workspaceId, "folder", folderId) }
        : { kind: "workspace", id: workspaceId, name: targetName(rooms.db, workspaceId, "workspace", workspaceId) },
      "permission.removed",
      String(row.who ?? "Someone"),
      actor,
    );
    locks.changed(workspaceId);
    res.json({ permissions: permissionList(workspaceId) });
  });
  app.use("/api/rooms/:roomId", (req, res, next) => {
    if (req.method !== "GET" && !res.locals.canEdit) {
      res.status(403).json({
        error:
          "This workspace is view-only. A private editor link is required to make changes.",
      });
      return;
    }
    next();
  });
  // Ownership and link management: owners only (or the v1 link of an unclaimed workspace).
  app.post("/api/rooms/:roomId/claim", (_req, res) => {
    const session = res.locals.session as Session | undefined;
    const room = res.locals.workspace;
    if (!session) {
      res
        .status(401)
        .json({ error: "Sign in to add this workspace to your account." });
      return;
    }
    if (room.owner_id === session.user.id) {
      res.json({ ok: true });
      return;
    }
    if (!res.locals.linkValid) {
      res.status(403).json({
        error: "Open the workspace with its private editor link to claim it.",
      });
      return;
    }
    // Atomic one-time claim: only succeeds while the workspace has no owner.
    const claimed = rooms.db
      .prepare("UPDATE rooms SET owner_id=? WHERE id=? AND owner_id IS NULL")
      .run(session.user.id, room.id).changes;
    if (!claimed) {
      res
        .status(409)
        .json({ error: "This workspace already belongs to another account." });
      return;
    }
    rooms.record(room.id, "workspace.claimed", session.user.displayName, res.locals.actor);
    res.json({ ok: true });
  });
  app.use("/api/rooms/:roomId/editor-link", (_req, res, next) => {
    if (!res.locals.canShare) {
      res.status(403).json({
        error: "Only the workspace owner and editors can manage editor links.",
      });
      return;
    }
    next();
  });
  // A replaced or revoked Edit Link closes the sessions that relied on it; anyone who still
  // has the same access another way (an account share, a team) stays connected.
  const dropLinkEditors = (workspaceId: string, previousHash: unknown) => {
    if (typeof previousHash === "string")
      rooms.revalidate(
        workspaceId,
        (hash, user) => accounts.sessionValid(hash, user),
        "The private editor link was replaced or revoked",
      );
  };
  // The active Edit Link for the owner and signed-in editors (gated above), so they can copy
  // it again later. Links created before sealing existed come back as null.
  app.get("/api/rooms/:roomId/editor-link", (_req, res) => {
    const id = res.locals.workspace.id,
      row = rooms.db
        .prepare("SELECT editor_token_hash,editor_token_sealed FROM rooms WHERE id=?")
        .get(id);
    res.set("Cache-Control", "no-store");
    res.json({ token: links.open(id, row?.editor_token_sealed, row?.editor_token_hash) ?? null });
  });
  // Creates or replaces the private co-editor link.
  app.post("/api/rooms/:roomId/editor-link", (_req, res) => {
    const id = res.locals.workspace.id,
      token = newToken(),
      previous = rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(id)?.editor_token_hash;
    rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=?,editor_token_sealed=? WHERE id=?")
      .run(hashEditorToken(token), links.seal(id, token), id);
    dropLinkEditors(id, previous);
    rooms.record(id, previous ? "link.replaced" : "link.created", "Editor link", res.locals.actor);
    res.status(201).json({ token });
  });
  app.delete("/api/rooms/:roomId/editor-link", (_req, res) => {
    const id = res.locals.workspace.id,
      previous = rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(id)?.editor_token_hash;
    rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=NULL,editor_token_sealed=NULL WHERE id=?")
      .run(id);
    dropLinkEditors(id, previous);
    if (previous) rooms.record(id, "link.revoked", "Editor link", res.locals.actor);
    res.json({ ok: true });
  });
  // General access: 'link' (anyone with the workspace link can view, no sign-in) or
  // 'private' (only the owner, shares and Edit Link holders). Managed like sharing.
  app.put("/api/rooms/:roomId/visibility", (req, res) => {
    if (!res.locals.canShare) {
      res.status(403).json({
        error: "Only the workspace owner and editors can change who can open this workspace.",
      });
      return;
    }
    const visibility = req.body?.visibility;
    if (!isVisibility(visibility))
      throw new Error("Choose who can open this workspace.");
    const id = res.locals.workspace.id;
    // "Anyone with the link" would open every folder of the workspace, so it waits until no
    // folder is shared on its own (a database trigger enforces the same).
    if (visibility === "link" && folderSharing.hasShares(id)) {
      res.status(409).json({
        error: "Some folders in this workspace are shared on their own. Remove those folder shares before allowing anyone with the link.",
      });
      return;
    }
    const changed = rooms.db
      .prepare("UPDATE rooms SET visibility=? WHERE id=? AND visibility<>?")
      .run(visibility, id, visibility).changes;
    if (changed) {
      // Link viewers lose access at once when it becomes private; others are unaffected.
      rooms.revalidate(
        id,
        (hash, user) => accounts.sessionValid(hash, user),
        "Access to this workspace changed. Refresh to continue.",
      );
      rooms.record(
        id,
        "access.changed",
        visibility === "link" ? "Anyone with the link" : "Restricted",
        res.locals.actor,
      );
    }
    res.json({ visibility });
  });
  // Account sharing: owners and editors add existing registered users as Viewer or Editor.
  // This only places the workspace in their Shared with Me list (and, for editors, grants
  // editing); public viewer links never require an account.
  app.use("/api/rooms/:roomId/shares", (_req, res, next) => {
    if (!res.locals.canShare) {
      res.status(403).json({
        error: "Only the workspace owner and editors can manage sharing.",
      });
      return;
    }
    next();
  });
  // The owner never has a share row, so it can't be changed or removed through sharing.
  app.use("/api/rooms/:roomId/shares/:userId", (req, res, next) => {
    if (req.params.userId === res.locals.workspace.owner_id) {
      res
        .status(403)
        .json({ error: "The workspace owner's access can't be changed." });
      return;
    }
    next();
  });
  const shareList = (id: string) =>
    rooms.db
      .prepare(
        "SELECT s.user_id AS userId,u.display_name AS displayName,u.email,s.role,s.created_at AS createdAt FROM workspace_shares s JOIN users u ON u.id=s.user_id WHERE s.workspace_id=? ORDER BY s.created_at,u.display_name",
      )
      .all(id);
  const userName = (userId: string) =>
    (rooms.db.prepare("SELECT display_name FROM users WHERE id=?").get(userId)
      ?.display_name as string | undefined) ?? "A user";
  // A changed or revoked share reconnects the sessions whose rights changed (that user's);
  // a session that keeps the same access through a team or link stays connected.
  const dropShareSockets = (workspaceId: string, _userId: string) =>
    rooms.revalidate(
      workspaceId,
      (hash, user) => accounts.sessionValid(hash, user),
      "Your access to this workspace changed. Refresh to continue.",
    );
  app.get("/api/rooms/:roomId/shares", (_req, res) => {
    res.json({ shares: shareList(res.locals.workspace.id) });
  });
  app.post(
    "/api/rooms/:roomId/shares",
    rateLimit({
      windowMs: 10 * 60_000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many sharing changes. Wait a few minutes and try again." },
    }),
    (req, res) => {
      const session = res.locals.session as Session;
      const id = res.locals.workspace.id;
      const email = validEmail(req.body.email);
      const role = req.body.role ?? "viewer";
      if (!isShareRole(role)) throw new Error("Choose Viewer or Editor.");
      const user = rooms.db
        .prepare("SELECT id,display_name FROM users WHERE email=?")
        .get(email);
      if (!user) {
        res.status(404).json({
          error:
            "No Kodelumi account uses that email. Students don't need an account: send them the viewer link instead.",
        });
        return;
      }
      if (user.id === res.locals.workspace.owner_id) {
        res.status(400).json({
          error:
            user.id === session.user.id
              ? "You already own this workspace."
              : "That person owns this workspace and already has full access.",
        });
        return;
      }
      const now = Date.now();
      rooms.db
        .prepare(
          "INSERT INTO workspace_shares (workspace_id,user_id,role,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at",
        )
        .run(id, user.id as string, role, session.user.id, now, now);
      dropShareSockets(id, user.id as string);
      rooms.record(id, "share.added", `${user.display_name} (${role})`, res.locals.actor);
      res.status(201).json({ shares: shareList(id) });
    },
  );
  app.patch("/api/rooms/:roomId/shares/:userId", (req, res) => {
    const id = res.locals.workspace.id;
    if (!isShareRole(req.body.role)) throw new Error("Choose Viewer or Editor.");
    const changed = rooms.db
      .prepare(
        "UPDATE workspace_shares SET role=?,updated_at=? WHERE workspace_id=? AND user_id=?",
      )
      .run(req.body.role, Date.now(), id, req.params.userId).changes;
    if (!changed) {
      res.status(404).json({ error: "That person no longer has access." });
      return;
    }
    dropShareSockets(id, req.params.userId);
    rooms.record(
      id,
      "share.changed",
      `${userName(req.params.userId)} (${req.body.role})`,
      res.locals.actor,
    );
    res.json({ shares: shareList(id) });
  });
  app.delete("/api/rooms/:roomId/shares/:userId", (req, res) => {
    const id = res.locals.workspace.id;
    const name = userName(req.params.userId);
    const removed = rooms.db
      .prepare("DELETE FROM workspace_shares WHERE workspace_id=? AND user_id=?")
      .run(id, req.params.userId).changes;
    if (removed) {
      dropShareSockets(id, req.params.userId);
      rooms.record(id, "share.removed", name, res.locals.actor);
    }
    res.json({ shares: shareList(id) });
  });
  // Team sharing: the workspace owner shares with a team they belong to, as Viewer or Editor.
  // Members get that role while they're members. People with direct Editor access can see
  // the team shares but not change them; team roles never grant sharing management.
  const revalidateWorkspace = (workspaceId: string) =>
    rooms.revalidate(
      workspaceId,
      (hash, user) => accounts.sessionValid(hash, user),
      "Your access to this workspace changed. Refresh to continue.",
    );
  const teamShareList = (workspaceId: string) =>
    rooms.db
      .prepare(
        "SELECT s.team_id AS teamId,t.name,s.role,s.created_at AS createdAt,(SELECT COUNT(*) FROM team_members m WHERE m.team_id=s.team_id) AS memberCount FROM workspace_team_shares s JOIN teams t ON t.id=s.team_id WHERE s.workspace_id=? ORDER BY t.name COLLATE NOCASE",
      )
      .all(workspaceId);
  const TEAM_ID = /^[0-9a-f-]{36}$/;
  app.get("/api/rooms/:roomId/team-shares", (_req, res) => {
    if (!res.locals.canShare) {
      res.status(403).json({ error: "Only the workspace owner and editors can see sharing." });
      return;
    }
    res.json({ teamShares: teamShareList(res.locals.workspace.id) });
  });
  app.use("/api/rooms/:roomId/team-shares", (req, res, next) => {
    if (req.method !== "GET" && res.locals.access !== "owner") {
      res.status(403).json({ error: "Only the workspace owner can share it with a team." });
      return;
    }
    next();
  });
  app.post(
    "/api/rooms/:roomId/team-shares",
    rateLimit({
      windowMs: 10 * 60_000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many sharing changes. Wait a few minutes and try again." },
    }),
    (req, res) => {
      const session = res.locals.session as Session;
      const id = res.locals.workspace.id as string;
      const teamId = String(req.body?.teamId ?? "");
      const role = req.body?.role ?? "viewer";
      if (!isShareRole(role)) throw new Error("Choose Viewer or Editor.");
      // Only teams the owner belongs to (the same 404 for teams that don't exist).
      const team = TEAM_ID.test(teamId)
        ? rooms.db
            .prepare("SELECT t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.team_id=? AND m.user_id=?")
            .get(teamId, session.user.id)
        : undefined;
      if (!team) {
        res.status(404).json({ error: "Choose one of your teams." });
        return;
      }
      const now = Date.now();
      const existed = !!rooms.db.prepare("SELECT 1 FROM workspace_team_shares WHERE workspace_id=? AND team_id=?").get(id, teamId);
      rooms.db
        .prepare(
          "INSERT INTO workspace_team_shares (workspace_id,team_id,role,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,team_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at",
        )
        .run(id, teamId, role, session.user.id, now, now);
      revalidateWorkspace(id);
      rooms.record(id, existed ? "team.changed" : "team.shared", `${team.name} (${role})`, res.locals.actor);
      res.status(existed ? 200 : 201).json({ teamShares: teamShareList(id) });
    },
  );
  app.patch("/api/rooms/:roomId/team-shares/:teamId", (req, res) => {
    const id = res.locals.workspace.id as string, teamId = String(req.params.teamId);
    if (!isShareRole(req.body?.role)) throw new Error("Choose Viewer or Editor.");
    const changed = rooms.db
      .prepare("UPDATE workspace_team_shares SET role=?,updated_at=? WHERE workspace_id=? AND team_id=?")
      .run(req.body.role, Date.now(), id, teamId).changes;
    if (!changed) {
      res.status(404).json({ error: "That team no longer has access." });
      return;
    }
    revalidateWorkspace(id);
    const name = rooms.db.prepare("SELECT name FROM teams WHERE id=?").get(teamId)?.name;
    rooms.record(id, "team.changed", `${name} (${req.body.role})`, res.locals.actor);
    res.json({ teamShares: teamShareList(id) });
  });
  // The owner can remove a team share at any time, even after leaving that team.
  app.delete("/api/rooms/:roomId/team-shares/:teamId", (req, res) => {
    const id = res.locals.workspace.id as string, teamId = String(req.params.teamId);
    const name = rooms.db.prepare("SELECT name FROM teams WHERE id=?").get(teamId)?.name;
    const removed = rooms.db
      .prepare("DELETE FROM workspace_team_shares WHERE workspace_id=? AND team_id=?")
      .run(id, teamId).changes;
    if (removed) {
      revalidateWorkspace(id);
      rooms.record(id, "team.removed", String(name ?? "A team"), res.locals.actor);
    }
    res.json({ teamShares: teamShareList(id) });
  });
  // Folder sharing: one folder (and everything inside it) shared with accounts or teams, as
  // Viewer or Editor, in Restricted workspaces only. Managed by the workspace owner and by
  // people with a direct Editor share of the workspace (canShare). Team-derived Editors, Edit
  // Link guests, workspace Viewers and folder-only recipients never manage it: workspace
  // members get 403, and folder-only recipients the same 404 as a missing workspace (the
  // access gate treats every route here as workspace-level, see scope.ts).
  const FOLDER_ID = /^[\w-]{36}$/;
  const folderShareChanges = rateLimit({
    windowMs: 10 * 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sharing changes. Wait a few minutes and try again." },
  });
  app.use(["/api/rooms/:roomId/folder-shares", "/api/rooms/:roomId/folders/:folderId/shares", "/api/rooms/:roomId/folders/:folderId/team-shares"], (req, res, next) => {
    if (!res.locals.canShare) {
      res.status(403).json({ error: "Only the workspace owner and editors can manage folder sharing." });
      return;
    }
    const folderId = (req.params as Record<string, string | undefined>).folderId;
    if (folderId !== undefined && !FOLDER_ID.test(folderId)) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    if (req.method !== "GET") folderShareChanges(req, res, next);
    else next();
  });
  // Runs a sharing change; refusals keep their status, and an inherited share says where it
  // comes from (inheritedFrom), so a client can point to the parent folder.
  const folderShareCall = (req: express.Request, res: express.Response, change: () => number | void) => {
    try {
      const status = change();
      res.status(typeof status === "number" ? status : 200).json(
        folderSharing.list(res.locals.workspace.id, req.params.folderId as string),
      );
    } catch (error) {
      const e = error as Error & { status?: number; inheritedFrom?: unknown };
      if (!e.status) throw error;
      res.status(e.status).json({ error: e.message, ...(e.inheritedFrom ? { inheritedFrom: e.inheritedFrom } : {}) });
    }
  };
  const folderName = (workspaceId: string, folderId: string) =>
    String(rooms.db.prepare("SELECT name FROM folders WHERE id=? AND workspace_id=?").get(folderId, workspaceId)?.name ?? "A folder");
  app.get("/api/rooms/:roomId/folder-shares", (_req, res) => {
    res.json({ folders: folderSharing.overview(res.locals.workspace.id) });
  });
  app.get("/api/rooms/:roomId/folders/:folderId/shares", (req, res) =>
    folderShareCall(req, res, () => undefined),
  );
  app.post("/api/rooms/:roomId/folders/:folderId/shares", (req, res) =>
    folderShareCall(req, res, () => {
      const session = res.locals.session as Session;
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string;
      const email = validEmail(req.body?.email);
      const role = req.body?.role ?? "viewer";
      const user = rooms.db.prepare("SELECT id,display_name FROM users WHERE email=?").get(email);
      if (!user)
        throw Object.assign(new Error("No Kodelumi account uses that email. Folders can be shared only with Kodelumi accounts."), { status: 404 });
      const existed = folderSharing.shareWithUser(id, folderId, user.id as string, role, session.user.id);
      rooms.record(id, existed ? "folder.share.changed" : "folder.share.added", `${folderName(id, folderId)}: ${user.display_name} (${role})`, res.locals.actor);
      return existed ? 200 : 201;
    }),
  );
  app.patch("/api/rooms/:roomId/folders/:folderId/shares/:userId", (req, res) =>
    folderShareCall(req, res, () => {
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string;
      folderSharing.updateUser(id, folderId, req.params.userId as string, req.body?.role);
      rooms.record(id, "folder.share.changed", `${folderName(id, folderId)}: ${userName(req.params.userId as string)} (${req.body.role})`, res.locals.actor);
    }),
  );
  app.delete("/api/rooms/:roomId/folders/:folderId/shares/:userId", (req, res) =>
    folderShareCall(req, res, () => {
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string;
      folderSharing.revokeUser(id, folderId, req.params.userId as string);
      rooms.record(id, "folder.share.removed", `${folderName(id, folderId)}: ${userName(req.params.userId as string)}`, res.locals.actor);
    }),
  );
  app.post("/api/rooms/:roomId/folders/:folderId/team-shares", (req, res) =>
    folderShareCall(req, res, () => {
      const session = res.locals.session as Session;
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string;
      const teamId = String(req.body?.teamId ?? "");
      const role = req.body?.role ?? "viewer";
      // Only teams the person sharing belongs to (the same 404 for teams that don't exist).
      const team = TEAM_ID.test(teamId)
        ? rooms.db
            .prepare("SELECT t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.team_id=? AND m.user_id=?")
            .get(teamId, session.user.id)
        : undefined;
      if (!team) throw Object.assign(new Error("Choose one of your teams."), { status: 404 });
      const existed = folderSharing.shareWithTeam(id, folderId, teamId, role, session.user.id);
      rooms.record(id, existed ? "folder.team.changed" : "folder.team.shared", `${folderName(id, folderId)}: ${team.name} (${role})`, res.locals.actor);
      return existed ? 200 : 201;
    }),
  );
  app.patch("/api/rooms/:roomId/folders/:folderId/team-shares/:teamId", (req, res) =>
    folderShareCall(req, res, () => {
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string, teamId = String(req.params.teamId);
      folderSharing.updateTeam(id, folderId, teamId, req.body?.role);
      const name = rooms.db.prepare("SELECT name FROM teams WHERE id=?").get(teamId)?.name;
      rooms.record(id, "folder.team.changed", `${folderName(id, folderId)}: ${name} (${req.body.role})`, res.locals.actor);
    }),
  );
  // A manager can remove a folder's team share at any time, even after leaving that team.
  app.delete("/api/rooms/:roomId/folders/:folderId/team-shares/:teamId", (req, res) =>
    folderShareCall(req, res, () => {
      const id = res.locals.workspace.id as string, folderId = req.params.folderId as string, teamId = String(req.params.teamId);
      const name = rooms.db.prepare("SELECT name FROM teams WHERE id=?").get(teamId)?.name;
      folderSharing.revokeTeam(id, folderId, teamId);
      rooms.record(id, "folder.team.removed", `${folderName(id, folderId)}: ${name ?? "A team"}`, res.locals.actor);
    }),
  );
  // Renaming or deleting the workspace itself is a management action.
  const requireManager: express.RequestHandler = (_req, res, next) => {
    if (res.locals.canEdit && !res.locals.canManage) {
      res.status(403).json({
        error: "Only the workspace owner can rename or delete this workspace.",
      });
      return;
    }
    next();
  };
  app.patch("/api/rooms/:roomId", requireManager, (req, res) => {
    const name = req.body.name;
    if (typeof name !== "string" || !name.trim() || name.length > 80)
      throw new Error("Workspace names must be 1–80 characters.");
    const room = res.locals.workspace;
    rooms.db
      .prepare("UPDATE rooms SET name=? WHERE id=?")
      .run(name.trim(), room.id);
    rooms.record(room.id, "workspace.renamed", name.trim(), res.locals.actor);
    for (const session of rooms.active.values())
      if (session.workspaceId === room.id) session.name = name.trim();
    // Open clients re-read the name over REST (it is no longer part of the live lesson).
    rooms.notifyWorkspace(room.id, { workspace: true });
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:roomId", requireManager, (_req, res) => {
    const id = res.locals.workspace.id;
    for (const session of [...rooms.active.values()])
      if (session.workspaceId === id) {
        for (const peer of rooms.sockets(session))
          peer.close(1008, "Workspace deleted by the instructor");
        rooms.release(session);
      }
    rooms.db.prepare("DELETE FROM rooms WHERE id=?").run(id);
    live.workspaceDeleted(id);
    res.json({ ok: true });
  });
  // Inline images: anyone with the workspace link can view; only editors upload.
  const imageUploads = rateLimit({
    windowMs: 10 * 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many images at once. Wait a few minutes and try again." },
  });
  // A new image counts as used, and vouched for, in the lesson it was uploaded into (?folder=,
  // or the root): its uploader had Editor rights there, so it can show at once to that
  // lesson's recipients. The next save keeps the reference only if a document there uses it.
  const uploadedInto = (req: express.Request, workspaceId: string, imageId: string) => {
    const folder = typeof req.query.folder === "string" ? req.query.folder : null;
    if (folder === null || rooms.db.prepare("SELECT 1 FROM folders WHERE id=? AND workspace_id=?").get(folder, workspaceId))
      vouchImages(rooms.db, workspaceId, folder, [imageId]);
  };
  // REST writes vouch for the image links they add the same way live edits do (see
  // Rooms.vouchAdded): only images the writer could already see.
  const vouchWrite = (res: express.Response, room: Room, before: string[], after: string[]) =>
    rooms.vouchAdded(room, before, after, {
      canSeeAll: () => canReadAccess(res.locals.workspaceAccess),
      userId: (res.locals.session as Session | undefined)?.user.id,
    });
  app.get("/api/rooms/:roomId/images/:imageId", (req, res) =>
    images.serve(res.locals.workspace.id, req.params.imageId, res, req.headers["if-none-match"]),
  );
  app.post(
    "/api/rooms/:roomId/images",
    imageUploads,
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const image = images.store(res.locals.workspace.id, data);
      uploadedInto(req, res.locals.workspace.id, image.id);
      rooms.record(res.locals.workspace.id, "image", "Added an image", res.locals.actor);
      res.status(201).json(image);
    },
  );
  app.post("/api/rooms/:roomId/images/import", imageUploads, async (req, res, next) => {
    try {
      if (typeof req.body?.url !== "string" || req.body.url.length > 2048)
        throw Object.assign(new Error("Enter an image link."), { status: 400 });
      const image = images.store(res.locals.workspace.id, await fetchImage(req.body.url));
      uploadedInto(req, res.locals.workspace.id, image.id);
      rooms.record(res.locals.workspace.id, "image", "Added an image", res.locals.actor);
      res.status(201).json(image);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/rooms/:roomId/tree", (_req, res) =>
    res.json(
      lockTree(rooms.tree(res.locals.workspace.id), res.locals.lockSnapshot, res.locals.lockExempt, res.locals.lockDetail),
    ),
  );
  app.post("/api/rooms/:roomId/folders", (req, res) => {
    const workspaceId = res.locals.workspace.id;
    const parent = req.body.parent_id ?? null;
    if (
      parent !== null &&
      (typeof parent !== "string" ||
        !rooms.db
          .prepare("SELECT id FROM folders WHERE id=? AND workspace_id=?")
          .get(parent, workspaceId))
    )
      throw new Error("Parent folder not found in this workspace.");
    const name = filename(req.body.name);
    if (
      Number(
        rooms.db
          .prepare("SELECT COUNT(*) AS n FROM folders WHERE workspace_id=?")
          .get(workspaceId)?.n,
      ) >= 256
    )
      throw new Error("A course supports up to 256 lesson folders.");
    let depth = 0,
      ancestor = parent;
    while (ancestor) {
      if (++depth >= 12) throw new Error("Folders support up to 12 levels.");
      ancestor = rooms.db
        .prepare("SELECT parent_id FROM folders WHERE id=?")
        .get(ancestor)?.parent_id;
    }
    const id = randomUUID(),
      now = Date.now(),
      doc = new Y.Doc();
    doc.getMap("documents");
    const position = Number(
      rooms.db
        .prepare(
          "SELECT COUNT(*) AS n FROM folders WHERE workspace_id=? AND parent_id IS ?",
        )
        .get(workspaceId, parent)?.n,
    );
    rooms.db
      .prepare(
        "INSERT INTO folders(id,workspace_id,parent_id,name,position,created_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        parent,
        name,
        position,
        now,
        now,
        Y.encodeStateAsUpdate(doc),
      );
    doc.destroy();
    rooms.record(workspaceId, "folder.created", name, res.locals.actor);
    rooms.notifyTree(workspaceId, [parent]);
    res.status(201).json({ id });
  });
  app.patch("/api/rooms/:roomId/folders/order", (req, res) => {
    const workspaceId = res.locals.workspace.id,
      parent = req.body.parent_id ?? null,
      ids = req.body.ids;
    const all = rooms.db
      .prepare("SELECT id FROM folders WHERE workspace_id=? AND parent_id IS ? ORDER BY position,id")
      .all(workspaceId, parent)
      .map((row) => row.id as string);
    // Hidden folders aren't listed for people locks restrict: they keep their place.
    const snapshot = res.locals.lockSnapshot as LockSnapshot | undefined;
    const exempt = res.locals.lockExempt as (folderId: string | null) => boolean;
    const siblings = snapshot ? all.filter((id) => exempt(id) || !snapshot.folderState(id).hidden) : all;
    if (
      !Array.isArray(ids) ||
      ids.length !== siblings.length ||
      new Set(ids).size !== siblings.length ||
      ids.some((id) => !siblings.includes(id))
    )
      throw new Error("Provide every sibling folder exactly once.");
    const order = siblings.length === all.length ? (ids as string[]) : mergeOrder(all, new Set(siblings), ids);
    rooms.db.exec("BEGIN IMMEDIATE");
    try {
      order.forEach((id, position) =>
        rooms.db
          .prepare("UPDATE folders SET position=?,updated_at=? WHERE id=?")
          .run(position, Date.now(), id),
      );
      rooms.db.exec("COMMIT");
    } catch (error) {
      rooms.db.exec("ROLLBACK");
      throw error;
    }
    rooms.notifyTree(workspaceId, [parent]);
    res.json({ ok: true });
  });
  app.patch("/api/rooms/:roomId/folders/:id", (req, res) => {
    const name = filename(req.body.name);
    const result = rooms.db
      .prepare(
        "UPDATE folders SET name=?,updated_at=? WHERE id=? AND workspace_id=?",
      )
      .run(name, Date.now(), req.params.id, res.locals.workspace.id);
    if (!result.changes) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    rooms.record(res.locals.workspace.id, "folder.renamed", name, res.locals.actor);
    // The folder itself (a recipient of a shared folder sees its name) and its parent.
    const renamedParent = rooms.db.prepare("SELECT parent_id FROM folders WHERE id=?").get(req.params.id)?.parent_id as string | null;
    rooms.notifyTree(res.locals.workspace.id, [req.params.id, renamedParent ?? null]);
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:roomId/folders/:id", (req, res) => {
    const workspaceId = res.locals.workspace.id;
    const folderName = rooms.db
      .prepare("SELECT name FROM folders WHERE id=? AND workspace_id=?")
      .get(req.params.id, workspaceId)?.name;
    const descendants = rooms.db
      .prepare(
        "WITH RECURSIVE descendants(id) AS (SELECT id FROM folders WHERE id=? AND workspace_id=? UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM descendants",
      )
      .all(req.params.id, workspaceId)
      .map((row) => row.id);
    if (!descendants.length) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }
    // Who hears about it is decided now, while the folder and its shares still exist.
    const deletedParent = rooms.db.prepare("SELECT parent_id FROM folders WHERE id=?").get(req.params.id)?.parent_id as string | null;
    const audience = rooms.treeAudience(workspaceId, [req.params.id, deletedParent ?? null]);
    for (const session of [...rooms.active.values()])
      if (
        session.workspaceId === workspaceId &&
        descendants.includes(session.folderId)
      ) {
        for (const peer of rooms.sockets(session))
          peer.close(1008, "Lesson deleted by the instructor");
        rooms.release(session);
      }
    // Locks of the files inside go with them (folder locks go with the folders, by trigger).
    const removedFiles = rooms.db
      .prepare(
        `SELECT id FROM documents WHERE room_id=? AND folder_id IN (${descendants.map(() => "?").join(",")})`,
      )
      .all(workspaceId, ...descendants)
      .map((row) => row.id as string);
    rooms.db
      .prepare("DELETE FROM folders WHERE id=? AND workspace_id=?")
      .run(req.params.id, workspaceId);
    const deleteFileLock = rooms.db.prepare(
      "DELETE FROM content_locks WHERE workspace_id=? AND target_kind='file' AND target_id=?",
    );
    let locksRemoved = 0;
    for (const file of removedFiles) locksRemoved += Number(deleteFileLock.run(workspaceId, file).changes);
    if (locksRemoved || res.locals.lockSnapshot) locks.changed(workspaceId);
    rooms.record(workspaceId, "folder.deleted", String(folderName), res.locals.actor);
    // Its folder shares went with it (ON DELETE CASCADE): re-check everyone else's rights.
    rooms.revalidate(
      workspaceId,
      (hash, user) => accounts.sessionValid(hash, user),
      "Your access to this workspace changed. Refresh to continue.",
    );
    rooms.sendTree([...audience].filter((peer) => rooms.live.has(peer)));
    res.json({ ok: true });
  });
  app.use("/api/rooms/:roomId", (req, res, next) => {
    const folder = req.query.folder;
    if (
      folder !== undefined &&
      (typeof folder !== "string" || !/^[\w-]{36}$/.test(folder))
    ) {
      res.status(400).json({ error: "Invalid lesson folder." });
      return;
    }
    const room = rooms.get(req.params.roomId, folder as string | undefined);
    if (!room) {
      res.status(404).json({ error: "Lesson folder not found." });
      return;
    }
    room.touched = Date.now();
    res.locals.room = room;
    // Held until the response ends: a request may wait for its body (file uploads) before it
    // uses the lesson, and a held lesson is never unloaded to make space for another.
    const done = rooms.hold(room);
    res.once("finish", done);
    res.once("close", done);
    next();
  });
  app.post("/api/rooms/:roomId/migrate-snippets", (_req, res) => {
    const result = migrateSnippets(res.locals.room);
    if (result.migrated) {
      rooms.save(res.locals.room);
      rooms.record(
        res.locals.room.workspaceId,
        "blocks.migrated",
        `${result.migrated} snippets`,
        res.locals.actor,
      );
      rooms.notifyTree(res.locals.room.workspaceId, [res.locals.room.folderId]);
    }
    res.json(result);
  });
  app.post("/api/rooms/:roomId/documents", fileBody, (req, res) => {
    req.body ??= {};
    if (
      Number(
        rooms.db
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE room_id=?")
          .get(res.locals.workspace.id)?.n,
      ) >= 2048
    )
      throw new Error(
        "A course supports up to 2,048 files. Start another workspace for additional courses.",
      );
    if (req.body.content !== undefined && typeof req.body.content !== "string")
      throw new Error("File content must be text.");
    const content = normalizeNewlines(req.body.content ?? "");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DOCUMENT) throw fileTooLarge(bytes);
    if (content) validateLessonCapacity(res.locals.room, content);
    vouchWrite(res, res.locals.room, [], [content]);
    const id = addDocument(
      res.locals.room,
      filename(req.body.filename),
      language(req.body.language),
      content,
    );
    rooms.save(res.locals.room);
    rooms.record(
      res.locals.room.workspaceId,
      "file.created",
      req.body.filename,
      res.locals.actor,
    );
    rooms.notifyTree(res.locals.room.workspaceId, [res.locals.room.folderId]);
    const version = contentVersion(content);
    res.status(201).set("ETag", `"${version}"`).json({ id, version, bytes });
  });
  // Direct file text access for tools such as Claude Code (by file ID; the lesson is found from
  // the file when ?folder= is omitted). Reading follows workspace read access, like the editor;
  // writing needs Owner or Editor rights (the write guard above refuses viewers).
  const fileRoom = (req: express.Request, res: express.Response) => {
    const id = req.params.id as string;
    let room = res.locals.room as Room;
    if (!room.doc.getMap("documents").has(id) && req.query.folder === undefined) {
      const folder = rooms.db
        .prepare("SELECT folder_id FROM documents WHERE id=? AND room_id=?")
        .get(id, res.locals.workspace.id)?.folder_id;
      if (typeof folder === "string") room = rooms.get(res.locals.workspace.id, folder) ?? room;
    }
    const item = room.doc.getMap<Y.Map<unknown>>("documents").get(id);
    if (!item) {
      res.status(404).json({ error: "File not found." });
      return undefined;
    }
    return { room, item };
  };
  app.get("/api/rooms/:roomId/documents/:id/content", (req, res) => {
    const found = fileRoom(req, res);
    if (!found) return;
    const content = (found.item.get("content") as Y.Text).toString();
    const version = contentVersion(content);
    res.set("ETag", `"${version}"`).json({
      id: req.params.id,
      filename: found.item.get("filename"),
      language: found.item.get("language"),
      folderId: found.room.folderId,
      content,
      version,
      bytes: Buffer.byteLength(content),
      updatedAt: found.item.get("updatedAt"),
    });
  });
  // Replaces a file's text in one Yjs transaction (open editors update live). Optimistic
  // concurrency: the caller names the version it read (If-Match, or "baseVersion" in JSON);
  // a mismatch is refused with 409 and nothing changes. If-Match: * overwrites deliberately.
  app.put("/api/rooms/:roomId/documents/:id/content", fileBody, (req, res) => {
    const found = fileRoom(req, res);
    if (!found) return;
    const raw = typeof req.body === "string" ? req.body : req.body?.content;
    if (typeof raw !== "string")
      throw new Error('Send the file text as text/plain, or as JSON {"content": "..."}.');
    const existing = (found.item.get("content") as Y.Text).toString();
    const content = normalizeNewlines(raw, existing);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DOCUMENT) throw fileTooLarge(bytes);
    validateLessonCapacity(found.room, content, { fileId: req.params.id as string });
    if (Y.encodeStateAsUpdate(found.room.doc).byteLength + bytes > 4 * MAX_CONTENT)
      throw tooLarge("Lesson storage limit exceeded. Export your files or create another lesson.");
    const base = (
      (req.headers["if-match"] as string | undefined) ??
      (typeof req.body === "object" ? req.body?.baseVersion : undefined) ??
      ""
    )
      .trim()
      .replace(/^W\//, "")
      .replace(/^"|"$/g, "");
    const current = contentVersion(existing);
    if (!base) {
      res.status(428).json({
        error:
          "Send the version you are replacing (If-Match header from GET …/content), or If-Match: * to overwrite.",
        version: current,
      });
      return;
    }
    if (base !== "*" && base !== current) {
      res.status(409).json({
        error: "This file changed since you read it. Fetch the latest content and try again.",
        version: current,
      });
      return;
    }
    vouchWrite(res, found.room, [existing], [content]);
    const changed = replaceContent(found.room, req.params.id as string, content);
    if (changed) {
      rooms.noteEdit(found.room, req.params.id as string, res.locals.actor);
      rooms.save(found.room);
    }
    const version = contentVersion(content);
    res.set("ETag", `"${version}"`).json({ id: req.params.id, version, bytes, changed });
  });
  app.patch("/api/rooms/:roomId/documents/order", (req, res) => {
    const room = res.locals.room,
      docs = room.doc.getMap("documents") as Y.Map<Y.Map<unknown>>,
      ids = req.body.ids;
    // People locks restrict here reorder the files they can open; locked files keep their place.
    const snapshot = res.locals.lockSnapshot as LockSnapshot | undefined;
    const exempt = res.locals.lockExempt as (folderId: string | null) => boolean;
    const current = [...docs.entries()]
      .sort(([, a], [, b]) => ((a.get("position") as number) ?? 0) - ((b.get("position") as number) ?? 0))
      .map(([id]) => id);
    const visible =
      snapshot && !exempt(room.folderId)
        ? current.filter((id) => !snapshot.fileState(id, room.folderId).locked)
        : current;
    if (
      !Array.isArray(ids) ||
      ids.length !== visible.length ||
      new Set(ids).size !== visible.length ||
      ids.some((id) => !visible.includes(id))
    )
      throw new Error("Provide every file in this lesson exactly once.");
    const order = visible.length === current.length ? (ids as string[]) : mergeOrder(current, new Set(visible), ids);
    room.doc.transact(() =>
      order.forEach((id, position) => docs.get(id)!.set("position", position)),
    );
    rooms.save(room);
    rooms.notifyTree(room.workspaceId, [room.folderId]);
    res.json({ ok: true });
  });
  app.patch("/api/rooms/:roomId/documents/:id", (req, res) => {
    const room = res.locals.room,
      doc = room.doc.getMap("documents").get(req.params.id) as
        | Y.Map<unknown>
        | undefined;
    if (!doc) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    const name =
        req.body.filename !== undefined
          ? filename(req.body.filename)
          : undefined,
      lang =
        req.body.language !== undefined
          ? language(req.body.language)
          : undefined;
    if (
      name &&
      [...(room.doc as Y.Doc).getMap<Y.Map<unknown>>("documents")].some(
        ([id, item]) => id !== req.params.id && item.get("filename") === name,
      )
    )
      throw new Error("A file with that name already exists in this lesson.");
    room.doc.transact(() => {
      if (name) doc.set("filename", name);
      if (lang) doc.set("language", lang);
      doc.set("updatedAt", Date.now());
    });
    rooms.save(room);
    if (name) rooms.record(room.workspaceId, "file.renamed", name, res.locals.actor);
    rooms.notifyTree(room.workspaceId, [room.folderId]);
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:roomId/documents/:id", (req, res) => {
    const docs = res.locals.room.doc.getMap("documents");
    if (!docs.has(req.params.id)) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    const deletedName = (docs.get(req.params.id) as Y.Map<unknown>).get(
      "filename",
    ) as string;
    docs.delete(req.params.id);
    rooms.save(res.locals.room);
    // A deleted file's lock goes with it.
    if (
      rooms.db
        .prepare("DELETE FROM content_locks WHERE workspace_id=? AND target_kind='file' AND target_id=?")
        .run(res.locals.room.workspaceId, req.params.id).changes
    )
      locks.changed(res.locals.room.workspaceId);
    rooms.record(res.locals.room.workspaceId, "file.deleted", deletedName, res.locals.actor);
    rooms.notifyTree(res.locals.room.workspaceId, [res.locals.room.folderId]);
    res.json({ ok: true });
  });
  app.post("/api/rooms/:roomId/checkpoint", (_req, res) => {
    rooms.save(res.locals.room);
    res.json({ ok: true });
  });
  app.get("/api/rooms/:roomId/blocks", (_req, res) => {
    res.json({ blocks: orderedBlocks(res.locals.room.doc) });
  });
  app.post("/api/rooms/:roomId/blocks", (req, res) => {
    const block = createBlock(res.locals.room, req.body);
    rooms.save(res.locals.room);
    rooms.record(
      res.locals.room.workspaceId,
      "block.created",
      block.title || "Code snippet",
      res.locals.actor,
    );
    res.status(201).json({ id: block.id });
  });
  app.patch("/api/rooms/:roomId/blocks/order", (req, res) => {
    reorderBlocks(res.locals.room, req.body.ids);
    res.json({ ok: true });
  });
  app.patch("/api/rooms/:roomId/blocks/:id", (req, res) => {
    const room = res.locals.room;
    const map = room.doc.getMap("codeBlocks") as Y.Map<CodeBlock>;
    const block = map.get(req.params.id);
    if (!block) {
      res.status(404).json({ error: "Code block not found." });
      return;
    }
    const fields = blockFields({ ...block, ...req.body });
    validateBlockCapacity(room, fields.content, block.id);
    map.set(block.id, { ...block, ...fields, updated_at: Date.now() });
    rooms.save(room);
    rooms.record(
      room.workspaceId,
      "block.updated",
      fields.title || "Code snippet",
      res.locals.actor,
    );
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:roomId/blocks/:id", (req, res) => {
    const room = res.locals.room;
    const map = room.doc.getMap("codeBlocks") as Y.Map<CodeBlock>;
    if (!map.has(req.params.id)) {
      res.status(404).json({ error: "Code block not found." });
      return;
    }
    const deletedTitle = map.get(req.params.id)!.title;
    room.doc.transact(() => {
      map.delete(req.params.id);
      reorderBlocks(
        room,
        orderedBlocks(room.doc).map((block) => block.id),
      );
    });
    rooms.save(room);
    rooms.record(
      room.workspaceId,
      "block.deleted",
      deletedTitle || "Code snippet",
      res.locals.actor,
    );
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  const staticPath =
    options.staticPath ?? resolve(projectRoot, "frontend/dist");
  if (existsSync(staticPath)) {
    app.use(
      express.static(staticPath, {
        maxAge: "1h",
        setHeaders: (res, path) => {
          if (path.endsWith("index.html"))
            res.setHeader("Cache-Control", "no-cache");
        },
      }),
    );
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(staticPath, "index.html")),
    );
  }
  app.use(
    (
      error: Error & { status?: number },
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(error.message);
      // Body-parser refusals get a size message; our own 413s keep their specific text.
      const parserTooLarge =
        (error as { type?: string }).type === "entity.too.large";
      res.status(error.status ?? 400).json({
        error: !parserTooLarge
          ? error.message
          : fileText.test(req.path)
            ? "Files can be up to 1 MB of text."
            : "Request too large.",
      });
    },
  );
  const server = createServer(app),
    wss = setupWebsocket(server, rooms, origins, accounts, (req, socket, head, ws) =>
      live.upgrade(req, socket, head, ws),
    );
  let sweeps = 0;
  const gc = setInterval(() => {
    rooms.collect();
    live.collect();
    try {
      // A safety net for the release timer (a release is applied exactly once either way).
      locks.releaseDue();
    } catch (error) {
      console.error("Scheduled release sweep failed; it runs again shortly.", error);
    }
    outbox.kick();
    if (++sweeps % 240 === 0) accounts.purgeExpired();
  }, 15_000);
  gc.unref();
  let closed = false;
  return {
    app,
    server,
    rooms,
    accounts,
    folderSharing,
    outbox,
    locks,
    live,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(gc);
      locks.stop();
      live.close();
      rooms.close();
      for (const peer of wss.clients) peer.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
