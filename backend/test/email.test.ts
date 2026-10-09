import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { classifySesError, EmailError, SesMailer, type EmailMessage, type Mailer } from "../src/mailer.js";
import { PASSWORD } from "./helpers.js";

const origin = "http://localhost:5173";
const ADMINS = ["guilene.tiako@utrains.org", "serge.kamgang@utrains.org"];

// Fake SES: records deliveries; can emulate the sandbox (verified recipients only) or failures.
class FakeSes implements Mailer {
  sent: EmailMessage[] = [];
  sandbox = false;
  verified = new Set(ADMINS);
  failures: Array<() => Error> = [];
  calls = 0;
  async send(message: EmailMessage) {
    this.calls++;
    const failure = this.failures.shift();
    if (failure) throw failure();
    if (this.sandbox && !this.verified.has(message.to))
      throw new EmailError(`Email address is not verified. The following identities failed the check in region US-EAST-1: ${message.to}`, true, "MessageRejected");
    this.sent.push(message);
    return { messageId: "msg-" + this.sent.length };
  }
}
async function start(mailer: Mailer, enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-email-"));
  const dbPath = join(dir, "db.sqlite");
  const logs: string[] = [];
  const make = () =>
    createApp({
      dbPath,
      origins: [origin],
      authLimits: { signupPerHour: 100 },
      email: { enabled, admins: ADMINS, appUrl: "https://kodelumi.com", replyTo: ["guilene.tiako@utrains.org"] },
      mailer,
      outbox: { minIntervalMs: 0, backoffMs: [50, 50, 50], log: (line) => logs.push(line) },
    });
  let app = make();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = () => `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const signup = (displayName: string, email: string) =>
    fetch(base() + "/api/auth/signup", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ displayName, email, password: PASSWORD, confirmPassword: PASSWORD }),
    });
  const rows = () =>
    app.rooms.db
      .prepare("SELECT kind,recipient,status,attempts,last_error FROM email_outbox ORDER BY recipient")
      .all() as Array<{ kind: string; recipient: string; status: string; attempts: number; last_error: string | null }>;
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await app.outbox.drain();
      if (!rows().some((r) => r.status === "pending" || r.status === "sending")) return;
      await new Promise((r) => setTimeout(r, 30));
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

test("every signup queues a personalised welcome email and notifies both administrators", async () => {
  const ses = new FakeSes();
  const s = await start(ses);
  try {
    const response = await s.signup("Ada & O'Brien", "ada@example.test");
    assert.equal(response.status, 201);
    const body = await response.text();
    await s.settle();
    assert.equal(ses.sent.length, 3);
    const welcome = ses.sent.find((m) => m.to === "ada@example.test")!;
    assert.equal(welcome.subject, "Welcome to Kodelumi, Ada & O'Brien!");
    assert.ok(welcome.html.includes("Welcome to Kodelumi, Ada &#38; O&#39;Brien!"), "display name is HTML-escaped");
    assert.ok(welcome.text.startsWith("Welcome to Kodelumi, Ada & O'Brien!"));
    assert.ok(welcome.html.includes('src="https://kodelumi.com/kodelumi-email-logo.png"'));
    assert.ok(welcome.html.includes('href="https://kodelumi.com/workspaces"'));
    assert.ok(welcome.html.includes("Go to My Workspaces"));
    assert.ok(welcome.text.includes("Go to My Workspaces: https://kodelumi.com/workspaces"));
    assert.match(welcome.text, /create workspaces|Create workspaces/i);
    const admins = ses.sent.filter((m) => m.subject.startsWith("New Kodelumi signup"));
    assert.deepEqual(admins.map((m) => m.to).sort(), ADMINS);
    for (const m of admins) {
      assert.ok(m.text.includes("Display name: Ada & O'Brien"));
      assert.ok(m.text.includes("Email: ada@example.test"));
      assert.match(m.text, /Registered: .+ UTC \(\d{4}-\d{2}-\d{2}T/);
    }
    // No em dashes anywhere; no credentials or session material in any email.
    const hash = (s.app.rooms.db.prepare("SELECT password_hash FROM users").get() as { password_hash: string }).password_hash;
    const csrf = JSON.parse(body).csrfToken;
    for (const m of ses.sent) {
      const all = m.subject + m.html + m.text;
      assert.ok(!all.includes("—"), "no em dash");
      for (const secret of [PASSWORD, hash, csrf, "argon2", "devshare_sid", "token"])
        assert.ok(!all.toLowerCase().includes(secret.toLowerCase()), "leaked " + secret);
    }
    assert.deepEqual(s.rows().map((r) => r.status), ["sent", "sent", "sent"]);
  } finally {
    await s.stop();
  }
});

test("each welcome email goes only to its own user", async () => {
  const ses = new FakeSes();
  const s = await start(ses);
  try {
    const people = [
      ["Grace Hopper", "grace@example.test"],
      ["Alan Turing", "alan@example.test"],
      ["Katherine Johnson", "katherine@example.test"],
    ];
    await Promise.all(people.map(([name, email]) => s.signup(name, email)));
    await s.settle();
    const welcomes = ses.sent.filter((m) => m.subject.startsWith("Welcome"));
    assert.equal(welcomes.length, 3);
    for (const [name, email] of people) {
      const own = welcomes.filter((m) => m.to === email);
      assert.equal(own.length, 1);
      assert.ok(own[0].subject.includes(name) && own[0].text.includes(email));
      for (const [otherName, otherEmail] of people.filter(([, e]) => e !== email)) {
        assert.ok(!own[0].text.includes(otherName) && !own[0].text.includes(otherEmail));
      }
    }
    assert.equal(ses.sent.filter((m) => m.subject.startsWith("New Kodelumi signup")).length, 6);
  } finally {
    await s.stop();
  }
});

test("SES failures never block registration; temporary errors are retried, permanent ones are logged", async () => {
  const ses = new FakeSes();
  const throttled = () => Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } });
  ses.failures.push(throttled, throttled);
  const s = await start(ses);
  try {
    const response = await s.signup("Margaret Hamilton", "margaret@example.test");
    assert.equal(response.status, 201);
    // The account works immediately, regardless of email.
    const signin = await fetch(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/api/auth/signin`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "margaret@example.test", password: PASSWORD }),
    });
    assert.equal(signin.status, 200);
    await s.settle();
    assert.equal(ses.sent.length, 3, "all three emails eventually delivered");
    assert.ok(s.rows().some((r) => r.attempts >= 2), "a throttled email was retried");
    assert.ok(s.logs.some((l) => /will be retried .*TooManyRequestsException/.test(l)));
    // Persistent failure: stop after maxAttempts without crashing anything.
    ses.failures.push(...Array.from({ length: 10 }, () => () => new Error("socket hang up")));
    assert.equal((await s.signup("Dorothy Vaughan", "dorothy@example.test")).status, 201);
    await s.settle();
    const failed = s.rows().filter((r) => r.status === "failed");
    assert.ok(failed.length >= 1);
    assert.ok(failed.every((r) => r.attempts <= 4));
    // Logs mask addresses and never include message content.
    assert.ok(s.logs.every((l) => !l.includes("dorothy@example.test") && !l.includes("<html")));
    assert.ok(s.logs.some((l) => l.includes("d***@example.test")));
  } finally {
    await s.stop();
  }
});

