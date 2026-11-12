import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { reconcileImageRefs } from "../src/database.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";
import { setup, until } from "./folderFixture.js";

// Image references after a rollback and roll-forward. The previous release edits documents
// without maintaining image references; at startup this release brings every lesson's
// references back in line with its saved documents, and only ever restrictively: links that
// are gone lose their access, links of unknown provenance gain none. Provenance recorded by
// this release (Phase 3) is never upgraded, so pasted image IDs stay powerless.

type S = Awaited<ReturnType<typeof setup>>;

// What the previous release does to a lesson: it changes the document text in both the live
// state and the documents table, and leaves image_refs alone.
function previousReleaseEdit(s: S, folderId: string | null, change: (files: Y.Map<Y.Map<unknown>>) => void) {
  const db = new DatabaseSync(s.dbPath);
  const row = folderId
    ? db.prepare("SELECT state FROM folders WHERE id=?").get(folderId)
    : db.prepare("SELECT state FROM rooms WHERE id=?").get(s.id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row!.state as Uint8Array);
  const files = doc.getMap<Y.Map<unknown>>("documents");
  change(files);
  const state = Y.encodeStateAsUpdate(doc);
  if (folderId) db.prepare("UPDATE folders SET state=? WHERE id=?").run(state, folderId);
  else db.prepare("UPDATE rooms SET state=? WHERE id=?").run(state, s.id);
  db.prepare("DELETE FROM documents WHERE room_id=? AND folder_id IS ?").run(s.id, folderId);
  const insert = db.prepare("INSERT INTO documents (id,room_id,filename,language,content,created_at,updated_at,folder_id,position) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const [id, f] of files)
    insert.run(id, s.id, f.get("filename") as string, f.get("language") as string, String(f.get("content")), f.get("createdAt") as number, f.get("updatedAt") as number, folderId, (f.get("position") as number) ?? 0);
  db.close();
  doc.destroy();
}
const link = (s: S, image: string) => `\n\n![x](/api/rooms/${s.id}/images/${image})\n`;
const text = (files: Y.Map<Y.Map<unknown>>, id: string) => files.get(id)!.get("content") as Y.Text;
const ref = (s: S, image: string, folder: string) =>
  s.app.rooms.db.prepare("SELECT vouched FROM image_refs WHERE image_id=? AND folder_id IS ?").get(image, folder)?.vouched as number | undefined;
const seen = async (s: S, image: string, headers: Record<string, string>) => (await s.call(`/rooms/${s.id}/images/${image}`, "GET", undefined, headers)).status;
// Runs the reconciliation on the stopped database and expects it to change nothing.
const unchangedByReconcile = (s: S) => {
  const db = new DatabaseSync(s.dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  const { removed, added } = reconcileImageRefs(db);
  db.close();
  assert.deepEqual({ removed, added }, { removed: 0, added: 0 });
};

test("after a rollback and roll-forward, removed links lose access and links of unknown provenance gain none", async () => {
  const s = await setup();
  try {
    const viewer = await signUp(s.base, origin, "Folder Viewer");
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "POST", { email: viewer.email, role: "viewer" }, s.owner.headers)).status, 201);
    // A second image uploaded into the shared folder and shown by a second file there; an image
    // of the unrelated folder, legitimately shown there.
    const second = await s.image(s.shared);
    const secondDoc = await s.doc(s.shared, "two.md", "two" + link(s, second));
    const unrelatedImage = await s.image(s.unrelated);
    await s.doc(s.unrelated, "pic.md", "pic" + link(s, unrelatedImage));
    const v = viewer.headers;
    assert.deepEqual(
      [await seen(s, s.sharedImage, v), await seen(s, second, v), await seen(s, s.siblingImage, v), await seen(s, unrelatedImage, v)],
      [200, 200, 404, 404],
      "before: only the shared folder's own images",
    );
    // Normal operation: references already match the documents, so nothing changes.
    await s.restart(() => unchangedByReconcile(s));
    // Rolled back: the owner removes one image link, adds links to two images from other
    // folders and deletes a file, all with the previous release (no reference upkeep).
    await s.restart(() =>
      previousReleaseEdit(s, s.shared, (files) => {
        const t = text(files, s.docs.shared);
        const value = t.toString();
        t.delete(0, value.length);
        t.insert(0, value.replace(/!\[diagram\]\([^)]*\)/, "(image removed)") + link(s, s.siblingImage) + link(s, unrelatedImage));
        files.delete(secondDoc);
      }),
    );
    const content = (await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "GET", undefined, s.owner.headers)).json.content as string;
    assert.ok(!content.includes(s.sharedImage) && content.includes(s.siblingImage), "the previous release's edit is what the lesson holds");
    assert.deepEqual(
      [await seen(s, s.sharedImage, v), await seen(s, second, v), await seen(s, s.siblingImage, v), await seen(s, unrelatedImage, v)],
      [404, 404, 404, 404],
      "after: removed links and the deleted file lose access; the new links (unknown provenance) gain none",
    );
    for (const image of [s.sharedImage, second, s.siblingImage, unrelatedImage])
      assert.equal(await seen(s, image, s.owner.headers), 200, "the owner still sees every image");
    assert.deepEqual([ref(s, s.sharedImage, s.shared), ref(s, second, s.shared), ref(s, s.siblingImage, s.shared), ref(s, unrelatedImage, s.shared)], [undefined, undefined, 0, 0]);
    assert.equal(ref(s, unrelatedImage, s.unrelated), 1, "other lessons' provenance is untouched");
    // Recovery: someone who can see the image places it again (remove the link, then add it).
    const put = async (body: string) =>
      assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "PUT", { content: body }, { ...s.owner.headers, "if-match": "*" })).status, 200);
    await put(content.replace(link(s, s.siblingImage), ""));
    await put(content);
    assert.equal(await seen(s, s.siblingImage, v), 200, "re-placed by the owner: vouched");
    assert.equal(await seen(s, unrelatedImage, v), 404, "the other one stays hidden until someone places it");
    // A second restart with nothing changed in between changes nothing.
    await s.restart(() => unchangedByReconcile(s));
    assert.deepEqual([await seen(s, s.siblingImage, v), await seen(s, unrelatedImage, v)], [200, 404]);
  } finally {
    await s.close();
  }
});

