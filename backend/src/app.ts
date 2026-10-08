import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.js";
import { Rooms, addDocument, filename, language } from "./rooms.js";
import { setupWebsocket } from "./websocket.js";
import * as Y from "yjs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  hashEditorToken,
  TOKEN_PATTERN,
  workspaceAccess,
} from "./access.js";
import { Accounts, csrfFor, equalSecret, newToken, type Session } from "./auth.js";
import { accountRoutes, authLimits, type AuthLimits } from "./accountRoutes.js";
import { migrateSnippets } from "./migrate.js";
import { templates } from "./templates.js";
import {
  blockFields,
  createBlock,
  orderedBlocks,
  reorderBlocks,
  validateBlockCapacity,
  type CodeBlock,
} from "./blocks.js";

export function createApp(
  options: {
    dbPath?: string;
    origins?: string[];
    checkpointMs?: number;
    staticPath?: string;
    cookieSecure?: boolean;
    authLimits?: Partial<AuthLimits>;
  } = {},
) {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const rooms = new Rooms(
    openDatabase(
      options.dbPath ??
        process.env.DB_PATH ??
        resolve(projectRoot, "data/devshare.sqlite"),
    ),
    options.checkpointMs,
  );
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
  app.use(express.json({ limit: "128kb" }));
  app.use((req, res, next) => {
    if (
      !/^\/api\/rooms\/[\w-]{16}\/blocks(?:\/|$)/.test(req.path) &&
      Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16 * 1024
    ) {
      res.status(413).json({ error: "Request too large." });
      return;
    }
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
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
      websocketConnections: [...rooms.active.values()].reduce(
        (sum, session) => sum + session.peers.size,
        0,
      ),
      sessions: [...rooms.active.values()].map((session) => ({
        workspaceId: session.workspaceId,
        folderId: session.folderId,
        connections: session.peers.size,
      })),
      persistedWorkspaces: Number(
        rooms.db.prepare("SELECT COUNT(*) AS n FROM rooms").get()?.n,
      ),
    });
  });
  accountRoutes(app, accounts, rooms, origins, {
    ...authLimits(),
    ...options.authLimits,
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
      const room = rooms.create(
        name.trim(),
        language(req.body.language ?? "hcl"),
        null,
        req.body.template,
        description.trim(),
        session.user.id,
      );
      res.status(201).json({ id: room.id, name: room.name });
    },
  );
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
      res
        .status(404)
        .json({ error: "Workspace not found. It may have been deleted." });
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
    if (req.headers.authorization && !linkValid) {
      res.status(403).json({
        error: "This private editor link is invalid or has been revoked.",
      });
      return;
    }
    const session = res.locals.session as Session | undefined;
    const access = workspaceAccess(
      rooms.db,
      (hash, user) => accounts.sessionValid(hash, user),
      room.id as string,
      { userId: session?.user.id, sessionHash: session?.tokenHash, tokenHash },
    );
    res.locals.access = access;
    res.locals.linkValid = linkValid;
    res.locals.canEdit = access !== "viewer";
    // Owners manage their workspace; unclaimed legacy workspaces keep v1 link management.
    res.locals.canManage =
      access === "owner" || (access === "editor" && !room.owner_id);
    next();
  });
  app.get("/api/rooms/:roomId", (_req, res) => {
    const room = res.locals.workspace;
    res.json({
      id: room.id,
      name: room.name,
      description: room.description,
      access: res.locals.access,
      owned: !!room.owner_id,
      // A valid editor link for an unowned workspace can be claimed once.
      claimable: !room.owner_id && res.locals.linkValid,
      ...(res.locals.access === "owner"
        ? { hasEditorLink: !!room.has_editor_link }
        : {}),
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
    rooms.record(room.id, "workspace.claimed", session.user.displayName);
    res.json({ ok: true });
  });
  app.use("/api/rooms/:roomId/editor-link", (_req, res, next) => {
    if (res.locals.access !== "owner") {
      res
        .status(403)
        .json({ error: "Only the workspace owner can manage editor links." });
      return;
    }
    next();
  });
  const dropLinkEditors = (previousHash: unknown) => {
    if (typeof previousHash === "string")
      rooms.disconnect(
        (auth) => auth.tokenHash === previousHash,
        "The private editor link was replaced or revoked",
      );
  };
  // Creates or replaces the private co-editor link; the token is returned only once.
  app.post("/api/rooms/:roomId/editor-link", (_req, res) => {
    const id = res.locals.workspace.id,
      token = newToken(),
      previous = rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(id)?.editor_token_hash;
    rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=? WHERE id=?")
      .run(hashEditorToken(token), id);
    dropLinkEditors(previous);
    rooms.record(id, previous ? "link.replaced" : "link.created", "Editor link");
    res.status(201).json({ token });
  });
  app.delete("/api/rooms/:roomId/editor-link", (_req, res) => {
    const id = res.locals.workspace.id,
      previous = rooms.db
        .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
        .get(id)?.editor_token_hash;
    rooms.db
      .prepare("UPDATE rooms SET editor_token_hash=NULL WHERE id=?")
      .run(id);
    dropLinkEditors(previous);
    if (previous) rooms.record(id, "link.revoked", "Editor link");
    res.json({ ok: true });
  });
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
    rooms.record(room.id, "workspace.renamed", name.trim());
    for (const session of rooms.active.values())
      if (session.workspaceId === room.id) {
        session.name = name.trim();
        session.doc.getMap("workspace").set("name", name.trim());
      }
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:roomId", requireManager, (_req, res) => {
    const id = res.locals.workspace.id;
    for (const session of [...rooms.active.values()])
      if (session.workspaceId === id) {
        for (const peer of session.peers.keys())
          peer.close(1008, "Workspace deleted by the instructor");
        rooms.release(session);
      }
    rooms.db.prepare("DELETE FROM rooms WHERE id=?").run(id);
    res.json({ ok: true });
  });
  app.get("/api/rooms/:roomId/tree", (_req, res) =>
    res.json(rooms.tree(res.locals.workspace.id)),
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
    rooms.record(workspaceId, "folder.created", name);
    rooms.syncCatalog(workspaceId);
    res.status(201).json({ id });
  });
  app.patch("/api/rooms/:roomId/folders/order", (req, res) => {
    const workspaceId = res.locals.workspace.id,
      parent = req.body.parent_id ?? null,
      ids = req.body.ids;
    const siblings = rooms.db
      .prepare("SELECT id FROM folders WHERE workspace_id=? AND parent_id IS ?")
      .all(workspaceId, parent)
      .map((row) => row.id);
    if (
      !Array.isArray(ids) ||
      ids.length !== siblings.length ||
      new Set(ids).size !== siblings.length ||
      ids.some((id) => !siblings.includes(id))
    )
      throw new Error("Provide every sibling folder exactly once.");
    rooms.db.exec("BEGIN IMMEDIATE");
    try {
      ids.forEach((id, position) =>
        rooms.db
          .prepare("UPDATE folders SET position=?,updated_at=? WHERE id=?")
          .run(position, Date.now(), id),
      );
      rooms.db.exec("COMMIT");
    } catch (error) {
      rooms.db.exec("ROLLBACK");
      throw error;
    }
    rooms.syncCatalog(workspaceId);
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
    rooms.record(res.locals.workspace.id, "folder.renamed", name);
    rooms.syncCatalog(res.locals.workspace.id);
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
    for (const session of [...rooms.active.values()])
      if (
        session.workspaceId === workspaceId &&
        descendants.includes(session.folderId)
      ) {
        for (const peer of session.peers.keys())
          peer.close(1008, "Lesson deleted by the instructor");
        rooms.release(session);
      }
    rooms.db
      .prepare("DELETE FROM folders WHERE id=? AND workspace_id=?")
      .run(req.params.id, workspaceId);
    rooms.record(workspaceId, "folder.deleted", String(folderName));
    rooms.syncCatalog(workspaceId);
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
      );
      rooms.syncCatalog(res.locals.room.workspaceId);
    }
    res.json(result);
  });
  app.post("/api/rooms/:roomId/documents", (req, res) => {
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
    const content = req.body.content ?? "";
    if (typeof content !== "string" || Buffer.byteLength(content) > 64 * 1024)
      throw new Error("Initial file content must be text up to 64 KB.");
    if (content) validateBlockCapacity(res.locals.room, content);
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
    );
    rooms.syncCatalog(res.locals.room.workspaceId);
    res.status(201).json({ id });
  });
  app.patch("/api/rooms/:roomId/documents/order", (req, res) => {
    const room = res.locals.room,
      docs = room.doc.getMap("documents") as Y.Map<Y.Map<unknown>>,
      ids = req.body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length !== docs.size ||
      new Set(ids).size !== docs.size ||
      ids.some((id) => !docs.has(id))
    )
      throw new Error("Provide every file in this lesson exactly once.");
    room.doc.transact(() =>
      ids.forEach((id, position) => docs.get(id)!.set("position", position)),
    );
    rooms.save(room);
    rooms.syncCatalog(room.workspaceId);
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
    if (name) rooms.record(room.workspaceId, "file.renamed", name);
    rooms.syncCatalog(room.workspaceId);
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
    rooms.record(res.locals.room.workspaceId, "file.deleted", deletedName);
    rooms.syncCatalog(res.locals.room.workspaceId);
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
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(error.message);
      res.status(error.status ?? 400).json({
        error: error.status === 413 ? "Request too large." : error.message,
      });
    },
  );
  const server = createServer(app),
    wss = setupWebsocket(server, rooms, origins, accounts);
  let sweeps = 0;
  const gc = setInterval(() => {
    rooms.collect();
    if (++sweeps % 240 === 0) accounts.purgeExpired();
  }, 15_000);
  gc.unref();
  let closed = false;
  return {
    app,
    server,
    rooms,
    accounts,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(gc);
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
