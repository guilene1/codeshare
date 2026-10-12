import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN, signUp } from "./helpers.js";

// A class behind one school IP opens a share link together: each page load makes a few
// reads plus one request per image. Reads and images must not be refused at that scale,
// while writes from one address keep their strict per-minute budget.
test("rate limits: a 100-student class on one IP can load a lesson; writes stay limited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-limits-"));
  const app = createApp({ dbPath: join(directory, "limits.sqlite"), origins: [DEFAULT_ORIGIN] });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const owner = await signUp(base);
    const room = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Class" }),
    }).then((r) => r.json());
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c636000010000050001" + "0d0a2db40000000049454e44ae426082",
      "hex",
    );
    const image = await fetch(`${base}/api/rooms/${room.id}/images`, {
      method: "POST",
      headers: { ...owner.headers, "content-type": "image/png" },
      body: png,
    }).then((r) => r.json());
    const statuses = async (count: number, request: () => Promise<Response>) => {
      const result: Record<number, number> = {};
      for (let batch = 0; batch < count; batch += 50)
        for (const response of await Promise.all(
          Array.from({ length: Math.min(50, count - batch) }, request),
        )) {
          result[response.status] = (result[response.status] ?? 0) + 1;
          await response.arrayBuffer();
        }
      return result;
    };
    // 100 students × 3 page reads, anonymously.
    assert.deepEqual(await statuses(300, () => fetch(`${base}/api/rooms/${room.id}`)), { 200: 300 });
    // 100 students × 3 images.
    assert.deepEqual(
      await statuses(300, () => fetch(`${base}/api/rooms/${room.id}/images/${image.id}`)),
      { 200: 300 },
    );
    // Writes from one address are still capped at 240 per minute.
    const writes = await statuses(260, () =>
      fetch(`${base}/api/rooms/${room.id}/documents`, {
        method: "POST",
        headers: { origin: DEFAULT_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ filename: "x.md", language: "markdown" }),
      }),
    );
    assert.ok((writes[429] ?? 0) >= 15, JSON.stringify(writes));
    const limited = await fetch(`${base}/api/rooms/${room.id}/documents`, {
      method: "POST",
      headers: { origin: DEFAULT_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many requests/);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