test("pasted image IDs stay powerless through live edits, REST writes, restarts and reconnect replays", async () => {
  const s = await setup();
  try {
    const editor = await signUp(s.base, origin, "Folder Editor"),
      viewer = await signUp(s.base, origin, "Folder Viewer");
    for (const [who, role] of [[editor, "editor"], [viewer, "viewer"]] as const)
      assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "POST", { email: who.email, role }, s.owner.headers)).status, 201);
    const parentImage = await s.image(s.parent),
      unrelatedImage = await s.image(s.unrelated),
      rootImage = await s.image(null);
    const both = async (image: string) => [await seen(s, image, editor.headers), await seen(s, image, viewer.headers)];
    const ownerText = async () => (await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "GET", undefined, s.owner.headers)).json.content as string;
    const file = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("documents").get(s.docs.shared)!.get("content") as Y.Text;
    // 1. The folder Editor pastes an image ID from outside their folder, live.
    let live = s.connect(s.id, { folder: s.shared, cookie: editor.cookie });
    await until(() => live.provider.synced);
    file(live.doc).insert(file(live.doc).length, link(s, s.siblingImage));
    await until(() => s.app.rooms.db.prepare("SELECT 1 FROM image_refs WHERE image_id=? AND folder_id=?").get(s.siblingImage, s.shared) !== undefined);
    assert.deepEqual(await both(s.siblingImage), [404, 404], "live paste grants nothing");
    // 2. ...and through the REST API.
    const current = await ownerText();
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "PUT", { content: current + link(s, unrelatedImage) }, { ...editor.headers, "if-match": "*" })).status, 200);
    assert.deepEqual(await both(unrelatedImage), [404, 404], "REST paste grants nothing");
    // 3. Restarts (with the startup reconciliation) don't upgrade them.
    await s.restart();
    assert.deepEqual([...(await both(s.siblingImage)), ...(await both(unrelatedImage))], [404, 404, 404, 404], "still nothing after a restart");
    assert.deepEqual([ref(s, s.siblingImage, s.shared), ref(s, unrelatedImage, s.shared)], [0, 0]);
    // ...nor a rollback in which the owner happens to edit the same file.
    await s.restart(() => previousReleaseEdit(s, s.shared, (files) => text(files, s.docs.shared).insert(0, "edited during rollback ")));
    assert.ok((await ownerText()).startsWith("edited during rollback "));
    assert.deepEqual([...(await both(s.siblingImage)), ...(await both(unrelatedImage))], [404, 404, 404, 404], "still nothing after a rollback edit");
    // 4. Reconnect replay: the Editor goes offline, pastes another ID, reconnects. The text
    // arrives as a sync reply (a replay), which never vouches.
    live = s.connect(s.id, { folder: s.shared, cookie: editor.cookie });
    await until(() => live.provider.synced);
    live.provider.disconnect();
    await until(() => !live.provider.wsconnected);
    file(live.doc).insert(file(live.doc).length, link(s, parentImage));
    live.provider.connect();
    await until(() => live.provider.synced);
    for (let i = 0; i < 100 && !(await ownerText()).includes(parentImage); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok((await ownerText()).includes(parentImage), "the replayed text arrived");
    assert.deepEqual(await both(parentImage), [404, 404], "a replayed paste grants nothing");
    // 5. Even the owner's offline edit is a replay, so it doesn't vouch either (fail-safe);
    // the same link typed while connected does.
    const owner = s.connect(s.id, { folder: s.shared, cookie: s.owner.cookie });
    await until(() => owner.provider.synced);
    owner.provider.disconnect();
    await until(() => !owner.provider.wsconnected);
    file(owner.doc).insert(file(owner.doc).length, link(s, rootImage));
    owner.provider.connect();
    await until(() => owner.provider.synced);
    for (let i = 0; i < 100 && !(await ownerText()).includes(rootImage); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await both(rootImage), [404, 404], "the owner's replayed link doesn't vouch");
    const t = file(owner.doc), at = t.toString().indexOf(link(s, rootImage));
    t.delete(at, link(s, rootImage).length);
    await until(() => !s.app.rooms.db.prepare("SELECT 1 FROM image_refs WHERE image_id=? AND folder_id=?").get(rootImage, s.shared));
    t.insert(t.length, link(s, rootImage));
    for (let i = 0; i < 100 && (await seen(s, rootImage, viewer.headers)) !== 200; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await both(rootImage), [200, 200], "typed live by the owner (who can see it): vouched");
    assert.deepEqual([...(await both(s.siblingImage)), ...(await both(unrelatedImage)), ...(await both(parentImage))], [404, 404, 404, 404, 404, 404], "the pasted IDs are still powerless");
  } finally {
    await s.close();
  }
});
