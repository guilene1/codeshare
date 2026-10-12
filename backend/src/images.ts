// Inline document images. Bytes are stored exactly as uploaded (no re-encoding, so
// resolution is preserved and GIFs stay animated) in 256 KB SQLite chunks: they are
// part of every database snapshot/backup, and serving streams one chunk at a time.
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Response } from "express";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_WORKSPACE_IMAGE_BYTES = 250 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 20_000;
export const MAX_IMAGE_PIXELS = 50_000_000;
const CHUNK = 256 * 1024;
export const IMAGE_ID = /^[A-Za-z0-9_-]{22}$/;

export type ImageInfo = { mime: string; width: number; height: number };

function httpError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Identifies the format from the file's own bytes (never the name or declared type)
// and reads its pixel size from the header. SVG and anything else is rejected.
export function sniffImage(data: Buffer): ImageInfo {
  const ascii = (start: number, end: number) => data.toString("latin1", start, end);
  let info: ImageInfo | null = null;
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && ascii(12, 16) === "IHDR")
    info = { mime: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  else if (data.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a"))
    info = { mime: "image/gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  else if (data.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const kind = ascii(12, 16);
    if (kind === "VP8 " && data.readUIntBE(23, 3) === 0x9d012a)
      info = {
        mime: "image/webp",
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
    else if (kind === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      info = { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    } else if (kind === "VP8X")
      info = {
        mime: "image/webp",
        width: data.readUIntLE(24, 3) + 1,
        height: data.readUIntLE(27, 3) + 1,
      };
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // Walk JPEG segments to the first start-of-frame marker.
    let offset = 2;
    while (offset + 9 < data.length && data[offset] === 0xff) {
      const marker = data[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        info = {
          mime: "image/jpeg",
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
        break;
      }
      offset += 2 + length;
    }
  }
  if (!info) throw httpError("Use a PNG, JPG, WebP or GIF image.", 415);
  const { width, height } = info;
  if (!width || !height) throw httpError("This image file is damaged or incomplete.", 415);
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
    throw httpError(
      `Images can be up to ${MAX_IMAGE_SIDE.toLocaleString("en-US")} pixels on a side and 50 megapixels.`,
      413,
    );
  return info;
}

export class Images {
  constructor(private db: DatabaseSync) {}
  used(workspaceId: string) {
    return Number(
      this.db
        .prepare("SELECT COALESCE(SUM(size),0) AS n FROM images WHERE workspace_id=?")
        .get(workspaceId)?.n,
    );
  }
  store(workspaceId: string, data: Buffer) {
    if (!data.length) throw httpError("The image is empty.");
    if (data.length > MAX_IMAGE_BYTES) throw httpError("Images can be up to 15 MB.", 413);
    const info = sniffImage(data);
    if (this.used(workspaceId) + data.length > MAX_WORKSPACE_IMAGE_BYTES)
      throw httpError("This workspace has reached its 250 MB image limit.", 413);
    const id = randomBytes(16).toString("base64url");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const insertChunk = this.db.prepare(
      "INSERT INTO image_chunks (image_id,seq,data) VALUES (?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO images (id,workspace_id,mime,width,height,size,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(id, workspaceId, info.mime, info.width, info.height, data.length, sha256, Date.now());
      for (let seq = 0; seq * CHUNK < data.length; seq++)
        insertChunk.run(id, seq, data.subarray(seq * CHUNK, (seq + 1) * CHUNK));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, ...info, size: data.length };
  }
  // Streams the original bytes chunk by chunk, so memory stays bounded however many
  // students open a large diagram at once.
  serve(workspaceId: string, imageId: string, res: Response, etagHeader?: string) {
    const image = IMAGE_ID.test(imageId)
      ? this.db
          .prepare("SELECT mime,size,sha256 FROM images WHERE id=? AND workspace_id=?")
          .get(imageId, workspaceId)
      : undefined;
    if (!image) {
      res.status(404).json({ error: "Image not found." });
      return;
    }
    const etag = `"${image.sha256}"`;
    res.setHeader("Content-Type", image.mime as string);
    // Image IDs never change content, so browsers may keep them; "private" keeps
    // shared caches out of it.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("ETag", etag);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (etagHeader === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("Content-Length", String(image.size));
    const chunk = this.db.prepare(
      "SELECT data FROM image_chunks WHERE image_id=? AND seq=?",
    );
    let seq = 0;
    const next = () => {
      while (!res.destroyed) {
        const row = chunk.get(imageId, seq++);
        if (!row) {
          res.end();
          return;
        }
        if (!res.write(row.data as Uint8Array)) {
          res.once("drain", next);
          return;
        }
      }
    };
    next();
  }
}

// Server-side import of an image URL. Only public HTTPS hosts: every address the name
// resolves to (checked at connect time, on every redirect) must be public, so links to
// localhost, private networks or the cloud metadata service can never be fetched.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  // No ::ffff:0:0/96 rule: BlockList applies it to every IPv4 address. IPv4-mapped
  // addresses are unwrapped and checked as IPv4 in isPublicAddress instead.
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");
export function isPublicAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  // Hex-form mapped addresses (::ffff:7f00:1) are refused outright.
  if (/^::ffff:/i.test(address)) return false;
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type Lookup = typeof lookup;
type FetchOptions = { allowPrivate?: boolean; allowHttp?: boolean; timeoutMs?: number };
export async function fetchImage(rawUrl: string, options: FetchOptions = {}): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError("Enter a full image link that starts with https://.");
  }
  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:"))
      throw httpError("Only https:// image links can be added.");
    if (url.username || url.password) throw httpError("Image links cannot contain a password.");
    // Node connects to IP-literal hosts without calling `lookup`, so check them here.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (!options.allowPrivate && isIP(literal) && !isPublicAddress(literal))
      throw httpError("That link points to a private address and cannot be added.");
    const response = await request(url, options);
    if (response.redirect) {
      if (redirects >= 3) throw httpError("That link redirects too many times.");
      url = new URL(response.redirect, url);
      continue;
    }
    return response.body!;
  }
}

function request(url: URL, options: FetchOptions) {
  const safeLookup: Lookup = ((hostname: string, opts: object, callback: Function) =>
    lookup(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as { address: string; family: number }[];
      if (!options.allowPrivate && (!list.length || list.some((a) => !isPublicAddress(a.address))))
        return callback(httpError("That link points to a private address and cannot be added."));
      // Node asks for one address unless `all` was requested.
      if ((opts as { all?: boolean }).all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    })) as unknown as Lookup;
  return new Promise<{ redirect?: string; body?: Buffer }>((resolve, reject) => {
    // Plain http is reachable only with allowHttp, which only tests pass.
    const client = url.protocol === "http:" ? http : https;
    const req = client.get(
      url,
      {
        lookup: safeLookup,
        timeout: options.timeoutMs ?? 10_000,
        headers: { "User-Agent": "Kodelumi-ImageImport/1.0", Accept: "image/*" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(httpError(`The image could not be downloaded (HTTP ${status}).`));
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES) {
          res.destroy();
          reject(httpError("Images can be up to 15 MB.", 413));
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (part: Buffer) => {
          size += part.length;
          if (size > MAX_IMAGE_BYTES) {
            res.destroy();
            reject(httpError("Images can be up to 15 MB.", 413));
          } else parts.push(part);
        });
        res.on("end", () => resolve({ body: Buffer.concat(parts) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(httpError("The image took too long to download.")));
    req.on("error", (error: Error & { status?: number }) =>
      reject(error.status ? error : httpError("The image could not be downloaded.")),
    );
  });
}
