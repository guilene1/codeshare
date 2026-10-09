import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { adminSignupEmail, welcomeEmail, type TemplateUser } from "./emailTemplates.js";

export type EmailMessage = { to: string; subject: string; html: string; text: string };
// idempotencyKey is stable per outbox row, so a provider that supports it can drop
// a repeated delivery of the same message (e.g. after a crash and restart).
export interface Mailer {
  send(
    message: EmailMessage,
    options?: { idempotencyKey?: string },
  ): Promise<{ messageId?: string }>;
}
export type EmailProvider = "ses" | "resend";
export type EmailConfig = {
  enabled: boolean;
  provider: EmailProvider;
  region: string;
  from: string;
  replyTo: string[];
  admins: string[];
  appUrl: string;
};
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
// All email settings come from the environment; credentials use the standard AWS chain.
export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    enabled: env.EMAIL_ENABLED === "1",
    provider: env.EMAIL_PROVIDER === "resend" ? "resend" : "ses",
    region: env.SES_REGION || "us-east-1",
    from: env.EMAIL_FROM || "Kodelumi <no-reply@kodelumi.com>",
    replyTo: list(env.EMAIL_REPLY_TO),
    admins: list(env.ADMIN_NOTIFY_EMAILS),
    appUrl: (env.APP_URL || "https://kodelumi.com").replace(/\/+$/, ""),
  };
}

// permanent = retrying cannot help (e.g. SES sandbox rejecting an unverified recipient).
// deferMs = retry later without using up an attempt (e.g. a provider's daily quota).
export class EmailError extends Error {
  constructor(
    message: string,
    public permanent: boolean,
    public code = "Error",
    public deferMs?: number,
  ) {
    super(message);
  }
}
const PERMANENT = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "NotFoundException",
  "BadRequestException",
]);
export function classifySesError(error: unknown) {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const code = e?.name ?? "Error";
  const status = e?.$metadata?.httpStatusCode;
  const permanent = PERMANENT.has(code) || (status !== undefined && status >= 400 && status < 500 && code !== "TooManyRequestsException" && code !== "LimitExceededException" && code !== "ThrottlingException");
  // SES messages contain no credentials; keep them short for logs.
  return new EmailError((e?.message ?? String(error)).slice(0, 300), permanent, code);
}

type SesClient = { send(command: unknown): Promise<{ MessageId?: string }> };
// Amazon SES v2 sender. The SDK is loaded on first use, so disabled email costs no memory.
export class SesMailer implements Mailer {
  private client?: SesClient;
  private commands?: typeof import("@aws-sdk/client-sesv2");
  constructor(
    private config: EmailConfig,
    client?: SesClient,
  ) {
    this.client = client;
  }
  async send(message: EmailMessage) {
    this.commands ??= await import("@aws-sdk/client-sesv2");
    this.client ??= new this.commands.SESv2Client({ region: this.config.region });
    const command = new this.commands.SendEmailCommand({
      FromEmailAddress: this.config.from,
      Destination: { ToAddresses: [message.to] },
      ...(this.config.replyTo.length ? { ReplyToAddresses: this.config.replyTo } : {}),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: message.html, Charset: "UTF-8" },
            Text: { Data: message.text, Charset: "UTF-8" },
          },
        },
      },
    });
    try {
      const result = await this.client.send(command);
      return { messageId: result.MessageId };
    } catch (error) {
      throw classifySesError(error);
    }
  }
}

type Fetch = typeof fetch;
const RESEND_PERMANENT_409 = new Set(["invalid_idempotent_request"]);
// Maps a Resend API error (status + JSON body) to retry semantics.
export function classifyResendError(status: number, body: { name?: string; message?: string }) {
  const code = body?.name || `http_${status}`;
  const message = (body?.message || `Resend API returned ${status}`).slice(0, 300);
  if (status === 429 && code === "daily_quota_exceeded")
    return new EmailError(message, false, code, 60 * 60_000);
  if (status === 429 && code === "monthly_quota_exceeded") return new EmailError(message, true, code);
  if (status === 429 || status >= 500) return new EmailError(message, false, code);
  if (status === 409 && !RESEND_PERMANENT_409.has(code)) return new EmailError(message, false, code);
  return new EmailError(message, true, code);
}
// Resend sender (https://resend.com/docs/api-reference/emails/send-email). Uses Node's fetch;
// the API key is only ever placed in the Authorization header, never in errors or logs.
export class ResendMailer implements Mailer {
  constructor(
    private config: EmailConfig,
    private apiKey: string | undefined,
    private fetchImpl: Fetch = fetch,
    private endpoint = "https://api.resend.com/emails",
  ) {}
  async send(message: EmailMessage, options: { idempotencyKey?: string } = {}) {
    if (!this.apiKey)
      throw new EmailError("RESEND_API_KEY is not configured", true, "missing_api_key");
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "user-agent": "kodelumi-outbox",
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(this.config.replyTo.length ? { reply_to: this.config.replyTo } : {}),
        }),
      });
    } catch (error) {
      // Network failures and timeouts are temporary.
      throw new EmailError(((error as Error).message || "network error").slice(0, 300), false, (error as Error).name || "NetworkError");
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
    if (!response.ok) throw classifyResendError(response.status, body);
    return { messageId: body.id };
  }
}
// Chooses the provider from EMAIL_PROVIDER; SES stays available as a fallback.
export function createMailer(config: EmailConfig, env: NodeJS.ProcessEnv = process.env): Mailer {
  return config.provider === "resend"
    ? new ResendMailer(config, env.RESEND_API_KEY)
    : new SesMailer(config);
}

