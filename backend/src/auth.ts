import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";

// OWASP Argon2id baseline (19 MiB, 2 passes, 1 lane). @node-rs/argon2 defaults to Argon2id
// and emits PHC strings, so stored hashes stay portable between libraries.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

// Bound concurrent hashes so a burst of sign-ins cannot exhaust the 1 GB host.
let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(task: () => Promise<T>) {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}
export const hashPassword = (password: string) =>
  limited(() => hash(password, ARGON2));
export async function verifyPassword(stored: string, password: string) {
  try {
    return await limited(() => verify(stored, password));
  } catch {
    return false;
  }
}
// Used for unknown emails so response timing does not reveal registered accounts.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
}

export class InputError extends Error {
  status = 400;
}
const fail = (message: string): never => {
  throw new InputError(message);
};
const common = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "1q2w3e4r5t",
  "iloveyou12",
  "letmein123",
  "welcome123",
  "devshare123",
  "administrator",
  "passw0rd123",
  "abcdefghij",
]);
export function validEmail(value: unknown) {
  if (typeof value !== "string") return fail("Enter your email address.");
  const email = value.trim();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[<>()[\]\\,;:"]/.test(email)
  )
    fail("Enter a valid email address.");
  return email;
}
export function validDisplayName(value: unknown) {
  if (typeof value !== "string") return fail("Enter your display name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f<>]/.test(name))
    fail("Display names must be 1–60 characters without < or >.");
  return name;
}
export function validNewPassword(
  password: unknown,
  confirm: unknown,
  context: string[] = [],
) {
  if (typeof password !== "string" || password.length < 10)
    fail("Use a password of at least 10 characters.");
  const value = password as string;
  if (value.length > 128) fail("Passwords must be at most 128 characters.");
  if (confirm !== value) fail("The passwords do not match.");
  const lower = value.toLowerCase();
  if (
    common.has(lower) ||
    /^(.)\1+$/.test(value) ||
    context
      .flatMap((item) => item.split(/[\s._@-]+/))
      .some((item) => item.length >= 4 && lower.includes(item.toLowerCase()))
  )
    fail("Choose a less predictable password.");
  return value;
}

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
// The CSRF secret is derived from the session token, so it needs no storage and is
// unknowable to other origins, which cannot read the HttpOnly cookie.
export const csrfFor = (sessionToken: string) =>
  createHash("sha256").update("csrf:" + sessionToken).digest("base64url");
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type User = {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
};
export type Session = { tokenHash: string; user: User; token: string };

export class Accounts {
  constructor(
    public db: DatabaseSync,
    public cookieSecure: boolean,
  ) {}
  get cookieName() {
    // __Host- requires Secure; the plain-HTTP local preview uses a regular name.
    return this.cookieSecure ? "__Host-devshare_sid" : "devshare_sid";
  }
  async create(displayName: string, email: string, password: string) {
    if (this.db.prepare("SELECT 1 FROM users WHERE email=?").get(email))
      fail("An account with this email already exists. Sign in instead.");
    const id = randomUUID(),
      now = Date.now(),
      passwordHash = await hashPassword(password);
    this.db
      .prepare(
        "INSERT INTO users (id,email,display_name,password_hash,created_at,updated_at,password_changed_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, email, displayName, passwordHash, now, now, now);
    return this.user(id)!;
  }
  user(id: string): User | undefined {
    const row = this.db
      .prepare("SELECT id,email,display_name,created_at FROM users WHERE id=?")
      .get(id);
    return row
      ? {
          id: row.id as string,
          email: row.email as string,
          displayName: row.display_name as string,
          createdAt: row.created_at as number,
        }
      : undefined;
  }
  async authenticate(email: string, password: string) {
    const row = this.db
      .prepare("SELECT id,password_hash FROM users WHERE email=?")
      .get(email);
    if (!row) {
      await burnPasswordCheck(password);
      return undefined;
    }
    return (await verifyPassword(row.password_hash as string, password))
      ? this.user(row.id as string)
      : undefined;
  }
  async checkPassword(userId: string, password: string) {
    const row = this.db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(userId);
    return !!row && (await verifyPassword(row.password_hash as string, password));
  }
  async setPassword(userId: string, password: string) {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE users SET password_hash=?,password_changed_at=?,updated_at=? WHERE id=?",
      )
      .run(await hashPassword(password), now, now, userId);
  }
  startSession(userId: string) {
    const token = newToken(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash,user_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)",
      )
      .run(sha256(token), userId, now, now, now + SESSION_MAX_MS);
    return token;
  }
  // Returns the session for a raw cookie token, enforcing idle and absolute expiry.
  session(token: string | undefined): Session | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const tokenHash = sha256(token),
      now = Date.now();
    const row = this.db
      .prepare(
        "SELECT user_id,last_seen_at,expires_at FROM sessions WHERE token_hash=?",
      )
      .get(tokenHash);
    if (!row) return undefined;
    if (
      (row.expires_at as number) <= now ||
      (row.last_seen_at as number) + SESSION_IDLE_MS <= now
    ) {
      this.endSession(tokenHash);
      return undefined;
    }
    if (now - (row.last_seen_at as number) > TOUCH_INTERVAL_MS)
      this.db
        .prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?")
        .run(now, tokenHash);
    const user = this.user(row.user_id as string);
    return user ? { tokenHash, user, token } : undefined;
  }
  // Cheap revalidation for long-lived WebSockets.
  sessionValid(tokenHash: string, userId: string) {
    const row = this.db
      .prepare(
        "SELECT last_seen_at,expires_at FROM sessions WHERE token_hash=? AND user_id=?",
      )
      .get(tokenHash, userId);
    const now = Date.now();
    return (
      !!row &&
      (row.expires_at as number) > now &&
      (row.last_seen_at as number) + SESSION_IDLE_MS > now
    );
  }
  endSession(tokenHash: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }
  // Ends every session of a user except `keep`; returns the ended hashes.
  endOtherSessions(userId: string, keep?: string) {
    const ended = this.db
      .prepare("SELECT token_hash FROM sessions WHERE user_id=? AND token_hash IS NOT ?")
      .all(userId, keep ?? null)
      .map((row) => row.token_hash as string);
    this.db
      .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash IS NOT ?")
      .run(userId, keep ?? null);
    return ended;
  }
  // Operator-issued reset links: single use, short-lived, stored only as a hash.
  issueReset(userId: string) {
    const token = newToken(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO password_resets (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)",
      )
      .run(sha256(token), userId, now, now + RESET_TTL_MS);
    return token;
  }
  resetTarget(token: unknown) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return undefined;
    const row = this.db
      .prepare(
        "SELECT user_id,expires_at,used_at FROM password_resets WHERE token_hash=?",
      )
      .get(sha256(token));
    if (!row || row.used_at !== null || (row.expires_at as number) <= Date.now())
      return undefined;
    return this.user(row.user_id as string);
  }
  consumeReset(token: string) {
    // The conditional update makes consumption atomic: only one request can win.
    return (
      this.db
        .prepare(
          "UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
        )
        .run(Date.now(), sha256(token), Date.now()).changes === 1
    );
  }
  purgeExpired() {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at<=? OR last_seen_at<=?")
      .run(now, now - SESSION_IDLE_MS);
    this.db
      .prepare("DELETE FROM password_resets WHERE expires_at<=?")
      .run(now - 24 * 60 * 60 * 1000);
  }
  cookie(token: string) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_MS / 1000}${this.cookieSecure ? "; Secure" : ""}`;
  }
  clearCookie() {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }
  tokenFrom(req: IncomingMessage) {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const index = part.indexOf("=");
      if (index > 0 && part.slice(0, index).trim() === this.cookieName)
        return part.slice(index + 1).trim();
    }
    return undefined;
  }
}

// Fixed-window failure counter per key (e.g. email), bounded in size.
export class FailureLimiter {
  private entries = new Map<string, { count: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  blocked(key: string) {
    const entry = this.entries.get(key);
    return !!entry && entry.reset > Date.now() && entry.count >= this.limit;
  }
  fail(key: string) {
    const now = Date.now();
    if (this.entries.size > 10_000)
      for (const [k, v] of this.entries) if (v.reset <= now) this.entries.delete(k);
    const entry = this.entries.get(key);
    if (!entry || entry.reset <= now)
      this.entries.set(key, { count: 1, reset: now + this.windowMs });
    else entry.count++;
  }
  clear(key: string) {
    this.entries.delete(key);
  }
}
