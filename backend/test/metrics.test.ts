import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

test("operational metrics require a separate secret and never expose course content or editor credentials", async () => {
  const previous = process.env.METRICS_TOKEN;
  const dir = await mkdtemp(join(tmpdir(), "devshare-metrics-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite") });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/metrics`;
  try {
    delete process.env.METRICS_TOKEN;
    assert.equal((await fetch(url)).status, 404);
    const secret = randomBytes(32).toString("hex");
    process.env.METRICS_TOKEN = secret;
    assert.equal((await fetch(url)).status, 404);
    assert.equal(
      (await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
      404,
    );
    const room = app.rooms.create(
      "Private course name",
      "hcl",
      randomBytes(32).toString("hex"),
    );
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + secret },
    });
    assert.equal(response.status, 200);
    const value = (await response.json()) as {
      memory: { rss: number };
      activeSessions: number;
      websocketConnections: number;
      sessions: Array<{ workspaceId: string }>;
    };
    assert.ok(value.memory.rss > 0);
    assert.equal(value.activeSessions, 1);
    assert.equal(value.websocketConnections, 0);
    assert.equal(value.sessions[0].workspaceId, room.id);
    const data = JSON.stringify(value);
    assert.ok(!data.includes(secret));
    assert.ok(!data.includes("Private course name"));
    assert.ok(!data.includes("training-bucket"));
  } finally {
    if (previous === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previous;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