// Logs never contain full addresses, message bodies or credentials.
export const maskEmail = (email: string) =>
  email.replace(/^(.)[^@]*(@.*)$/, (_m, first: string, domain: string) => `${first}***${domain}`);

export type OutboxOptions = {
  maxAttempts?: number;
  backoffMs?: number[];
  // Spacing between sends keeps within the SES sandbox rate (1 email/second).
  minIntervalMs?: number;
  log?: (line: string) => void;
};
type Row = { id: string; user_id: string; kind: string; recipient: string; attempts: number };

// Persistent SQLite outbox. Rows are claimed atomically (pending -> sending) so each row
// is sent at most once per attempt; UNIQUE(user_id, kind, recipient) prevents duplicates.
export class EmailOutbox {
  private draining = false;
  private again = false;
  private maxAttempts: number;
  private backoffMs: number[];
  private minIntervalMs: number;
  private log: (line: string) => void;
  constructor(
    private db: DatabaseSync,
    public config: EmailConfig,
    private mailer: Mailer,
    options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoffMs = options.backoffMs ?? [60_000, 5 * 60_000, 30 * 60_000];
    this.minIntervalMs = options.minIntervalMs ?? 1100;
    this.log = options.log ?? ((line) => console.warn(line));
  }
  // Called after a successful signup. Never throws into the signup request.
  enqueueSignup(user: TemplateUser & { id: string }) {
    if (!this.config.enabled) return;
    try {
      const now = Date.now();
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO email_outbox (id,user_id,kind,recipient,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?, 'pending', 0, ?, ?)",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        insert.run(randomUUID(), user.id, "welcome", user.email, now, now);
        for (const admin of this.config.admins)
          insert.run(randomUUID(), user.id, "admin_signup", admin, now, now);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.kick();
    } catch (error) {
      this.log(`Email outbox: could not queue signup emails (${(error as Error).message})`);
    }
  }
  // After a crash, rows left in "sending" are retried (at-least-once delivery).
  recover() {
    this.db
      .prepare("UPDATE email_outbox SET status='pending' WHERE status='sending'")
      .run();
  }
  kick() {
    if (!this.config.enabled) return;
    setImmediate(() => void this.drain());
  }
  async drain(now = () => Date.now()) {
    if (!this.config.enabled) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        const due = this.db
          .prepare(
            "SELECT id,user_id,kind,recipient,attempts FROM email_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at, kind DESC LIMIT 25",
          )
          .all(now()) as Row[];
        for (const row of due) {
          const claimed = this.db
            .prepare("UPDATE email_outbox SET status='sending' WHERE id=? AND status='pending'")
            .run(row.id).changes;
          if (claimed) await this.deliver(row, now);
          if (this.minIntervalMs) await new Promise((r) => setTimeout(r, this.minIntervalMs));
        }
        if (due.length === 25) this.again = true;
      } while (this.again);
    } catch (error) {
      this.log(`Email outbox: drain failed (${(error as Error).message})`);
    } finally {
      this.draining = false;
    }
  }
  private async deliver(row: Row, now: () => number) {
    const user = this.db
      .prepare("SELECT display_name,email,created_at FROM users WHERE id=?")
      .get(row.user_id) as { display_name: string; email: string; created_at: number } | undefined;
    const fail = (message: string) =>
      this.db
        .prepare("UPDATE email_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE id=?")
        .run(message.slice(0, 300), row.id);
    if (!user) {
      fail("user no longer exists");
      return;
    }
    const data = {
      displayName: user.display_name,
      email: row.kind === "welcome" ? row.recipient : user.email,
      createdAt: user.created_at,
    };
    // The welcome email always goes to the address it was queued for, never another user's.
    const rendered =
      row.kind === "welcome" ? welcomeEmail(data, this.config.appUrl) : adminSignupEmail(data, this.config.appUrl);
    try {
      const result = await this.mailer.send(
        { to: row.recipient, ...rendered },
        { idempotencyKey: `kodelumi-outbox-${row.id}` },
      );
      this.db
        .prepare(
          "UPDATE email_outbox SET status='sent', attempts=attempts+1, sent_at=?, message_id=?, last_error=NULL WHERE id=?",
        )
        .run(now(), result.messageId ?? null, row.id);
    } catch (error) {
      const e = error instanceof EmailError ? error : classifySesError(error);
      if (e.deferMs && !e.permanent) {
        // Quota pauses do not use up attempts; the row is simply tried again later.
        this.db
          .prepare("UPDATE email_outbox SET status='pending', last_error=?, next_attempt_at=? WHERE id=?")
          .run(`${e.code}: ${e.message}`.slice(0, 300), now() + e.deferMs, row.id);
        this.log(`Email ${row.kind} to ${maskEmail(row.recipient)} deferred: ${e.code}`);
        return;
      }
      const attempts = row.attempts + 1;
      const final = e.permanent || attempts >= this.maxAttempts;
      if (final) fail(`${e.code}: ${e.message}`);
      else
        this.db
          .prepare(
            "UPDATE email_outbox SET status='pending', attempts=?, last_error=?, next_attempt_at=? WHERE id=?",
          )
          .run(
            attempts,
            `${e.code}: ${e.message}`.slice(0, 300),
            now() + this.backoffMs[Math.min(attempts - 1, this.backoffMs.length - 1)],
            row.id,
          );
      this.log(
        `Email ${row.kind} to ${maskEmail(row.recipient)} ${final ? "failed" : "will be retried"} (attempt ${attempts}/${this.maxAttempts}): ${e.code}${/not verified/i.test(e.message) ? " (recipient not verified; SES sandbox)" : ""}`,
      );
    }
  }
}
