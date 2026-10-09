import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import {
  classifyResendError,
  createMailer,
  emailConfig,
  ResendMailer,
  SesMailer,
  type EmailConfig,
} from "../src/mailer.js";
import { PASSWORD } from "./helpers.js";

const origin = "http://localhost:5173";
const ADMINS = ["guilene.tiako@utrains.org", "serge.kamgang@utrains.org"];
const API_KEY = "re_test_SECRET_9f8e7d6c5b4a";
const CONFIG: EmailConfig = {
  enabled: true,
  provider: "resend",
  region: "us-east-1",
  from: "Kodelumi <no-reply@kodelumi.com>",
  replyTo: ["guilene.tiako@utrains.org"],
  admins: ADMINS,
  appUrl: "https://kodelumi.com",
};

// Stub of the Resend API, including its 24-hour idempotency behaviour.
class FakeResend {
  requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  delivered: Array<Record<string, unknown>> = [];
  queue: Array<{ status: number; body: Record<string, unknown> } | "network"> = [];
  private seen = new Map<string, string>();
  fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init!.headers as Record<string, string>));
    const body = JSON.parse(String(init!.body));
    this.requests.push({ url: String(url), headers, body });
    const next = this.queue.shift();
    if (next === "network") throw new TypeError("fetch failed");
    if (next) return new Response(JSON.stringify(next.body), { status: next.status });
    const key = headers["idempotency-key"];
    if (key && this.seen.has(key)) return Response.json({ id: this.seen.get(key) });
    const id = "re_msg_" + (this.delivered.length + 1);
    this.delivered.push(body);
    if (key) this.seen.set(key, id);
    return Response.json({ id });
  };
}

