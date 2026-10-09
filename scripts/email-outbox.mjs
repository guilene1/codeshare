// Operator-only: inspect the email outbox, or re-queue failed emails (for example after
// SES production access is granted, so welcomes rejected by the sandbox are delivered).
// Usage: node scripts/email-outbox.mjs list
//        node scripts/email-outbox.mjs retry-failed [welcome|admin_signup]
// The running application sends re-queued emails within about 15 seconds.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const [command = "list", kind] = process.argv.slice(2);
const db = new DatabaseSync(
  process.env.DB_PATH ??
    fileURLToPath(new URL("../data/devshare.sqlite", import.meta.url)),
);
const mask = (email) => email.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
try {
  if (command === "list") {
    for (const row of db
      .prepare("SELECT kind,status,COUNT(*) AS n FROM email_outbox GROUP BY kind,status ORDER BY kind,status")
      .all())
      console.log(`${row.kind.padEnd(13)} ${row.status.padEnd(8)} ${row.n}`);
    const failed = db
      .prepare("SELECT kind,recipient,attempts,last_error,created_at FROM email_outbox WHERE status='failed' ORDER BY created_at DESC LIMIT 20")
      .all();
    if (failed.length) console.log("\nRecent failures:");
    for (const row of failed)
      console.log(`${new Date(row.created_at).toISOString()} ${row.kind} ${mask(row.recipient)} attempts=${row.attempts} ${row.last_error ?? ""}`);
  } else if (command === "retry-failed") {
    if (kind && !["welcome", "admin_signup"].includes(kind))
      throw new Error("Kind must be welcome or admin_signup.");
    const result = db
      .prepare(
        `UPDATE email_outbox SET status='pending', attempts=0, next_attempt_at=?, last_error=NULL WHERE status='failed'${kind ? " AND kind=?" : ""}`,
      )
      .run(...(kind ? [Date.now(), kind] : [Date.now()]));
    console.log(`Re-queued ${result.changes} email(s).`);
  } else throw new Error("Use list or retry-failed.");
} finally {
  db.close();
}
