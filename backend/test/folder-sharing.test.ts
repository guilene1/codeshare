import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";
import { MISSING, noSecrets, pause, PNG, setup, until } from "./folderFixture.js";

// Folder sharing, Phase 2: folder grants (account and team, Viewer or Editor) reach the shared
// folder and everything inside it, and nothing else. Every refusal looks exactly like a
// workspace that doesn't exist, over REST and WebSocket.

test("a folder-only recipient reaches only the shared folder and what's inside it; everything else matches a missing workspace", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader");
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "viewer", s.owner.user.id);
    const as = reader.headers;
    // Their view: the shared folder (no parent path), its subfolder and their files only.
    const info = await s.call(`/rooms/${s.id}`, "GET", undefined, as);
    assert.equal(info.status, 200);
    assert.deepEqual(info.json, { id: s.id, scoped: true, ownerName: "Owner", folders: [{ id: s.shared, name: "full-detail-backup", role: "viewer" }] });
    const tree = await s.call(`/rooms/${s.id}/tree`, "GET", undefined, as);
    // (Order follows position, then the random folder ID, so compare as a set.)
    assert.deepEqual(
      tree.json.folders.map((f: any) => `${f.id}<${f.parent_id}`).sort(),
      [`${s.shared}<null`, `${s.nested}<${s.shared}`].sort(),
    );
    assert.deepEqual(tree.json.documents.map((d: any) => d.filename).sort(), ["n-nested.md", "s-shared.md"]);
    noSecrets(info.text + tree.text, "info/tree");
    // Allowed reads inside the share, with or without ?folder=.
    for (const [path, label] of [
      [`/documents/${s.docs.shared}/content?folder=${s.shared}`, "shared file"],
      [`/documents/${s.docs.shared}/content`, "shared file by ID alone"],
      [`/documents/${s.docs.nested}/content`, "nested file (inherited)"],
      [`/blocks?folder=${s.nested}`, "nested lesson blocks"],
      [`/images/${s.sharedImage}`, "image used in the shared folder"],
    ])
      assert.equal((await s.call(`/rooms/${s.id}${path}`, "GET", undefined, as)).status, 200, label);
    // Everything else: byte-for-byte the response for a workspace that doesn't exist.
    const outside: [string, string, unknown?][] = [
      ["GET", "/summary"], ["GET", "/activity"], ["GET", "/shares"], ["GET", "/team-shares"], ["GET", "/editor-link"],
      ["GET", "/blocks"], ["GET", `/blocks?folder=${s.parent}`], ["GET", `/blocks?folder=${s.sibling}`], ["GET", `/blocks?folder=${s.unrelated}`],
      ["GET", "/blocks?folder=00000000-0000-0000-0000-000000000000"],
      ["GET", `/documents/${s.docs.root}/content`], ["GET", `/documents/${s.docs.parent}/content`], ["GET", `/documents/${s.docs.sibling}/content`],
      ["GET", `/documents/${s.docs.unrelated}/content`], ["GET", `/documents/${s.docs.shared}/content?folder=${s.sibling}`],
      ["GET", "/documents/00000000-0000-0000-0000-000000000000/content"],
      ["GET", `/images/${s.siblingImage}`], ["GET", "/images/AAAAAAAAAAAAAAAAAAAAAA"],
      ["PUT", "/visibility", { visibility: "link" }], ["POST", "/shares", { email: reader.email, role: "editor" }],
      ["POST", "/editor-link", {}], ["PATCH", "", { name: "Taken" }], ["DELETE", ""], ["POST", "/claim", {}],
      ["POST", "/checkpoint", {}], ["POST", "/documents", { filename: "x.md", language: "markdown" }],
      ["POST", "/folders", { name: "x" }], ["POST", "/folders", { name: "x", parent_id: s.parent }],
      ["PATCH", "/folders/order", { ids: [s.parent, s.unrelated], parent_id: null }],
      ["PATCH", "/folders/order", { ids: [s.shared, s.sibling], parent_id: s.parent }],
      ["PATCH", `/folders/${s.parent}`, { name: "x" }], ["DELETE", `/folders/${s.unrelated}`], ["DELETE", `/folders/${s.sibling}`],
      ["POST", "/images", PNG],
    ];
    for (const [method, path, body] of outside) {
      const hidden = await s.call(`/rooms/${s.id}${path}`, method, body, as);
      const absent = await s.call(`/rooms/${MISSING}${path}`, method, body, as);
      assert.deepEqual([hidden.status, hidden.text], [absent.status, absent.text], `${method} ${path || "/"}: same as missing`);
      assert.equal(hidden.status, 404, `${method} ${path || "/"}`);
    }
    // A Viewer inside the share can't change anything there either.
    for (const [method, path, body] of [
      ["POST", `/documents?folder=${s.shared}`, { filename: "v.md", language: "markdown" }],
      ["PUT", `/documents/${s.docs.shared}/content?folder=${s.shared}`, { content: "x", baseVersion: "*" }],
      ["POST", "/folders", { name: "x", parent_id: s.shared }],
      ["PATCH", `/folders/${s.nested}`, { name: "x" }],
      ["POST", `/images?folder=${s.shared}`, PNG],
    ] as const)
      assert.equal((await s.call(`/rooms/${s.id}${path}`, method, body, as)).status, 403, `viewer ${method} ${path}`);
    // The workspace owner still sees everything.
    assert.equal((await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.owner.headers)).json.folders.length, 5);
  } finally {
    await s.close();
  }
});