async function start(resend: FakeResend, apiKey: string | null = API_KEY) {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-resend-"));
  const logs: string[] = [];
  const make = () =>
    createApp({
      dbPath: join(dir, "db.sqlite"),
      origins: [origin],
      authLimits: { signupPerHour: 100 },
      email: CONFIG,
      mailer: new ResendMailer(CONFIG, apiKey ?? undefined, resend.fetch as typeof fetch),
      outbox: { minIntervalMs: 0, backoffMs: [20, 20, 20], log: (line) => logs.push(line) },
    });
  let app = make();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const signup = (displayName: string, email: string) =>
    fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/auth/signup`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ displayName, email, password: PASSWORD, confirmPassword: PASSWORD }),
    });
  const rows = () =>
    app.rooms.db
      .prepare("SELECT id,kind,recipient,status,attempts,last_error,message_id,next_attempt_at FROM email_outbox ORDER BY created_at, recipient")
      .all() as Array<{ id: string; kind: string; recipient: string; status: string; attempts: number; last_error: string | null; message_id: string | null; next_attempt_at: number }>;
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await app.outbox.drain();
      const busy = rows().some((r) => r.status === "sending" || (r.status === "pending" && r.next_attempt_at <= Date.now() + 100));
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return {
    get app() {
      return app;
    },
    signup,
    rows,
    settle,
    logs,
    async restart() {
      await app.close();
      app = make();
      await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    },
    async stop() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const secretFree = (s: { logs: string[]; rows: () => Array<{ last_error: string | null }> }) => {
  for (const line of s.logs) assert.ok(!line.includes(API_KEY), "API key in logs");
  for (const row of s.rows()) assert.ok(!(row.last_error ?? "").includes(API_KEY), "API key in outbox");
};

test("Resend: welcome to the new user and notifications to both administrators", async () => {
  const resend = new FakeResend();
  const s = await start(resend);
  try {
    assert.equal((await s.signup("Ada Lovelace", "ada@example.test")).status, 201);
    await s.settle();
    assert.equal(resend.requests.length, 3);
    for (const r of resend.requests) {
      assert.equal(r.url, "https://api.resend.com/emails");
      assert.equal(r.headers.authorization, `Bearer ${API_KEY}`);
      assert.match(r.headers["idempotency-key"], /^kodelumi-outbox-[0-9a-f-]{36}$/);
      assert.equal(r.body.from, "Kodelumi <no-reply@kodelumi.com>");
      assert.deepEqual(r.body.reply_to, ["guilene.tiako@utrains.org"]);
      assert.equal((r.body.to as string[]).length, 1);
      assert.ok(String(r.body.html).includes("kodelumi-email-logo.png"));
      assert.ok(String(r.body.text).length > 50);
      assert.ok(!JSON.stringify(r.body).includes("—"), "no em dash");
      assert.ok(!JSON.stringify(r.body).includes(API_KEY), "API key never in the message");
    }
    const welcome = resend.requests.find((r) => (r.body.to as string[])[0] === "ada@example.test")!;
    assert.equal(welcome.body.subject, "Welcome to Kodelumi, Ada Lovelace!");
    assert.ok(String(welcome.body.html).includes('href="https://kodelumi.com/workspaces"'));
    const admins = resend.requests.filter((r) => String(r.body.subject).startsWith("New Kodelumi signup"));
    assert.deepEqual(admins.map((r) => (r.body.to as string[])[0]).sort(), ADMINS);
    assert.ok(admins.every((r) => String(r.body.text).includes("Email: ada@example.test")));
    assert.deepEqual(s.rows().map((r) => r.status), ["sent", "sent", "sent"]);
    assert.ok(s.rows().every((r) => /^re_msg_\d$/.test(r.message_id!)));
    secretFree(s);
  } finally {
    await s.stop();
  }
});

test("Resend: temporary errors retry with the same idempotency key; permanent errors stop", async () => {
  const resend = new FakeResend();
  resend.queue.push(
    { status: 429, body: { name: "rate_limit_exceeded", message: "Too many requests" } },
    { status: 500, body: { name: "application_error", message: "Unexpected" } },
    "network",
  );
  const s = await start(resend);
  try {
    assert.equal((await s.signup("Grace Hopper", "grace@example.test")).status, 201);
    await s.settle();
    assert.equal(resend.delivered.length, 3, "all delivered after retries");
    // Every attempt for one outbox row carries that row's key.
    const keysByRecipient = new Map<string, Set<string>>();
    for (const r of resend.requests) {
      const to = (r.body.to as string[])[0];
      keysByRecipient.set(to, (keysByRecipient.get(to) ?? new Set()).add(r.headers["idempotency-key"]));
    }
    assert.ok([...keysByRecipient.values()].every((keys) => keys.size === 1));
    assert.ok(resend.requests.length >= 6, "three failures were retried");
    assert.ok(s.logs.some((l) => /will be retried .*rate_limit_exceeded/.test(l)));
    // Permanent: an unverified domain and a validation error fail once and are not retried.
    resend.queue.push(
      { status: 403, body: { name: "validation_error", message: "The kodelumi.com domain is not verified." } },
      { status: 422, body: { name: "missing_required_field", message: "Missing to" } },
    );
    const before = resend.requests.length;
    assert.equal((await s.signup("Alan Turing", "alan@example.test")).status, 201);
    await s.settle();
    const failed = s.rows().filter((r) => r.status === "failed");
    assert.equal(failed.length, 2);
    assert.ok(failed.every((r) => r.attempts === 1));
    assert.ok(failed.some((r) => /validation_error: The kodelumi.com domain is not verified/.test(r.last_error!)));
    assert.equal(resend.requests.length - before, 3, "no retries for permanent errors");
    assert.ok(s.logs.every((l) => !l.includes("alan@example.test")), "addresses are masked");
    secretFree(s);
  } finally {
    await s.stop();
  }
});

test("Resend: daily quota defers without using attempts; registration is never blocked", async () => {
  const resend = new FakeResend();
  resend.queue.push({ status: 429, body: { name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." } });
  const s = await start(resend);
  try {
    assert.equal((await s.signup("Katherine Johnson", "katherine@example.test")).status, 201);
    await s.settle();
    const deferred = s.rows().find((r) => r.last_error?.startsWith("daily_quota_exceeded"))!;
    assert.equal(deferred.status, "pending");
    assert.equal(deferred.attempts, 0);
    assert.ok(deferred.next_attempt_at > Date.now() + 50 * 60_000, "retried about an hour later");
    // Quota resets: the row is delivered once.
    s.app.rooms.db.prepare("UPDATE email_outbox SET next_attempt_at=0 WHERE id=?").run(deferred.id);
    await s.settle();
    assert.equal(s.rows().filter((r) => r.status === "sent").length, 3);
    assert.equal(resend.delivered.filter((b) => (b.to as string[])[0] === deferred.recipient).length, 1);
  } finally {
    await s.stop();
  }
});

test("Resend: no duplicates from replays, concurrent drains or a crash after sending", async () => {
  const resend = new FakeResend();
  const s = await start(resend);
  try {
    assert.equal((await s.signup("Dorothy Vaughan", "dorothy@example.test")).status, 201);
    assert.equal((await s.signup("Dorothy Vaughan", "dorothy@example.test")).status, 400);
    await Promise.all([s.app.outbox.drain(), s.app.outbox.drain(), s.app.outbox.drain()]);
    await s.settle();
    assert.equal(resend.delivered.length, 3);
    // Crash after Resend accepted the email but before the row was marked sent.
    s.app.rooms.db.prepare("UPDATE email_outbox SET status='sending' WHERE recipient='dorothy@example.test'").run();
    await s.restart();
    await s.settle();
    assert.equal(s.rows().find((r) => r.recipient === "dorothy@example.test")!.status, "sent");
    assert.equal(resend.delivered.filter((b) => (b.to as string[])[0] === "dorothy@example.test").length, 1, "Resend idempotency drops the replay");
    assert.ok(resend.requests.length >= 4, "the replay reached the API with the same key");
  } finally {
    await s.stop();
  }
});

test("Resend: missing API key fails clearly without blocking signup", async () => {
  const resend = new FakeResend();
  const s = await start(resend, null);
  try {
    assert.equal((await s.signup("No Key", "nokey@example.test")).status, 201);
    await s.settle();
    assert.equal(resend.requests.length, 0);
    assert.ok(s.rows().every((r) => r.status === "failed" && r.last_error === "missing_api_key: RESEND_API_KEY is not configured"));
  } finally {
    await s.stop();
  }
});

test("provider selection and Resend error classification", () => {
  const resendConfig = emailConfig({ EMAIL_ENABLED: "1", EMAIL_PROVIDER: "resend" });
  assert.equal(resendConfig.provider, "resend");
  assert.ok(createMailer(resendConfig, { RESEND_API_KEY: "x" }) instanceof ResendMailer);
  assert.equal(emailConfig({ EMAIL_ENABLED: "1" }).provider, "ses", "SES remains the default fallback");
  assert.ok(createMailer(emailConfig({})) instanceof SesMailer);
  const c = (status: number, name: string) => classifyResendError(status, { name, message: "m" });
  assert.equal(c(429, "rate_limit_exceeded").permanent, false);
  assert.equal(c(429, "daily_quota_exceeded").deferMs, 3_600_000);
  assert.equal(c(429, "monthly_quota_exceeded").permanent, true);
  assert.equal(c(500, "application_error").permanent, false);
  assert.equal(c(503, "service_unavailable").permanent, false);
  assert.equal(c(409, "concurrent_idempotent_requests").permanent, false);
  assert.equal(c(409, "invalid_idempotent_request").permanent, true);
  for (const [status, name] of [[400, "validation_error"], [401, "missing_api_key"], [403, "validation_error"], [422, "missing_required_field"]] as const)
    assert.equal(c(status, name).permanent, true, `${status} ${name}`);
});
