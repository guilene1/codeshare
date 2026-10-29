import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { equalHash, hashEditorToken, TOKEN_PATTERN } from "./access.js";

// Keeps Edit Links retrievable for the people who manage sharing. Each link is sealed with
// AES-256-GCM (bound to its workspace ID) under a key kept in its own file next to the
// database, never inside it, so database backups alone cannot reveal working links.
export class LinkVault {
  private key: Buffer;
  constructor(dbPath: string) {
    this.key = dbPath === ":memory:" ? randomBytes(32) : loadKey(join(dirname(dbPath), "edit-link.key"));
  }
  seal(workspaceId: string, token: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(workspaceId));
    const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
  }
  // The stored link, only while it is still the workspace's active link; otherwise undefined.
  open(workspaceId: string, sealed: unknown, activeHash: unknown) {
    if (typeof sealed !== "string" || typeof activeHash !== "string") return undefined;
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !data) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(workspaceId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const token = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
      return TOKEN_PATTERN.test(token) && equalHash(activeHash, hashEditorToken(token)) ? token : undefined;
    } catch {
      return undefined; // a different key (restored backup) or a damaged value
    }
  }
}
function loadKey(path: string) {
  try {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (key.length === 32) return key;
    throw new Error(`${path} does not hold a 32-byte key`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    writeFileSync(path, key.toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    // Another process created it first: use theirs.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadKey(path);
    throw error;
  }
}