test("a folder Editor manages the contents but not the shared folder itself, and nothing outside it", async () => {
  const s = await setup();
  try {
    const writer = await signUp(s.base, origin, "Writer");
    s.app.folderSharing.shareWithUser(s.id, s.shared, writer.user.id, "editor", s.owner.user.id);
    const as = writer.headers;
    const created = await s.call(`/rooms/${s.id}/documents?folder=${s.shared}`, "POST", { filename: "new.md", language: "markdown", content: "hello" }, as);
    assert.equal(created.status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${created.json.id}/content?folder=${s.shared}`, "PUT", { content: "hello again", baseVersion: "*" }, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.nested}/content`, "PUT", { content: "nested edit", baseVersion: "*" }, as)).status, 200, "inherited Editor in the subfolder");
    const sub = await s.call(`/rooms/${s.id}/folders`, "POST", { name: "drafts", parent_id: s.shared }, as);
    assert.equal(sub.status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${sub.json.id}`, "PATCH", { name: "drafts-2" }, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/folders/order`, "PATCH", { ids: [sub.json.id, s.nested], parent_id: s.shared }, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.nested}`, "PATCH", { name: "nested-renamed" }, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${sub.json.id}`, "DELETE", undefined, as)).status, 200);
    // The shared folder itself: readable, but not renamed or deleted by its recipients.
    for (const [method, body] of [["PATCH", { name: "Taken over" }], ["DELETE", undefined]] as const) {
      const r = await s.call(`/rooms/${s.id}/folders/${s.shared}`, method, body, as);
      assert.equal(r.status, 403, `${method} shared folder`);
      assert.match(r.json.error, /shared folder itself/);
    }
    // Uploading: into the share works and the image shows at once; into the root doesn't exist.
    const uploaded = await s.call(`/rooms/${s.id}/images?folder=${s.shared}`, "POST", PNG, as);
    assert.equal(uploaded.status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/images/${uploaded.json.id}`, "GET", undefined, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/images`, "POST", PNG, as)).status, 404);
    // Outside the share stays invisible, also for an Editor.
    for (const [method, path, body] of [
      ["POST", `/documents?folder=${s.sibling}`, { filename: "x.md", language: "markdown" }],
      ["PUT", `/documents/${s.docs.parent}/content`, { content: "x", baseVersion: "*" }],
      ["POST", "/folders", { name: "x", parent_id: s.parent }],
      ["GET", `/images/${s.siblingImage}`],
    ] as const)
      assert.equal((await s.call(`/rooms/${s.id}${path}`, method, body, as)).status, 404, `${method} ${path}`);
    const parentText = await s.call(`/rooms/${s.id}/documents/${s.docs.parent}/content`, "GET", undefined, s.owner.headers);
    assert.equal(parentText.json.content, "parent text PARENT-SECRET", "nothing outside changed");
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, s.owner.headers)).json.name, "Interview prep WS-SECRET");
  } finally {
    await s.close();
  }
});

