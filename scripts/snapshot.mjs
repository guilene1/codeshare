import { DatabaseSync, backup } from "node:sqlite";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
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
  // Streamed, so a database holding many images never has to fit in memory.
  await pipeline(createReadStream(path), process.stdout);
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
