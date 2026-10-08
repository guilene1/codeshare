import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { sha256 } from "../src/auth.js";
import { PASSWORD, signUp } from "./helpers.js";

const origin = "http://localhost:5173";
async function start(options: Parameters<typeof createApp>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "devshare-accounts-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], ...options });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    app,
    base,
    call,
    async stop() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const cookieOf = (response: Response) =>
  response.headers.get("set-cookie")!.split(";")[0];

test("registration validates input, hashes with Argon2id and issues a hardened session cookie", async () => {
  const s = await start({ cookieSecure: true, authLimits: { signupPerHour: 50 } });
  try {
    const attempt = (body: Record<string, unknown>) => s.call("/auth/signup", "POST", body);
    const valid = {
      displayName: "Ada Lovelace",
      email: "Ada@Example.test",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    };
    for (const [patch, message] of [
      [{ password: "short", confirmPassword: "short" }, /at least 10/],
      [{ confirmPassword: PASSWORD + "x" }, /do not match/],
      [{ email: "not-an-email" }, /valid email/],
      [{ displayName: " " }, /1–60/],
      [{ displayName: "<script>" }, /without < or >/],
      [{ password: "password123", confirmPassword: "password123" }, /less predictable/],
      [{ password: "ada@lovelace-secret", confirmPassword: "ada@lovelace-secret" }, /less predictable/],
    ] as const) {
      const response = await attempt({ ...valid, ...patch });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, message);
    }
    const response = await attempt(valid);
    assert.equal(response.status, 201);
    const setCookie = response.headers.get("set-cookie")!;
    assert.match(setCookie, /^__Host-devshare_sid=[A-Za-z0-9_-]{43};/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      assert.ok(setCookie.includes(flag), flag);
    const body = (await response.json()) as { user: { email: string }; csrfToken: string };
    assert.equal(body.user.email, "Ada@Example.test");
    assert.ok(!JSON.stringify(body).includes(PASSWORD));
    const row = s.app.rooms.db
      .prepare("SELECT password_hash FROM users")
      .get() as { password_hash: string };
    assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
    // Session tokens are stored only as SHA-256 hashes.
    const token = setCookie.split(";")[0].split("=")[1];
    const stored = s.app.rooms.db.prepare("SELECT token_hash FROM sessions").all();
    assert.deepEqual(stored.map((r) => r.token_hash), [sha256(token)]);
    // Duplicate emails are rejected case-insensitively.
    assert.equal((await attempt({ ...valid, email: "ada@example.TEST" })).status, 400);
    // Sign-up requires an allowed Origin (login CSRF).
    const noOrigin = await fetch(s.base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, email: "y@example.test" }),
    });
    assert.equal(noOrigin.status, 403);
  } finally {
    await s.stop();
  }
});

test("sign-in, sign-out, CSRF enforcement, failure lockout and session expiry", async () => {
  const s = await start({ authLimits: { failuresPerEmail: 3 } });
  try {
    const owner = await signUp(s.base, origin, "Grace Hopper");
    const signin = (password: string, email = owner.email) =>
      s.call("/auth/signin", "POST", { email, password });
    const wrong = await signin("not-the-password");
    const unknown = await signin(PASSWORD, "nobody@example.test");
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    // Identical responses for wrong password and unknown account.
    assert.deepEqual(await wrong.json(), await unknown.json());
    const ok = await signin(PASSWORD, owner.email.toUpperCase());
    assert.equal(ok.status, 200);
    const cookie = cookieOf(ok),
      { csrfToken } = (await ok.json()) as { csrfToken: string };
    const me = await (await s.call("/auth/me", "GET", undefined, { cookie })).json();
    assert.equal(me.user.displayName, "Grace Hopper");
    assert.equal(me.csrfToken, csrfToken);
    // Cookie-authenticated writes need the CSRF header and an allowed Origin.
    const create = (headers: Record<string, string>) =>
      fetch(s.base + "/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ name: "CSRF probe" }),
      });
    assert.equal((await create({ origin, cookie })).status, 403);
    assert.equal(
      (await create({ origin, cookie, "x-csrf-token": csrfToken.slice(1) + "A" })).status,
      403,
    );
    assert.equal((await create({ cookie, "x-csrf-token": csrfToken })).status, 403);
    assert.equal(
      (await create({ origin: "https://evil.example", cookie, "x-csrf-token": csrfToken }))
        .status,
      403,
    );
    assert.equal((await create({ origin, cookie, "x-csrf-token": csrfToken })).status, 201);
    // Sign-out ends the session on the server.
    const out = await s.call("/auth/signout", "POST", {}, { cookie, "x-csrf-token": csrfToken });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await (await s.call("/auth/me", "GET", undefined, { cookie })).json()).user, null);
    // Repeated failures lock the account temporarily, even with the right password.
    for (let i = 0; i < 3; i++) await signin("wrong-password-" + i);
    assert.equal((await signin(PASSWORD)).status, 429);
    // Idle and absolute expiry.
    const fresh = await signUp(s.base, origin, "Idle User");
    const hash = sha256(fresh.cookie.split("=")[1]);
    s.app.rooms.db
      .prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?")
      .run(Date.now() - 15 * 24 * 3600 * 1000, hash);
    assert.equal(
      (await (await s.call("/auth/me", "GET", undefined, { cookie: fresh.cookie })).json()).user,
      null,
    );
    const later = await signUp(s.base, origin, "Expired User");
    s.app.rooms.db
      .prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?")
      .run(Date.now() - 1, sha256(later.cookie.split("=")[1]));
    assert.equal(
      (await (await s.call("/auth/me", "GET", undefined, { cookie: later.cookie })).json()).user,
      null,
    );
  } finally {
    await s.stop();
  }
});

