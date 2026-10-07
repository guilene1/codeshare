import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The SQLite online backup API includes committed WAL pages safely.
const directory = await mkdtemp(join(tmpdir(), "devshare-backup-"));
const db = new DatabaseSync(
  process.env.DB_PATH ??
    fileURLToPath(new URL("../data/devshare.sqlite", import.meta.url)),
  { readOnly: true },
);
try {
  const path = join(directory, "snapshot.sqlite");
  await backup(db, path);
  process.stdout.write(await readFile(path));
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