test("folder-only sockets: live editing inside the share, nothing outside, no workspace presence or activity, immediate revocation", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader");
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "viewer", s.owner.user.id);
    // Root, parent, sibling, unrelated and unknown lessons look like a missing workspace.
    for (const lesson of [undefined, s.parent, s.sibling, s.unrelated, "00000000-0000-0000-0000-000000000000"])
      assert.deepEqual(
        [await s.upgrade(s.id, lesson, reader.cookie), await s.upgrade(MISSING, lesson, reader.cookie)],
        [404, 404],
        `lesson ${lesson ?? "root"}`,
      );
    assert.equal(await s.upgrade(s.id, s.nested, reader.cookie), 101, "inherited subfolder");
    const ownerLive = s.connect(s.id, { folder: s.shared, cookie: s.owner.cookie });
    const readerLive = s.connect(s.id, { folder: s.shared, cookie: reader.cookie });
    await until(() => ownerLive.provider.synced && readerLive.provider.synced);
    const text = (doc: Y.Doc) => ([...doc.getMap<Y.Map<unknown>>("documents").values()][0].get("content") as Y.Text);
    assert.match(text(readerLive.doc).toString(), /Shared notes/);
    text(ownerLive.doc).insert(0, "Live: ");
    await until(() => text(readerLive.doc).toString().startsWith("Live: "));
    // A Viewer's write is refused.
    text(readerLive.doc).insert(0, "hack ");
    await until(() => readerLive.closes.includes(1008));
    // Upgraded to Editor: edits flow both ways, still without workspace presence or activity.
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "editor", s.owner.user.id);
    const editorLive = s.connect(s.id, { folder: s.shared, cookie: reader.cookie });
    await until(() => editorLive.provider.synced);
    text(editorLive.doc).insert(0, "Recipient: ");
    await until(() => text(ownerLive.doc).toString().startsWith("Recipient: "));
    await s.call(`/rooms/${s.id}/documents?folder=${s.unrelated}`, "POST", { filename: "activity-UNRELATED-SECRET.md", language: "markdown" }, s.owner.headers);
    await pause(400);
    assert.equal(editorLive.frames.filter((f) => f[0] === 4).length, 0, "no workspace presence or activity");
    assert.ok(ownerLive.frames.some((f) => f[0] === 4), "the owner still gets presence and activity");
    // A workspace rename isn't announced to someone who can't see the workspace name.
    assert.equal((await s.call(`/rooms/${s.id}`, "PATCH", { name: "Renamed WS-SECRET" }, s.owner.headers)).status, 200);
    await until(() => ownerLive.notices.includes('{"workspace":true}'));
    await pause(200);
    assert.ok(!editorLive.notices.includes('{"workspace":true}'), "folder-only socket not told about the rename");
    // (Phase 3) Tree notices are scoped: the file created in the unrelated folder above isn't
    // announced to them, while a change inside their folder is.
    assert.ok(!editorLive.notices.includes('{"tree":true}'), "not told about a change outside the share");
    await s.call(`/rooms/${s.id}/documents?folder=${s.nested}`, "POST", { filename: "inside.md", language: "markdown" }, s.owner.headers);
    await until(() => editorLive.notices.includes('{"tree":true}'));
    noSecrets(Buffer.concat(editorLive.frames).toString("latin1"), "folder editor's live frames");
    // Revoked: the socket closes at once and can't come back; the owner is untouched.
    assert.equal(s.app.folderSharing.unshareUser(s.id, s.shared, reader.user.id), true);
    await until(() => editorLive.closes.includes(1008));
    assert.equal(await s.upgrade(s.id, s.shared, reader.cookie), 404);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "GET", undefined, reader.headers)).status, 404);
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, reader.headers)).status, 404);
    assert.deepEqual(ownerLive.closes, [], "the owner stayed connected");
  } finally {
    await s.close();
  }
});

