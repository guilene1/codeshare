import type * as Y from "yjs";
import { orderedBlocks, validateBlockCapacity } from "./blocks.js";
import { addDocument, type Room } from "./rooms.js";

export const SNIPPETS_MIGRATED = "snippetsToMarkdown";
export function snippetsMigrated(doc: Y.Doc) {
  return !!doc.getMap("migrations").get(SNIPPETS_MIGRATED);
}
// A fence longer than any backtick run inside the code keeps the block intact.
export function fence(language: string, content: string) {
  const longest = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${language}\n${content.replace(/\n$/, "")}\n${marks}`;
}
// Copies a lesson's standalone snippets into a Markdown lesson document, in order.
// The original snippets stay in the document state (hidden) so a rollback loses nothing.
export function migrateSnippets(room: Room) {
  const blocks = orderedBlocks(room.doc);
  if (!blocks.length || snippetsMigrated(room.doc))
    return { migrated: 0, file: null as string | null };
  const markdown =
    "# Code blocks\n\nThese snippets were moved here from the Code Blocks panel.\n\n" +
    blocks
      .map(
        (block) =>
          (block.title ? `## ${block.title.replace(/\n/g, " ")}\n\n` : "") +
          fence(block.language, block.content),
      )
      .join("\n\n") +
    "\n";
  const names = new Set(
    [...room.doc.getMap<Y.Map<unknown>>("documents").values()].map(
      (file) => file.get("filename") as string,
    ),
  );
  let name = "code-blocks.md";
  for (let n = 2; names.has(name); n++) name = `code-blocks-${n}.md`;
  validateBlockCapacity(room, markdown);
  let id = "";
  room.doc.transact(() => {
    id = addDocument(room, name, "markdown", markdown);
    room.doc.getMap("migrations").set(SNIPPETS_MIGRATED, Date.now());
  });
  return { migrated: blocks.length, file: id };
}
