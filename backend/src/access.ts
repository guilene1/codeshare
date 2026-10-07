import { createHash, timingSafeEqual } from "node:crypto";
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function hashEditorToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function equalHash(stored: unknown, supplied: string | undefined) {
  return (
    typeof stored === "string" &&
    /^[a-f0-9]{64}$/.test(stored) &&
    !!supplied &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(supplied, "hex"))
  );
}