test("grants combine (highest wins), teams follow membership, and losing one grant keeps access through another", async () => {
  const s = await setup();
  try {
    const member = await signUp(s.base, origin, "Member");
    const team = (await s.call("/teams", "POST", { name: "Prep team" }, s.owner.headers)).json.id as string;
    const join = async () => {
      assert.equal((await s.call(`/teams/${team}/invitations`, "POST", { email: member.email }, s.owner.headers)).status, 201);
      const invitation = (await s.call("/me/invitations", "GET", undefined, member.headers)).json.invitations[0];
      assert.equal((await s.call(`/me/invitations/${invitation.id}/accept`, "POST", {}, member.headers)).status, 200);
    };
    await join();
    s.app.folderSharing.shareWithTeam(s.id, s.shared, team, "editor", s.owner.user.id);
    s.app.folderSharing.shareWithUser(s.id, s.nested, member.user.id, "viewer", s.owner.user.id);
    // Team Editor on the shared folder, direct Viewer on the subfolder: Editor wins there.
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.nested}/content`, "PUT", { content: "team edit", baseVersion: "*" }, member.headers)).status, 200);
    const live = s.connect(s.id, { folder: s.nested, cookie: member.cookie });
    await until(() => live.provider.synced);
    // Removed from the team: the socket closes (Editor -> Viewer), reconnects as a Viewer
    // through the direct share on the subfolder, and loses the parent shared folder.
    assert.equal((await s.call(`/teams/${team}/members/${member.user.id}`, "DELETE", undefined, s.owner.headers)).status, 200);
    await until(() => live.closes.includes(1008));
    assert.equal(await s.upgrade(s.id, s.nested, member.cookie), 101, "still a Viewer through the direct share");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.nested}/content`, "PUT", { content: "x", baseVersion: "*" }, member.headers)).status, 403);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "GET", undefined, member.headers)).status, 404, "the parent shared folder is gone");
    assert.deepEqual((await s.call(`/rooms/${s.id}`, "GET", undefined, member.headers)).json.folders, [{ id: s.nested, name: "nested-notes", role: "viewer" }], "only the subfolder, without its parents");
    // Back in the team: Editor again.
    await join();
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "PUT", { content: "back", baseVersion: "*" }, member.headers)).status, 200);
    // Team deleted, direct share removed: nothing left.
    assert.equal((await s.call(`/teams/${team}`, "DELETE", undefined, s.owner.headers)).status, 200);
    s.app.folderSharing.unshareUser(s.id, s.nested, member.user.id);
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, member.headers)).status, 404);
    assert.equal(await s.upgrade(s.id, s.nested, member.cookie), 404);

    // A workspace Viewer (direct share) with a folder Editor grant edits only in that folder,
    // keeps workspace-level reading elsewhere, and never manages sharing or sees presence.
    const viewer = await signUp(s.base, origin, "Viewer");
    assert.equal((await s.call(`/rooms/${s.id}/shares`, "POST", { email: viewer.email, role: "viewer" }, s.owner.headers)).status, 201);
    s.app.folderSharing.shareWithUser(s.id, s.shared, viewer.user.id, "editor", s.owner.user.id);
    assert.equal((await s.call(`/rooms/${s.id}/documents?folder=${s.shared}`, "POST", { filename: "v.md", language: "markdown" }, viewer.headers)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/documents?folder=${s.parent}`, "POST", { filename: "v.md", language: "markdown" }, viewer.headers)).status, 403);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.parent}/content`, "GET", undefined, viewer.headers)).status, 200);
    const viewerInfo = (await s.call(`/rooms/${s.id}`, "GET", undefined, viewer.headers)).json;
    assert.deepEqual([viewerInfo.access, viewerInfo.canShare, viewerInfo.name], ["viewer", false, "Interview prep WS-SECRET"]);
    assert.equal((await s.call(`/rooms/${s.id}/shares`, "GET", undefined, viewer.headers)).status, 403);
    const viewerLive = s.connect(s.id, { folder: s.shared, cookie: viewer.cookie });
    await until(() => viewerLive.provider.synced);
    await pause(300);
    assert.equal(viewerLive.frames.filter((f) => f[0] === 4).length, 0, "no presence or activity for a workspace Viewer");
    // Losing the workspace share keeps the folder grant: Editor in the folder, nothing else.
    assert.equal((await s.call(`/rooms/${s.id}/shares/${viewer.user.id}`, "DELETE", undefined, s.owner.headers)).status, 200);
    await until(() => viewerLive.closes.includes(1008));
    assert.equal(await s.upgrade(s.id, s.shared, viewer.cookie), 101);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.parent}/content`, "GET", undefined, viewer.headers)).status, 404);
  } finally {
    await s.close();
  }
});

test("folder sharing needs a Restricted workspace; existing sharing, Edit Links and student links are unchanged", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader");
    const db = s.app.rooms.db;
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "viewer", s.owner.user.id);
    // Can't become "Anyone with the link" while a folder is shared on its own, through the
    // API or directly in the database.
    const blocked = await s.call(`/rooms/${s.id}/visibility`, "PUT", { visibility: "link" }, s.owner.headers);
    assert.equal(blocked.status, 409);
    assert.throws(() => db.prepare("UPDATE rooms SET visibility='link' WHERE id=?").run(s.id), /Remove folder shares/);
    // Folder shares need a folder of the same, Restricted workspace.
    const open = (await s.call("/rooms", "POST", { name: "Open class", language: "markdown", visibility: "link" }, s.owner.headers)).json.id;
    const openFolder = (await s.call(`/rooms/${open}/folders`, "POST", { name: "Week 1" }, s.owner.headers)).json.id;
    assert.throws(() => s.app.folderSharing.shareWithUser(open, openFolder, reader.user.id, "viewer", null), /Restricted workspaces/);
    assert.throws(() => s.app.folderSharing.shareWithUser(s.id, openFolder, reader.user.id, "viewer", null), /Folder not found/);
    assert.throws(
      () => db.prepare("INSERT INTO folder_shares (folder_id,workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,1,1)").run(openFolder, open, reader.user.id, "viewer"),
      /Restricted workspace/,
    );
    assert.throws(
      () => db.prepare("INSERT INTO folder_shares (folder_id,workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,1,1)").run(openFolder, s.id, reader.user.id, "viewer"),
      /Restricted workspace/,
    );
    assert.throws(() => s.app.folderSharing.shareWithUser(s.id, s.shared, s.owner.user.id, "viewer", null), /owner already has full access/);
    // The student link of the open workspace and the Edit Link of this one work as before.
    assert.equal((await s.call(`/rooms/${open}`)).json.access, "viewer");
    assert.equal(await s.upgrade(open), 101);
    const bearer = { authorization: "Bearer " + s.editLink };
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, bearer)).json.access, "editor");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.root}/content`, "GET", undefined, bearer)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/tree`, "GET", undefined, bearer)).json.folders.length, 5, "Edit Links see the whole workspace");
    // Deleting the shared folder removes its shares and closes its recipients' sessions.
    const live = s.connect(s.id, { folder: s.shared, cookie: reader.cookie });
    await until(() => live.provider.synced);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}`, "DELETE", undefined, s.owner.headers)).status, 200);
    await until(() => live.closes.includes(1008));
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM folder_shares WHERE workspace_id=?").get(s.id)!.n), 0);
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, reader.headers)).status, 404);
    // With no folder shares left, "Anyone with the link" is allowed again.
    assert.equal((await s.call(`/rooms/${s.id}/visibility`, "PUT", { visibility: "link" }, s.owner.headers)).status, 200);
  } finally {
    await s.close();
  }
});

