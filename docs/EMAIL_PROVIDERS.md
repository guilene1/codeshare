# Email providers: Resend (current), SES (fallback) and Brevo (alternative)

Status (2026-10-08): **Resend is the active provider** (`EMAIL_PROVIDER=resend`). The `kodelumi.com` domain is verified in Resend (DNS records `resend._domainkey` TXT, `rsend` CNAME and `send` CNAME applied in Route 53), and a sending-only API key exists; it lives only in the server `.env`. Amazon SES stays configured and verified as a fallback, but the account is in the SES sandbox (production access case 179150611300170 was denied). The sections below record the evaluation that led to this choice.

## What stays exactly as it is

- `backend/src/emailTemplates.ts`: the branded welcome and administrator templates (HTML plus plain text, no em dashes).
- `backend/src/mailer.ts` `EmailOutbox`: the persistent SQLite outbox, `UNIQUE(user_id, kind, recipient)`, atomic `pending → sending` claims, retries after about 1, 5 and 30 minutes (4 attempts), restart recovery, masked logging.
- Signup flow: emails are queued after the account exists; email problems never block registration.
- The same Lightsail server and Docker Compose deployment. No new AWS services.

## Small, interchangeable provider adapter

The outbox already talks to a one-method interface:

```ts
interface Mailer { send(message: EmailMessage): Promise<{ messageId?: string }> }
```

The change is limited to `mailer.ts`:

1. `EmailConfig` gains `provider: "ses" | "resend" | "brevo"` from `EMAIL_PROVIDER` (default `ses`).
2. A factory `createMailer(config)` returns `SesMailer` (unchanged), `ResendMailer` or `BrevoMailer`; `app.ts` calls it instead of `new SesMailer`.
3. Each adapter maps its errors to the existing `EmailError(permanent)`: HTTP 429 and 5xx and network errors are temporary (retried); 400/401/403/404/422 are permanent (logged, not retried; 401/403 means a key or domain problem and is logged prominently).
4. Each adapter receives the outbox row id so it can pass a provider idempotency key (see below).

Providers use plain `fetch` (built into Node 24), so no new SDK dependency.

### Resend (preferred fallback)

- **API:** `POST https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`, JSON `{ from, to, subject, html, text, reply_to }`; returns `{ id }`.
- **Duplicate protection improves:** Resend supports an `Idempotency-Key` header (unique per request, kept for 24 hours). Sending the outbox row id as the key means a crash between "sent" and "marked sent" no longer produces a second email (SES has no equivalent).
- **DNS for `kodelumi.com`** (as shown by the Resend dashboard for this domain; domains created since August 2026 use CNAMEs instead of the older MX and SPF pair; exact values are copied from the dashboard when applied):
  - `resend._domainkey.kodelumi.com` TXT: DKIM public key (`p=...`)
  - `rsend.kodelumi.com` CNAME: return path (bounces, SPF and DMARC alignment)
  - `send.kodelumi.com` CNAME: sending subdomain
  - The existing `_dmarc.kodelumi.com` record is reused, not duplicated.
  - None of these names exist in the zone, and none collide with the SES records (`<token>._domainkey`, `mail.kodelumi.com`), so **SES records stay untouched** and switching back to SES remains a one-line `.env` change.
- **Key handling:** a sending-only API key restricted to the `kodelumi.com` domain, written directly to the server `.env` as `RESEND_API_KEY` (mode 600). Never committed, never in the image.
- **Cost:** Free plan, 3,000 emails/month and **100 emails/day**, 3 domains. Each signup sends 3 emails (welcome plus 2 administrators), so the free plan covers about **33 signups/day** and 1,000 signups/month. Above that, Pro is $20/month for 50,000 emails.
- **Sandbox-style limits:** none comparable to SES; once the domain verifies, any recipient can be emailed.

### Brevo (secondary)

- **API:** `POST https://api.brevo.com/v3/smtp/email`, header `api-key: <BREVO_API_KEY>`, JSON `{ sender: { name, email }, to: [{ email }], subject, htmlContent, textContent, replyTo }`; returns `{ messageId }`.
- **No idempotency header:** duplicate protection relies on the outbox alone (same behaviour as SES today).
- **DNS:** `brevo-code` TXT (ownership) on the root, `brevo1._domainkey` and `brevo2._domainkey` CNAMEs, plus a DMARC record (the existing one is reused). No collisions with the SES or Resend names.
- **Cost:** Free plan, 300 emails/day (about 100 signups/day at 3 emails each). Paid transactional volume starts around $9 to $15/month. Check whether the free plan adds Brevo branding to transactional emails before choosing it.

## Recommendation

1. Pursue the SES reconsideration first (no code change, lowest cost: $0.10 per 1,000 emails).
2. If AWS maintains the denial, implement **Resend** (free at current volume, idempotent sends, simple API, records that coexist with SES).
3. Keep Brevo as the alternative if Resend's 100/day free cap becomes a problem before paying for a plan.

## Implementation steps (after approval)

1. Add `provider` to `EmailConfig`, `createMailer()`, and `ResendMailer` (about 60 lines) to `mailer.ts`; pass the outbox row id for idempotency.
2. Tests: request shape and headers (including `Idempotency-Key`), error classification (429/5xx retried, 4xx permanent), provider selection from `EMAIL_PROVIDER`, and the existing outbox tests running against the Resend adapter with a stubbed `fetch`.
3. `docker-compose.yml`: pass `EMAIL_PROVIDER` and `RESEND_API_KEY` (from the server `.env`) to the application.
4. With approval: create the Resend domain, add its DNS records in Route 53, verify, create the restricted API key directly into the server `.env`, send one test email to a verified administrator, then deploy with the usual workflow.
