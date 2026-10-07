// Operator-only legacy migration/recovery. This is never exposed through HTTP.
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const id = process.argv[2],
  origin = process.argv[3] ?? "http://localhost:8080";
if (!/^[\w-]{16}$/.test(id ?? ""))
  throw new Error("Provide the 16-character workspace ID.");
const url = new URL(origin);
if (!["http:", "https:"].includes(url.protocol))
  throw new Error("Use an HTTP or HTTPS origin.");
const db = new DatabaseSync(
  process.env.DB_PATH ??
    fileURLToPath(new URL("../data/devshare.sqlite", import.meta.url)),
);
try {
  const row = db
    .prepare("SELECT editor_token_hash FROM rooms WHERE id=?")
    .get(id);
  if (!row) throw new Error("Workspace not found.");
  if (row.editor_token_hash && !process.argv.includes("--rotate"))
    throw new Error(
      "This workspace already has editor access. Supply --rotate only if you intend to revoke its previous private link.",
    );
  const token = randomBytes(32).toString("base64url"),
    hash = createHash("sha256").update(token).digest("hex");
  db.prepare("UPDATE rooms SET editor_token_hash=? WHERE id=?").run(hash, id);
  // Deliberate one-time credential delivery to the operator's terminal, not service logs.
  process.stdout.write(url.origin + "/w/" + id + "/edit/" + token + "\n");
} finally {
  db.close();
}
