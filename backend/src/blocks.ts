import { randomUUID } from "node:crypto";
import type * as Y from "yjs";
import { language, MAX_CONTENT, type Room } from "./rooms.js";

export type CodeBlock = {
  id: string;
  workspace_id: string;
  folder_id?: string | null;
  title: string;
  language: string;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
};
export const MAX_BLOCKS = 1000;
export function blockFields(value: Record<string, unknown>) {
  const title = value.title ?? "";
  if (typeof title !== "string" || title.length > 120)
    throw new Error("Block titles must be at most 120 characters.");
  if (
    typeof value.content !== "string" ||
    !value.content.trim() ||
    Buffer.byteLength(value.content) > 64 * 1024
  )
    throw new Error("Enter code up to 64 KB per block.");
  return {
    title: title.trim(),
    language: language(value.language),
    content: value.content,
  };
}
export function orderedBlocks(doc: Y.Doc) {
  return [...doc.getMap<CodeBlock>("codeBlocks").values()].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}
export function validateBlockCapacity(
  room: Room,
  content: string,
  replacing?: string,
) {
  let bytes = Buffer.byteLength(content);
  for (const block of orderedBlocks(room.doc))
    if (block.id !== replacing) bytes += Buffer.byteLength(block.content);
  for (const file of room.doc.getMap<Y.Map<unknown>>("documents").values())
    bytes += Buffer.byteLength((file.get("content") as Y.Text).toString());
  if (bytes > MAX_CONTENT)
    throw new Error("Workspace content limit exceeded (512 KB).");
}
export function createBlock(room: Room, body: Record<string, unknown>) {
  const map = room.doc.getMap<CodeBlock>("codeBlocks");
  if (map.size >= MAX_BLOCKS)
    throw new Error("A workspace supports up to 1,000 code blocks.");
  const fields = blockFields(body);
  validateBlockCapacity(room, fields.content);
  const now = Date.now();
  const block: CodeBlock = {
    ...fields,
    id: randomUUID(),
    workspace_id: room.workspaceId,
    folder_id: room.folderId,
    position: map.size,
    created_at: now,
    updated_at: now,
  };
  map.set(block.id, block);
  return block;
}
export function reorderBlocks(room: Room, ids: unknown) {
  const map = room.doc.getMap<CodeBlock>("codeBlocks");
  if (
    !Array.isArray(ids) ||
    ids.length !== map.size ||
    new Set(ids).size !== map.size ||
    ids.some((id) => typeof id !== "string" || !map.has(id))
  )
    throw new Error("Provide each block ID exactly once in the desired order.");
  room.doc.transact(() => {
    ids.forEach((id: string, position: number) => {
      const block = map.get(id)!;
      if (block.position !== position)
        map.set(id, { ...block, position, updated_at: Date.now() });
    });
  });
}