test("lessons saved by earlier releases expose no workspace metadata to folder-only recipients", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader");
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "viewer", s.owner.user.id);
    // The shared lesson as the previous release stored it: whole tree and name embedded.
    const db = s.app.rooms.db;
    for (const room of [...s.app.rooms.active.values()]) if (room.workspaceId === s.id) s.app.rooms.release(room);
    const state = db.prepare("SELECT state FROM folders WHERE id=?").get(s.shared)!.state as Uint8Array;
    const legacy = new Y.Doc();
    Y.applyUpdate(legacy, state);
    legacy.getMap("catalog").set("tree", { folders: [{ name: "huntington-mlops-lead-prep PARENT-SECRET" }, { name: "sibling SIBLING-SECRET" }], documents: [{ filename: "root-ROOT-SECRET.md" }] });
    legacy.getMap("workspace").set("name", "Interview prep WS-SECRET");
    db.prepare("UPDATE folders SET state=? WHERE id=?").run(Y.encodeStateAsUpdate(legacy), s.shared);
    const live = s.connect(s.id, { folder: s.shared, cookie: reader.cookie });
    await until(() => live.provider.synced);
    await pause(200);
    noSecrets(Buffer.concat(live.frames).toString("latin1"), "legacy lesson frames");
    assert.deepEqual([live.doc.getMap("catalog").toJSON(), live.doc.getMap("workspace").toJSON()], [{}, {}]);
  } finally {
    await s.close();
  }
});

