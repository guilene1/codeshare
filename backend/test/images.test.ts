import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { fetchImage, isPublicAddress, sniffImage } from "../src/images.js";
import { DEFAULT_ORIGIN, signUp } from "./helpers.js";

// A real (decodable) PNG of the given size, like a pasted architecture diagram.
function png(width: number, height: number, extra = 0) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height, 0xee);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    // Incompressible ancillary data makes large test files without huge pixel counts.
    ...(extra ? [chunk("raNd", randomBytes(extra))] : []),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// Two-frame animated 1x1 GIF (black, then white) that loops forever.
const frame = (pixelData: string) =>
  "21f9040432000000" + // graphic control: 0.5 s delay
  "2c00000000010001000" + "0" + // image descriptor, 1x1
  "0202" + pixelData + "00"; // LZW min code size 2, one data block
const animatedGif = Buffer.from(
  "474946383961" + // GIF89a
    "0100" + "0100" + "80" + "00" + "00" + // 1x1, 2-colour global table
    "000000" + "ffffff" +
    "21ff0b" + "4e45545343415045322e30" + "03010000" + "00" + // NETSCAPE2.0 loop forever
    frame("4401") + // pixel 0 (black)
    frame("4c01") + // pixel 1 (white)
    "3b",
  "hex",
);
const jpegHeader = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000" + "ffc00011080400060003012200021101031101" + "ffd9",
  "hex",
);
function webpLossless(width: number, height: number) {
  const data = Buffer.alloc(30);
  data.write("RIFF", 0, "latin1");
  data.writeUInt32LE(22, 4);
  data.write("WEBPVP8L", 8, "latin1");
  data.writeUInt32LE(10, 16);
  data[20] = 0x2f;
  data.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return data;
}
const sha = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");

