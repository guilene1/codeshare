import type express from "express";
import rateLimit from "express-rate-limit";
import {
  csrfFor,
  FailureLimiter,
  validDisplayName,
  validEmail,
  validNewPassword,
  type Accounts,
  type Session,
} from "./auth.js";
import type { Rooms } from "./rooms.js";
import type { EmailOutbox } from "./mailer.js";

export type AuthLimits = {
  signupPerHour: number;
  signinPer15Min: number;
  failuresPerEmail: number;
};
export function authLimits(): AuthLimits {
  const number = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    signupPerHour: number("AUTH_SIGNUP_PER_HOUR", 10),
    signinPer15Min: number("AUTH_SIGNIN_PER_15MIN", 20),
    failuresPerEmail: number("AUTH_FAILURES_PER_EMAIL", 10),
  };
}
const limiter = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again." },
  });
const profile = (session: Session | Pick<Session, "user">) => ({
  id: session.user.id,
  email: session.user.email,
  displayName: session.user.displayName,
  createdAt: session.user.createdAt,
});

export function accountRoutes(
  app: express.Express,
  accounts: Accounts,
  rooms: Rooms,
  origins: Set<string>,
  outbox: EmailOutbox,
  limits: AuthLimits,
) {
  const failures = new FailureLimiter(limits.failuresPerEmail, 15 * 60_000);
  // Sign-in/up have no session yet, so require a same-site Origin (login CSRF).
  const sameOrigin: express.RequestHandler = (req, res, next) => {
    if (!req.headers.origin || !origins.has(req.headers.origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    next();
  };
  const requireSession: express.RequestHandler = (_req, res, next) => {
    if (!res.locals.session) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    next();
  };
  const begin = (res: express.Response, userId: string) => {
    const token = accounts.startSession(userId);
    res.append("Set-Cookie", accounts.cookie(token));
    return { user: profile({ user: accounts.user(userId)! }), csrfToken: csrfFor(token) };
  };
  const endSessions = (hashes: string[], reason: string) => {
    if (hashes.length)
      rooms.disconnect(
        (auth) => !!auth.sessionHash && hashes.includes(auth.sessionHash),
        reason,
      );
  };

  app.get("/api/auth/me", (_req, res) => {
    const session = res.locals.session as Session | undefined;
    res.json(
      session
        ? { user: profile(session), csrfToken: csrfFor(session.token) }
        : { user: null },
    );
  });
  app.post(
    "/api/auth/signup",
    limiter(60 * 60_000, limits.signupPerHour),
    sameOrigin,
    async (req, res, next) => {
      try {
        const displayName = validDisplayName(req.body.displayName),
          email = validEmail(req.body.email),
          password = validNewPassword(
            req.body.password,
            req.body.confirmPassword,
            [email.split("@")[0], displayName],
          );
        const user = await accounts.create(displayName, email, password);
        res.status(201).json(begin(res, user.id));
        // Emails are queued after the account exists and sent in the background;
        // a mail problem can never undo or delay the registration.
        outbox.enqueueSignup(user);
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/auth/signin",
    limiter(15 * 60_000, limits.signinPer15Min),
    sameOrigin,
    async (req, res, next) => {
      try {
        const email =
          typeof req.body.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "";
        const password =
          typeof req.body.password === "string" ? req.body.password : "";
        if (!email || !password || password.length > 128) {
          res.status(400).json({ error: "Enter your email and password." });
          return;
        }
        if (failures.blocked(email)) {
          res.status(429).json({
            error: "Too many failed attempts for this account. Try again in 15 minutes.",
          });
          return;
        }
        const user = await accounts.authenticate(email, password);
        if (!user) {
          failures.fail(email);
          res.status(401).json({ error: "Email or password is incorrect." });
          return;
        }
        failures.clear(email);
        const previous = res.locals.session as Session | undefined;
        if (previous) accounts.endSession(previous.tokenHash);
        res.json(begin(res, user.id));
      } catch (error) {
        next(error);
      }
    },
  );
  app.post("/api/auth/signout", (_req, res) => {
    const session = res.locals.session as Session | undefined;
    if (session) {
      accounts.endSession(session.tokenHash);
      endSessions([session.tokenHash], "Signed out");
    }
    res.append("Set-Cookie", accounts.clearCookie());
    res.json({ ok: true });
  });
  app.post("/api/auth/signout-others", requireSession, (_req, res) => {
    const session = res.locals.session as Session;
    endSessions(
      accounts.endOtherSessions(session.user.id, session.tokenHash),
      "Signed out on another device",
    );
    res.json({ ok: true });
  });
  app.post(
    "/api/auth/password",
    limiter(15 * 60_000, 10),
    requireSession,
    async (req, res, next) => {
      try {
        const session = res.locals.session as Session;
        if (
          typeof req.body.currentPassword !== "string" ||
          !(await accounts.checkPassword(session.user.id, req.body.currentPassword))
        ) {
          res.status(403).json({ error: "Your current password is incorrect." });
          return;
        }
        const password = validNewPassword(
          req.body.newPassword,
          req.body.confirmPassword,
          [session.user.email.split("@")[0], session.user.displayName],
        );
        await accounts.setPassword(session.user.id, password);
        // A password change signs out every other device.
        endSessions(
          accounts.endOtherSessions(session.user.id, session.tokenHash),
          "Password changed",
        );
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    },
  );
  app.patch(
    "/api/account",
    limiter(15 * 60_000, 20),
    requireSession,
    async (req, res, next) => {
      try {
        const session = res.locals.session as Session;
        const displayName =
          req.body.displayName !== undefined
            ? validDisplayName(req.body.displayName)
            : undefined;
        const email =
          req.body.email !== undefined ? validEmail(req.body.email) : undefined;
        if (email && email.toLowerCase() !== session.user.email.toLowerCase()) {
          if (
            typeof req.body.currentPassword !== "string" ||
            !(await accounts.checkPassword(session.user.id, req.body.currentPassword))
          ) {
            res.status(403).json({
              error: "Enter your current password to change your email.",
            });
            return;
          }
          if (
            accounts.db
              .prepare("SELECT 1 FROM users WHERE email=? AND id<>?")
              .get(email, session.user.id)
          ) {
            res.status(409).json({ error: "That email is already in use." });
            return;
          }
        }
        accounts.db
          .prepare(
            "UPDATE users SET display_name=COALESCE(?,display_name),email=COALESCE(?,email),updated_at=? WHERE id=?",
          )
          .run(displayName ?? null, email ?? null, Date.now(), session.user.id);
        res.json({ user: profile({ user: accounts.user(session.user.id)! }) });
      } catch (error) {
        next(error);
      }
    },
  );
  app.get("/api/auth/reset/:token", limiter(15 * 60_000, 30), (req, res) => {
    const user = accounts.resetTarget(req.params.token);
    if (!user) {
      res.status(404).json({
        error: "This reset link is invalid, expired or already used. Ask your administrator for a new one.",
      });
      return;
    }
    res.json({ email: user.email });
  });
  app.post(
    "/api/auth/reset",
    limiter(15 * 60_000, 10),
    sameOrigin,
    async (req, res, next) => {
      try {
        const user = accounts.resetTarget(req.body.token);
        if (!user) {
          res.status(404).json({
            error: "This reset link is invalid, expired or already used. Ask your administrator for a new one.",
          });
          return;
        }
        const password = validNewPassword(
          req.body.newPassword,
          req.body.confirmPassword,
          [user.email.split("@")[0], user.displayName],
        );
        if (!accounts.consumeReset(req.body.token)) {
          res.status(404).json({ error: "This reset link has already been used." });
          return;
        }
        await accounts.setPassword(user.id, password);
        endSessions(accounts.endOtherSessions(user.id), "Password reset");
        res.json(begin(res, user.id));
      } catch (error) {
        next(error);
      }
    },
  );
  // The signed-in user's own workspaces only; never includes editor credentials.
  app.get("/api/me/workspaces", requireSession, (_req, res) => {
    const session = res.locals.session as Session;
    const count = (sql: string, id: string) =>
      Number(rooms.db.prepare(sql).get(id)?.n);
    res.json({
      workspaces: rooms.db
        .prepare(
          "SELECT id,name,description,created_at,updated_at,editor_token_hash IS NOT NULL AS has_editor_link FROM rooms WHERE owner_id=? ORDER BY updated_at DESC",
        )
        .all(session.user.id)
        .map((row) => ({
          id: row.id as string,
          name: row.name,
          description: row.description,
          created_at: row.created_at,
          updated_at: row.updated_at,
          hasEditorLink: !!row.has_editor_link,
          files: count("SELECT COUNT(*) AS n FROM documents WHERE room_id=?", row.id as string),
          folders: count("SELECT COUNT(*) AS n FROM folders WHERE workspace_id=?", row.id as string),
          activity: rooms.db
            .prepare(
              "SELECT id,action,label,created_at FROM activity WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5",
            )
            .all(row.id as string),
        })),
    });
  });
}