test("image references follow document content: backfilled on migration, updated on save", async () => {
  const s = await setup();
  try {
    const db = s.app.rooms.db;
    const refs = () => db.prepare("SELECT image_id, folder_id FROM image_refs WHERE workspace_id=? ORDER BY image_id, folder_id").all(s.id).map((r) => `${r.image_id}@${r.folder_id}`);
    assert.ok(refs().includes(`${s.sharedImage}@${s.shared}`) && refs().includes(`${s.siblingImage}@${s.sibling}`));
    // Removing the image from the shared document drops the reference at the next save.
    const reader = await signUp(s.base, origin, "Reader");
    s.app.folderSharing.shareWithUser(s.id, s.shared, reader.user.id, "viewer", s.owner.user.id);
    assert.equal((await s.call(`/rooms/${s.id}/images/${s.sharedImage}`, "GET", undefined, reader.headers)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "PUT", { content: "no image any more", baseVersion: "*" }, s.owner.headers)).status, 200);
    assert.ok(!refs().includes(`${s.sharedImage}@${s.shared}`));
    assert.equal((await s.call(`/rooms/${s.id}/images/${s.sharedImage}`, "GET", undefined, reader.headers)).status, 404);
    // The backfill: a database whose documents predate image_refs gets them on open.
    db.exec("DROP TABLE image_refs");
    const { openDatabase } = await import("../src/database.js");
    const reopened = openDatabase(db.location()!);
    const backfilled = reopened.prepare("SELECT image_id, folder_id FROM image_refs WHERE workspace_id=?").all(s.id).map((r) => `${r.image_id}@${r.folder_id}`);
    assert.ok(backfilled.includes(`${s.siblingImage}@${s.sibling}`));
    assert.ok(!backfilled.includes(`${s.sharedImage}@${s.shared}`));
    reopened.close();
  } finally {
    await s.close();
  }
});
