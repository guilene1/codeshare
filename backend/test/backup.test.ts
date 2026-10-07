import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { addDocument } from "../src/rooms.js";
import { randomUUID } from "node:crypto";
import { createBlock } from "../src/blocks.js";

test("operator snapshot script produces a complete, restorable database while WAL database is open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-snapshot-")),
    dbPath = join(directory, "live.sqlite"),
    app = createApp({ dbPath });
  try {
    const room = app.rooms.create("Backup verification", "python");
    createBlock(room, {
      title: "Command",
      language: "shell",
      content: "terraform init",
    });
    app.rooms.save(room);
    const folderId = randomUUID(),
      now = Date.now();
    app.rooms.db
      .prepare(
        "INSERT INTO folders(id,workspace_id,parent_id,name,position,created_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        folderId,
        room.id,
        null,
        "Permanent lesson",
        0,
        now,
        now,
        new Uint8Array([0, 0]),
      );
    const lesson = app.rooms.get(room.id, folderId)!;
    addDocument(lesson, "deployment.yaml", "yaml", "kind: Deployment");
    app.rooms.save(lesson);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/snapshot.mjs", import.meta.url))],
      {
        env: { ...process.env, DB_PATH: dbPath },
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const path = join(directory, "restored.sqlite");
    await writeFile(path, stdout);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
      assert.equal(
        restored.prepare("SELECT name FROM rooms WHERE id=?").get(room.id)
          ?.name,
        "Backup verification",
      );
      assert.match(
        String(
          restored
            .prepare("SELECT content FROM documents WHERE room_id=?")
            .get(room.id)?.content,
        ),
        /def hello/,
      );
      assert.equal(
        restored
          .prepare("SELECT content FROM code_blocks WHERE workspace_id=?")
          .get(room.id)?.content,
        "terraform init",
      );
      assert.equal(
        restored.prepare("SELECT name FROM folders WHERE id=?").get(folderId)
          ?.name,
        "Permanent lesson",
      );
      assert.equal(
        restored
          .prepare("SELECT content FROM documents WHERE folder_id=?")
          .get(folderId)?.content,
        "kind: Deployment",
      );
    } finally {
      restored.close();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