test("duplicate processing never sends duplicate emails, and pending emails survive a restart", async () => {
  const ses = new FakeSes();
  const s = await start(ses);
  try {
    assert.equal((await s.signup("Ada", "ada@example.test")).status, 201);
    // Replayed signup is rejected and queues nothing new.
    assert.equal((await s.signup("Ada", "ada@example.test")).status, 400);
    const user = s.app.rooms.db.prepare("SELECT id,display_name,email,created_at FROM users").get() as {
      id: string; display_name: string; email: string; created_at: number;
    };
    // Re-queuing the same user (e.g. a retried request) is ignored by the unique key.
    s.app.outbox.enqueueSignup({ id: user.id, displayName: user.display_name, email: user.email, createdAt: user.created_at });
    assert.equal(s.rows().length, 3);
    // Concurrent drains claim each row once.
    await Promise.all([s.app.outbox.drain(), s.app.outbox.drain(), s.app.outbox.drain()]);
    await s.settle();
    assert.equal(ses.sent.length, 3);
    // Crash recovery: the process died after claiming Bob's welcome ("sending") and before
    // sending his admin notifications ("pending"). After a restart each is sent exactly once.
    const bob = await s.app.accounts.create("Bob", "bob@example.test", PASSWORD);
    const now = Date.now();
    const insert = s.app.rooms.db.prepare(
      "INSERT INTO email_outbox (id,user_id,kind,recipient,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,0,?,?)",
    );
    insert.run("crash-1", bob.id, "welcome", "bob@example.test", "sending", now, now);
    insert.run("crash-2", bob.id, "admin_signup", ADMINS[0], "pending", now, now);
    insert.run("crash-3", bob.id, "admin_signup", ADMINS[1], "pending", now, now);
    const before = ses.sent.length;
    await s.restart();
    await s.settle();
    assert.ok(s.rows().every((r) => r.status === "sent"));
    assert.equal(ses.sent.filter((m) => m.to === "bob@example.test").length, 1);
    assert.equal(ses.sent.length - before, 3);
  } finally {
    await s.stop();
  }
});

