// Operator-only: issue a single-use password reset link (valid 30 minutes).
// Kodelumi has no email delivery yet, so the operator sends this link to the user directly.
// Usage: node scripts/issue-password-reset.mjs user@example.com https://devshare.gamela.shop
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const email = process.argv[2],
  origin = process.argv[3] ?? "http://localhost:8080";
if (!email || !email.includes("@")) throw new Error("Provide the account email.");
const url = new URL(origin);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("Use an HTTP or HTTPS origin.");
const db = new DatabaseSync(
  process.env.DB_PATH ??
    fileURLToPath(new URL("../data/devshare.sqlite", import.meta.url)),
);
try {
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) throw new Error("No account uses that email.");
  const token = randomBytes(32).toString("base64url"),
    now = Date.now();
  db.prepare(
    "INSERT INTO password_resets (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    user.id,
    now,
    now + 30 * 60 * 1000,
  );
  // The token travels in the URL fragment, so it never reaches server or proxy logs.
  process.stdout.write(url.origin + "/reset-password#" + token + "\n");
} finally {
  db.close();
}