test("images: exact bytes, validated types and limits, editor-only uploads, public viewing, persistence and backups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devshare-images-"));
  const dbPath = join(directory, "images.sqlite");
  let app = createApp({ dbPath, origins: [DEFAULT_ORIGIN] });
  const listen = async () => {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  let base = await listen();
  try {
    const owner = await signUp(base);
    const create = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Kubernetes architecture" }),
    });
    assert.equal(create.status, 201);
    const room = (await create.json()).id as string;
    const upload = (data: Buffer, headers: Record<string, string> = owner.headers, type = "image/png", id = room) =>
      fetch(`${base}/api/rooms/${id}/images`, {
        method: "POST",
        headers: { ...headers, "content-type": type, Connection: "close" },
        body: data,
      });
    const view = (id: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/rooms/${room}/images/${id}`, { headers });

    // A diagram the size of the reference infographic keeps its exact bytes and size.
    const diagram = png(1536, 1024);
    let response = await upload(diagram);
    assert.equal(response.status, 201, await response.clone().text());
    const stored = await response.json();
    assert.deepEqual(
      { mime: stored.mime, width: stored.width, height: stored.height, size: stored.size },
      { mime: "image/png", width: 1536, height: 1024, size: diagram.length },
    );
    assert.match(stored.id, /^[A-Za-z0-9_-]{22}$/);
    // Anonymous viewers (no cookie, no editor link) can load it through the workspace.
    response = await view(stored.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /sandbox/);
    assert.match(response.headers.get("cache-control")!, /immutable/);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(diagram));
    const etag = response.headers.get("etag")!;
    assert.equal((await view(stored.id, { "if-none-match": etag })).status, 304);

    // Animated GIF: both frames survive (the stored file is byte-identical).
    response = await upload(animatedGif, owner.headers, "image/gif");
    assert.equal(response.status, 201, await response.clone().text());
    const gif = await response.json();
    assert.equal(gif.mime, "image/gif");
    assert.deepEqual(Buffer.from(await (await view(gif.id)).arrayBuffer()), animatedGif);

    // Large files are stored in chunks and streamed back intact.
    const large = png(800, 600, 1_200_000);
    response = await upload(large);
    assert.equal(response.status, 201);
    const big = await response.json();
    const chunks = Number(
      app.rooms.db.prepare("SELECT COUNT(*) AS n FROM image_chunks WHERE image_id=?").get(big.id)!.n,
    );
    assert.ok(chunks >= 5, `expected several chunks, got ${chunks}`);
    assert.equal(sha(Buffer.from(await (await view(big.id)).arrayBuffer())), sha(large));

    // Formats are recognised from their bytes, with their pixel sizes.
    assert.deepEqual(sniffImage(jpegHeader), { mime: "image/jpeg", width: 1536, height: 1024 });
    assert.deepEqual(sniffImage(webpLossless(1536, 1024)), { mime: "image/webp", width: 1536, height: 1024 });
    // SVG, HTML disguised as PNG, and empty bodies are refused whatever the header says.
    for (const [body, type, status] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", 415],
      [Buffer.from("<html><script>alert(1)</script></html>"), "image/png", 415],
      [Buffer.alloc(0), "image/png", 400],
    ] as const) {
      response = await upload(body as Buffer, owner.headers, type);
      assert.equal(response.status, status, await response.clone().text());
    }
    // Size and dimension limits.
    response = await upload(Buffer.concat([png(10, 10), Buffer.alloc(15 * 1024 * 1024)]));
    assert.equal(response.status, 413);
    const huge = png(1, 1);
    huge.writeUInt32BE(30_000, 16); // claims 30,000 px wide
    assert.equal((await upload(huge)).status, 413);

    // Only editors upload: anonymous visitors, other accounts and requests without the
    // CSRF token are refused.
    assert.equal((await upload(diagram, { origin: DEFAULT_ORIGIN })).status, 403);
    const stranger = await signUp(base);
    assert.equal((await upload(diagram, stranger.headers)).status, 403);
    assert.equal(
      (await upload(diagram, { origin: DEFAULT_ORIGIN, cookie: owner.cookie })).status,
      403,
    );
    // Another workspace cannot read this workspace's image by its ID.
    const other = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Other" }),
    }).then((r) => r.json());
    assert.equal((await fetch(`${base}/api/rooms/${other.id}/images/${stored.id}`)).status, 404);
    assert.equal((await view("../../etc/passwd")).status, 404);
    // The workspace quota is enforced.
    app.rooms.db
      .prepare(
        "INSERT INTO images (id,workspace_id,mime,width,height,size,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("q".repeat(22), room, "image/png", 1, 1, 250 * 1024 * 1024, "0", Date.now());
    assert.equal((await upload(png(2, 2))).status, 413);
    app.rooms.db.prepare("DELETE FROM images WHERE id=?").run("q".repeat(22));

    // URL import refuses non-https and private/internal destinations before connecting.
    // Each refusal must come from the guard itself (its message), not a failed connection.
    for (const [url, reason] of [
      ["http://example.com/a.png", /Only https/],
      ["https://127.0.0.1/a.png", /private address/],
      ["https://localhost/a.png", /private address/],
      ["https://169.254.169.254/latest/meta-data/", /private address/],
      ["https://[::1]/a.png", /private address/],
      ["https://10.0.0.5/a.png", /private address/],
      ["https://user:pass@example.com/a.png", /password/],
      ["not a url", /full image link/],
    ] as const) {
      response = await fetch(`${base}/api/rooms/${room}/images/import`, {
        method: "POST",
        headers: { ...owner.headers, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const text = await response.text();
      assert.equal(response.status, 400, url + " " + text);
      assert.match(text, reason, url);
    }
    for (const address of [
      "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "127.0.0.1",
      "fd00::1", "fe80::1", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1",
    ])
      assert.equal(isPublicAddress(address), false, address);
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      assert.equal(isPublicAddress(address), true, address);

    // Images survive a restart and appear in the operator snapshot used for backups.
    await app.close();
    app = createApp({ dbPath, origins: [DEFAULT_ORIGIN] });
    base = await listen();
    assert.equal(sha(Buffer.from(await (await view(stored.id)).arrayBuffer())), sha(diagram));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../../scripts/snapshot.mjs", import.meta.url))],
      { env: { ...process.env, DB_PATH: dbPath }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    const snapshotPath = join(directory, "snapshot.sqlite");
    await writeFile(snapshotPath, stdout);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const restored = Buffer.concat(
      snapshot
        .prepare("SELECT data FROM image_chunks WHERE image_id=? ORDER BY seq")
        .all(big.id)
        .map((row) => row.data as Uint8Array),
    );
    snapshot.close();
    assert.equal(sha(restored), sha(large));

    // Deleting the workspace deletes its images.
    assert.equal(
      (await fetch(`${base}/api/rooms/${room}`, { method: "DELETE", headers: owner.headers })).status,
      200,
    );
    assert.equal(
      Number(app.rooms.db.prepare("SELECT COUNT(*) AS n FROM images WHERE workspace_id=?").get(room)!.n),
      0,
    );
    // …including their stored bytes (no orphaned chunks).
    assert.equal(Number(app.rooms.db.prepare("SELECT COUNT(*) AS n FROM image_chunks").get()!.n), 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("image URL import follows safe redirects, re-checks every hop, and enforces the size limit", async () => {
  const gif = animatedGif;
  const server = createServer((req, res) => {
    if (req.url === "/diagram.gif") res.writeHead(200, { "content-type": "image/gif" }).end(gif);
    else if (req.url === "/moved") res.writeHead(302, { location: "/diagram.gif" }).end();
    else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
    else if (req.url === "/huge") {
      res.writeHead(200);
      res.end(Buffer.alloc(16 * 1024 * 1024));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Tests opt in to plain http and loopback; production never passes these options.
    const local = { allowHttp: true, allowPrivate: true };
    assert.deepEqual(await fetchImage(base + "/moved", local), gif);
    await assert.rejects(fetchImage(base + "/loop", local), /redirects too many times/);
    await assert.rejects(fetchImage(base + "/huge", local), /15 MB/);
    await assert.rejects(fetchImage(base + "/missing", local), /HTTP 404/);
    // Without the opt-in, the same loopback server is refused at connect time.
    await assert.rejects(fetchImage(base + "/diagram.gif", { allowHttp: true }), /private address/);
  } finally {
    server.close();
  }
});