test("SES sandbox: unverified recipients fail cleanly; after production access the welcome is delivered", async () => {
  const ses = new FakeSes();
  ses.sandbox = true;
  const s = await start(ses);
  try {
    assert.equal((await s.signup("New Person", "new.person@example.test")).status, 201);
    await s.settle();
    // Admins are verified identities, so their notifications arrive even in the sandbox.
    assert.deepEqual(ses.sent.map((m) => m.to).sort(), ADMINS);
    const welcome = s.rows().find((r) => r.kind === "welcome")!;
    assert.equal(welcome.status, "failed");
    assert.equal(welcome.attempts, 1, "a permanent sandbox rejection is not retried");
    assert.match(welcome.last_error!, /MessageRejected/);
    assert.ok(s.logs.some((l) => l.includes("recipient not verified; SES sandbox")));
    // Production access granted: re-queue failed welcomes (as scripts/email-outbox.mjs retry-failed does).
    ses.sandbox = false;
    s.app.rooms.db
      .prepare("UPDATE email_outbox SET status='pending', attempts=0, next_attempt_at=0, last_error=NULL WHERE status='failed'")
      .run();
    await s.settle();
    const delivered = ses.sent.filter((m) => m.to === "new.person@example.test");
    assert.equal(delivered.length, 1);
    assert.equal(ses.sent.filter((m) => ADMINS.includes(m.to)).length, 2, "admins are not notified twice");
  } finally {
    await s.stop();
  }
});

test("email disabled: nothing is queued or sent", async () => {
  const ses = new FakeSes();
  const s = await start(ses, false);
  try {
    assert.equal((await s.signup("Quiet User", "quiet@example.test")).status, 201);
    await s.settle();
    assert.equal(s.rows().length, 0);
    assert.equal(ses.calls, 0);
  } finally {
    await s.stop();
  }
});

test("SESv2 adapter builds the request and classifies errors", async () => {
  const commands: Array<{ input: Record<string, unknown> }> = [];
  const mailer = new SesMailer(
    { enabled: true, provider: "ses", region: "us-east-1", from: "Kodelumi <no-reply@kodelumi.com>", replyTo: ["guilene.tiako@utrains.org"], admins: [], appUrl: "https://kodelumi.com" },
    { send: async (command: unknown) => (commands.push(command as { input: Record<string, unknown> }), { MessageId: "abc" }) },
  );
  const result = await mailer.send({ to: "user@example.test", subject: "Hello", html: "<p>Hi</p>", text: "Hi" });
  assert.equal(result.messageId, "abc");
  assert.deepEqual(commands[0].input, {
    FromEmailAddress: "Kodelumi <no-reply@kodelumi.com>",
    Destination: { ToAddresses: ["user@example.test"] },
    ReplyToAddresses: ["guilene.tiako@utrains.org"],
    Content: {
      Simple: {
        Subject: { Data: "Hello", Charset: "UTF-8" },
        Body: { Html: { Data: "<p>Hi</p>", Charset: "UTF-8" }, Text: { Data: "Hi", Charset: "UTF-8" } },
      },
    },
  });
  assert.equal(classifySesError(Object.assign(new Error("not verified"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } })).permanent, true);
  assert.equal(classifySesError(Object.assign(new Error("slow down"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } })).permanent, false);
  assert.equal(classifySesError(Object.assign(new Error("oops"), { name: "InternalFailure", $metadata: { httpStatusCode: 500 } })).permanent, false);
  assert.equal(classifySesError(new Error("ECONNRESET")).permanent, false);
});
