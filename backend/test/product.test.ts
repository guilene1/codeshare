import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { createRoom } from "./helpers.js";

test("templates, private metadata summaries and meaningful history persist without hydrating courses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devshare-product-")),
    path = join(dir, "db.sqlite");
  let app = createApp({ dbPath: path });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  let port = (app.server.address() as { port: number }).port;
  const token = randomBytes(32).toString("base64url"),
    hash = createHash("sha256").update(token).digest("hex");
  const request = (
    url: string,
    method = "GET",
    body?: unknown,
    editor = true,
  ) =>
    url === "/rooms" && method === "POST"
      ? createRoom(app, `http://127.0.0.1:${port}`, body as Record<string, unknown>)
      : fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
        ...(editor ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    for (const [template, files] of [
      ["empty", 0],
      ["terraform", 3],
      ["kubernetes", 3],
      ["python", 1],
      ["devops", 3],
    ] as const) {
      const response = await request("/rooms", "POST", {
        name: template,
        template,
        description: "Teaching infrastructure",
        editorTokenHash: hash,
      });
      assert.equal(response.status, 201);
      const { id } = (await response.json()) as { id: string };
      const base = "/rooms/" + id;
      app.rooms.release(app.rooms.get(id)!);
      assert.equal(app.rooms.active.size, 0);
      const meta = await (await request(base + "/summary")).json();
      assert.equal(meta.files, files);
      assert.equal(meta.description, "Teaching infrastructure");
      assert.equal(meta.activity[0].action, "workspace.created");
      assert.equal(app.rooms.active.size, 0);
      assert.equal(
        (await request(base + "/summary", "GET", undefined, false)).status,
        404,
      );
      assert.ok(!JSON.stringify(meta).includes(token));
      assert.ok(!("editor_token_hash" in meta));
      assert.equal(
        (await request(base, "PATCH", { name: "Renamed " + template }, false))
          .status,
        403,
      );
      if (template === "terraform") {
        assert.equal(
          (await request(base, "PATCH", { name: "Terraform Class" })).status,
          200,
        );
        const folder = (await (
          await request(base + "/folders", "POST", { name: "Week 1" })
        ).json()) as { id: string };
        const doc = (await (
          await request(base + "/documents?folder=" + folder.id, "POST", {
            filename: "notes.md",
            language: "markdown",
          })
        ).json()) as { id: string };
        await request(
          base + "/documents/" + doc.id + "?folder=" + folder.id,
          "PATCH",
          { filename: "lesson.md" },
        );
        await request(base + "/blocks?folder=" + folder.id, "POST", {
          title: "Init",
          language: "shell",
          content: "terraform init",
        });
        await request(
          base + "/documents/" + doc.id + "?folder=" + folder.id,
          "DELETE",
        );
        await app.close();
        app = createApp({ dbPath: path });
        await new Promise<void>((resolve) =>
          app.server.listen(0, "127.0.0.1", resolve),
        );
        port = (app.server.address() as { port: number }).port;
        const restored = await (await request(base + "/summary")).json();
        assert.equal(restored.name, "Terraform Class");
        assert.equal(restored.files, 3);
        assert.equal(restored.blocks, 1);
        assert.equal(restored.folders, 1);
        assert.deepEqual(
          new Set(
            restored.activity.map((event: { action: string }) => event.action),
          ),
          new Set([
            "workspace.created",
            "workspace.renamed",
            "folder.created",
            "file.created",
            "file.renamed",
            "file.deleted",
            "block.created",
          ]),
        );
        assert.equal(app.rooms.active.size, 0);
      }
    }
    assert.equal(
      (
        await request("/rooms", "POST", {
          name: "Invalid",
          template: "__proto__",
          editorTokenHash: hash,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/rooms", "POST", {
          name: "Invalid",
          description: "x".repeat(401),
          editorTokenHash: hash,
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