test("password change, profile update and administrator-issued reset links", async () => {
  const s = await start({ authLimits: { signupPerHour: 20 } });
  try {
    const owner = await signUp(s.base, origin, "Alan Turing");
    const second = await (
      await s.call("/auth/signin", "POST", { email: owner.email, password: PASSWORD })
    );
    const otherCookie = cookieOf(second);
    const authed = (path: string, method: string, body?: unknown) =>
      s.call(path, method, body, owner.headers);
    const next = "Enigma-Machine-1942!";
    assert.equal(
      (await authed("/auth/password", "POST", {
        currentPassword: "wrong-password",
        newPassword: next,
        confirmPassword: next,
      })).status,
      403,
    );
    assert.equal(
      (await authed("/auth/password", "POST", {
        currentPassword: PASSWORD,
        newPassword: next,
        confirmPassword: next,
      })).status,
      200,
    );
    // Other devices are signed out; the current one stays signed in.
    assert.equal(
      (await (await s.call("/auth/me", "GET", undefined, { cookie: otherCookie })).json()).user,
      null,
    );
    assert.ok((await (await s.call("/auth/me", "GET", undefined, { cookie: owner.cookie })).json()).user);
    assert.equal(
      (await s.call("/auth/signin", "POST", { email: owner.email, password: PASSWORD })).status,
      401,
    );
    assert.equal(
      (await s.call("/auth/signin", "POST", { email: owner.email, password: next })).status,
      200,
    );
    // Profile: display name freely, email only with the current password.
    const renamed = await authed("/account", "PATCH", { displayName: "A. M. Turing" });
    assert.equal(((await renamed.json()) as { user: { displayName: string } }).user.displayName, "A. M. Turing");
    assert.equal(
      (await authed("/account", "PATCH", { email: "alan@example.test" })).status,
      403,
    );
    assert.equal(
      (await authed("/account", "PATCH", { email: "alan@example.test", currentPassword: next })).status,
      200,
    );
    // Reset links: single use, expiring, and they sign out every session.
    const token = s.app.accounts.issueReset(owner.user.id);
    assert.ok(!JSON.stringify(s.app.rooms.db.prepare("SELECT * FROM password_resets").all()).includes(token));
    assert.equal((await s.call("/auth/reset/" + token)).status, 200);
    const reset = "Bletchley-Park-Reset-9";
    const used = await s.call("/auth/reset", "POST", {
      token,
      newPassword: reset,
      confirmPassword: reset,
    });
    assert.equal(used.status, 200);
    assert.equal(
      (await (await s.call("/auth/me", "GET", undefined, { cookie: owner.cookie })).json()).user,
      null,
    );
    assert.equal(
      (await s.call("/auth/reset", "POST", { token, newPassword: reset + "x", confirmPassword: reset + "x" })).status,
      404,
    );
    assert.equal(
      (await s.call("/auth/signin", "POST", { email: "alan@example.test", password: reset })).status,
      200,
    );
    const expired = s.app.accounts.issueReset(owner.user.id);
    s.app.rooms.db.prepare("UPDATE password_resets SET expires_at=? WHERE used_at IS NULL").run(Date.now() - 1);
    assert.equal((await s.call("/auth/reset/" + expired)).status, 404);
    assert.equal((await s.call("/auth/reset/not-a-token")).status, 404);
  } finally {
    await s.stop();
  }
});

test("sign-up is rate limited per client", async () => {
  const s = await start({ authLimits: { signupPerHour: 2 } });
  try {
    await signUp(s.base, origin);
    await signUp(s.base, origin);
    const third = await s.call("/auth/signup", "POST", {
      displayName: "Third",
      email: "third@example.test",
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    assert.equal(third.status, 429);
  } finally {
    await s.stop();
  }
});
