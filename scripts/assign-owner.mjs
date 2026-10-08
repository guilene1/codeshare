// Operator-only: resolve ownership disputes for a workspace.
// Usage: node scripts/assign-owner.mjs WORKSPACE_ID user@example.com
//        node scripts/assign-owner.mjs WORKSPACE_ID --unowned   (makes it claimable again)
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const [id, target] = process.argv.slice(2);
if (!/^[\w-]{16}$/.test(id ?? ""))
  throw new Error("Provide the 16-character workspace ID.");
if (!target) throw new Error("Provide an account email or --unowned.");
const db = new DatabaseSync(
  process.env.DB_PATH ??
    fileURLToPath(new URL("../data/devshare.sqlite", import.meta.url)),
);
try {
  if (!db.prepare("SELECT 1 FROM rooms WHERE id=?").get(id))
    throw new Error("Workspace not found.");
  let owner = null;
  if (target !== "--unowned") {
    owner = db.prepare("SELECT id FROM users WHERE email=?").get(target)?.id;
    if (!owner) throw new Error("No account uses that email.");
  }
  db.prepare("UPDATE rooms SET owner_id=? WHERE id=?").run(owner, id);
  process.stdout.write(
    owner ? `Workspace ${id} now belongs to ${target}\n` : `Workspace ${id} is unowned\n`,
  );
} finally {
  db.close();
}
