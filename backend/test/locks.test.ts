import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { openDatabase } from "../src/database.js";
import { zonedToUtc } from "../src/locks.js";
import { fileNames, fileText, lockSetup, pause, PNG, SECRET, until } from "./lockFixture.js";

// Content locks: workspace, folder, nested folder and file locks, visible or hidden, enforced on
// REST, WebSocket, images and folder changes; delegated permissions; scheduled releases.

test("migration: additive, safe to run again, and workspaces without locks answer exactly as before", async () => {
  const s = await lockSetup();
  try {
    const before = await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.student.headers);
    assert.equal(before.status, 200);
    assert.ok(!before.text.includes('"lock"') && !before.text.includes("workspaceLock"), "no lock fields without locks");
    // Opening the same database again (a restart) changes nothing.
    await s.restart(() => {
      const db = openDatabase(s.dbPath);
      for (const table of ["content_locks", "lock_permissions", "lock_events", "live_sessions", "live_session_members", "live_images"])
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
      db.close();
    });
    const after = await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.student.headers);
    assert.equal(after.text, before.text, "identical tree after re-running the migration");
  } finally {
    await s.close();
  }
});

test("a visibly locked folder shows its name and padlock, but nothing inside opens: REST, WebSocket, files and blocks", async () => {
  const s = await lockSetup();
  try {
    assert.equal((await s.lock([{ kind: "folder", id: s.week1 }], "lock")).status, 200);
    for (const [who, headers] of [["student", s.student.headers], ["anonymous", {}], ["workspace editor", s.editor.headers]] as const) {
      const tree = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, headers)).json;
      const week1 = tree.folders.find((f: any) => f.id === s.week1);
      assert.deepEqual(week1.lock, { state: "locked", releaseAt: null }, `${who}: padlock, no settings`);
      const solutions = tree.documents.find((d: any) => d.id === s.files.solutions);
      assert.equal(solutions.lock.state, "inherited", `${who}: files inside are locked by the parent`);
      for (const path of [`/documents/${s.files.solutions}/content`, `/documents/${s.files.intro}/content?folder=${s.week1}`, `/blocks?folder=${s.week1}`]) {
        const r = await s.call(`/rooms/${s.id}${path}`, "GET", undefined, headers);
        assert.equal(r.status, 423, `${who} ${path}`);
        assert.ok(!r.text.includes(SECRET));
      }
    }
    // The owner keeps full access and sees how the lock is set up.
    const own = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.owner.headers)).json;
    assert.deepEqual(own.folders.find((f: any) => f.id === s.week1).lock, { state: "locked", releaseAt: null, canOpen: true, visibility: "visible", zone: null, hidden: false });
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, s.owner.headers)).status, 200);
    // Live: the student's connection to the locked lesson is a blank copy; the owner's has everything.
    const student = s.connect(s.id, { folder: s.week1 });
    const owner = s.connect(s.id, { folder: s.week1, cookie: s.owner.cookie });
    await until(() => student.provider.synced && owner.provider.synced);
    assert.deepEqual(fileNames(student.doc), []);
    assert.deepEqual(fileNames(owner.doc), ["Introduction.md", "Lab-solutions.sh"]);
    assert.ok(!Buffer.concat(student.frames).toString("latin1").includes(SECRET), "no locked text on the student's wire");
    // Other weeks are unaffected.
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.networking}/content`, "GET", undefined, s.student.headers)).status, 200);
  } finally {
    await s.close();
  }
});

test("hidden content does not exist for restricted people: tree, REST and WebSocket answer like a missing item", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "folder", id: s.week3 }], "lock", { visibility: "hidden" });
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock", { visibility: "hidden" });
    const tree = await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.student.headers);
    assert.ok(!tree.json.folders.some((f: any) => f.id === s.week3 || f.id === s.labs), "hidden folder and its subfolder are gone");
    assert.ok(!tree.json.documents.some((d: any) => [s.files.solutions, s.files.git, s.files.lab].includes(d.id)));
    assert.ok(!tree.text.includes("Week 03") && !tree.text.includes("Lab-solutions"));
    const missingFolder = "00000000-0000-0000-0000-000000000000";
    for (const [hidden, missing] of [
      [`/blocks?folder=${s.week3}`, `/blocks?folder=${missingFolder}`],
      [`/documents/${s.files.lab}/content`, `/documents/${missingFolder}/content?folder=${missingFolder}`],
    ]) {
      const a = await s.call(`/rooms/${s.id}${hidden}`, "GET", undefined, s.student.headers);
      const b = await s.call(`/rooms/${s.id}${missing}`, "GET", undefined, s.student.headers);
      assert.deepEqual([a.status, a.text], [b.status, b.text], hidden);
    }
    const file = await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, s.student.headers);
    assert.deepEqual([file.status, file.json.error], [404, "File not found."]);
    assert.equal(await s.upgrade(`/ws/${s.id}?folder=${s.week3}&doc=new`, s.student.cookie), 404);
    assert.equal(await s.upgrade(`/ws/${s.id}?folder=${s.labs}&doc=new`), 404);
    // The owner still sees and opens everything.
    const own = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.owner.headers)).json;
    assert.equal(own.folders.find((f: any) => f.id === s.week3).lock.visibility, "hidden");
    assert.equal(own.folders.find((f: any) => f.id === s.labs).lock.state, "inherited");
  } finally {
    await s.close();
  }
});

test("a locked file inside an available lesson: restricted people get a live copy without it, in both directions", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock");
    const student = s.connect(s.id, { folder: s.week1 });
    const guest = s.connect(s.id, { folder: s.week1, token: s.editLink });
    const owner = s.connect(s.id, { folder: s.week1, cookie: s.owner.cookie });
    await until(() => student.provider.synced && guest.provider.synced && owner.provider.synced);
    assert.deepEqual(fileNames(student.doc), ["Introduction.md"]);
    assert.deepEqual(fileNames(guest.doc), ["Introduction.md"], "an Edit Link guest is restricted too");
    assert.deepEqual(fileNames(owner.doc), ["Introduction.md", "Lab-solutions.sh"]);
    for (const c of [student, guest]) assert.ok(!Buffer.concat(c.frames).toString("latin1").includes(SECRET));
    // The owner types: the student sees it live; the locked file never reaches them.
    const ownText = (name: string) =>
      [...owner.doc.getMap<Y.Map<unknown>>("documents").values()].find((f) => f.get("filename") === name)!.get("content") as Y.Text;
    ownText("Introduction.md").insert(0, "Hello ");
    ownText("Lab-solutions.sh").insert(0, "# more answers SOLUTION-SECRET-2\n");
    await until(() => fileText(student.doc, "Introduction.md")!.startsWith("Hello "));
    // The guest editor types in the copy: the owner receives it in the real lesson.
    const guestText = [...guest.doc.getMap<Y.Map<unknown>>("documents").values()][0].get("content") as Y.Text;
    guestText.insert(guestText.length, "\nGuest note");
    await until(() => fileText(owner.doc, "Introduction.md")!.endsWith("Guest note"));
    await until(() => fileText(student.doc, "Introduction.md")!.endsWith("Guest note"));
    // Concurrent typing on both copies converges to the same text everywhere.
    ownText("Introduction.md").insert(0, "A");
    guestText.insert(0, "B");
    await until(() => fileText(owner.doc, "Introduction.md") === fileText(guest.doc, "Introduction.md") && fileText(student.doc, "Introduction.md") === fileText(owner.doc, "Introduction.md"));
    assert.match(fileText(owner.doc, "Introduction.md")!, /^(AB|BA)Hello/);
    await pause(150);
    const saved = await s.call(`/rooms/${s.id}/documents/${s.files.intro}/content`, "GET", undefined, s.owner.headers);
    assert.ok(saved.json.content.endsWith("Guest note"), "mirrored edits are saved with the lesson");
    assert.ok(!Buffer.concat(student.frames).toString("latin1").includes("SOLUTION-SECRET-2"));
    // REST: the locked file is refused to restricted people (read and write).
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, { authorization: "Bearer " + s.editLink })).status, 423);
    assert.equal(
      (await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "PUT", { content: "x", baseVersion: "*" }, { authorization: "Bearer " + s.editLink })).status,
      423,
    );
  } finally {
    await s.close();
  }
});

test("lock changes apply at once: sockets switch copies, copies gain and lose files live, Explorers are told", async () => {
  const s = await lockSetup();
  try {
    const student = s.connect(s.id, { folder: s.week1 });
    const owner = s.connect(s.id, { folder: s.week1, cookie: s.owner.cookie });
    await until(() => student.provider.synced && owner.provider.synced);
    assert.deepEqual(fileNames(student.doc), ["Introduction.md", "Lab-solutions.sh"]);
    // Locking the file: the student's full copy is closed (4001) and it reconnects to a copy without it.
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock");
    await until(() => student.resets === 1 && student.provider.synced && fileNames(student.doc).length === 1, 5000, "student reset");
    assert.deepEqual(fileNames(student.doc), ["Introduction.md"]);
    assert.equal(owner.resets, 0, "the owner keeps its connection");
    assert.ok(owner.notices.some((n) => n.tree), "the owner's Explorer is told to refresh");
    // Locking the whole folder: the same copy empties live (no reconnect needed).
    await s.lock([{ kind: "folder", id: s.week1 }], "lock");
    await until(() => fileNames(student.doc).length === 0, 5000, "blank");
    assert.equal(student.resets, 1);
    // Unlocking the folder: the file lock stays (independent locks), the introduction returns.
    await s.lock([{ kind: "folder", id: s.week1 }], "unlock");
    await until(() => fileNames(student.doc).length === 1, 5000, "intro back");
    assert.deepEqual(fileNames(student.doc), ["Introduction.md"]);
    // Releasing the file: no copy needed any more, the student switches back to the lesson itself.
    await s.lock([{ kind: "file", id: s.files.solutions }], "unlock");
    await until(() => student.resets === 2 && student.provider.synced && fileNames(student.doc).length === 2, 5000, "full again");
    assert.ok(fileText(student.doc, "Lab-solutions.sh")!.includes(SECRET));
  } finally {
    await s.close();
  }
});

test("inheritance: a locked workspace locks everything; unlocking a child never bypasses a locked parent", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "folder", id: s.labs }], "lock");
    await s.lock([{ kind: "workspace" }], "lock");
    const tree = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.student.headers)).json;
    assert.deepEqual(tree.workspaceLock, { state: "locked", releaseAt: null });
    assert.ok(tree.folders.every((f: any) => f.lock), "every folder shows a lock");
    assert.equal(tree.folders.find((f: any) => f.id === s.week3).lock.state, "inherited");
    assert.equal(tree.folders.find((f: any) => f.id === s.labs).lock.state, "locked");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.root}/content`, "GET", undefined, s.student.headers)).status, 423);
    // Unlocking Labs (child) while the workspace is locked: still locked by the parent.
    await s.lock([{ kind: "folder", id: s.labs }], "unlock");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, s.student.headers)).status, 423);
    // Re-lock Labs, then unlock the workspace: Labs stays locked, everything else opens.
    await s.lock([{ kind: "folder", id: s.labs }], "lock");
    await s.lock([{ kind: "workspace" }], "unlock");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.git}/content`, "GET", undefined, s.student.headers)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, s.student.headers)).status, 423);
    // The workspace root lesson of a locked workspace is a blank live copy (never a 404).
    await s.lock([{ kind: "workspace" }], "lock", { visibility: "hidden" });
    const root = s.connect(s.id, {});
    await until(() => root.provider.synced);
    assert.deepEqual(fileNames(root.doc), []);
  } finally {
    await s.close();
  }
});

test("bulk lock and unlock are one transaction, recorded in the history, and refuse unknown items", async () => {
  const s = await lockSetup();
  try {
    const targets = [{ kind: "folder", id: s.week2 }, { kind: "folder", id: s.week3 }, { kind: "file", id: s.files.intro }];
    const r = await s.lock(targets, "lock");
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, 3);
    assert.equal(r.json.locks.length, 3);
    // One unknown item: nothing changes.
    const bad = await s.lock([{ kind: "folder", id: s.week1 }, { kind: "folder", id: "00000000-0000-0000-0000-000000000000" }], "lock");
    assert.equal(bad.status, 404);
    assert.equal((await s.call(`/rooms/${s.id}/locks`, "GET", undefined, s.owner.headers)).json.locks.length, 3);
    assert.equal((await s.lock(targets, "unlock")).json.changed, 3);
    const history = (await s.call(`/rooms/${s.id}/locks/history?kind=folder&id=${s.week2}`, "GET", undefined, s.owner.headers)).json.events;
    assert.deepEqual(history.map((e: any) => e.action), ["unlocked", "locked"]);
    assert.equal(history[0].actor, "Owner");
  } finally {
    await s.close();
  }
});

test("lock management: only the owner and delegates within their scope; editors and viewers can't, and get no lock details", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "folder", id: s.week1 }], "lock");
    // An ordinary workspace Editor: keeps editing elsewhere, can't manage locks, can't open locked content.
    assert.equal((await s.lock([{ kind: "folder", id: s.week2 }], "lock", {}, s.editor.headers)).status, 404);
    assert.equal((await s.call(`/rooms/${s.id}/locks`, "GET", undefined, s.editor.headers)).status, 404);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, s.editor.headers)).status, 423);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.networking}/content`, "PUT", { content: "edited", baseVersion: "*" }, s.editor.headers)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, s.editor.headers)).json.canManageLocks, undefined);
    assert.equal((await s.call(`/rooms/${s.id}/lock-permissions`, "GET", undefined, s.editor.headers)).status, 404);
    // The owner delegates Week 03 to the TA (a workspace Viewer): manage + schedule + open locked content there.
    const grant = await s.call(`/rooms/${s.id}/lock-permissions`, "POST", { email: s.ta.email, folderId: s.week3, manage: true, schedule: true, access: true }, s.owner.headers);
    assert.equal(grant.status, 201, grant.text);
    assert.equal((await s.call(`/rooms/${s.id}`, "GET", undefined, s.ta.headers)).json.canManageLocks, true);
    assert.equal((await s.lock([{ kind: "folder", id: s.labs }], "lock", { visibility: "hidden" }, s.ta.headers)).status, 200, "inside the scope");
    assert.equal((await s.lock([{ kind: "folder", id: s.week2 }], "lock", {}, s.ta.headers)).status, 403, "outside the scope");
    assert.equal((await s.lock([{ kind: "workspace" }], "lock", {}, s.ta.headers)).status, 403, "the workspace needs a workspace-wide grant");
    assert.equal((await s.call(`/rooms/${s.id}/lock-permissions`, "GET", undefined, s.ta.headers)).status, 403, "delegation is the owner's");
    // The TA opens the hidden locked Labs (their scope) but not Week 01 (outside it), and still can't edit (Viewer share).
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, s.ta.headers)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, s.ta.headers)).status, 423);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "PUT", { content: "x", baseVersion: "*" }, s.ta.headers)).status, 403);
    // A lock permission never grants access: an outsider with a delegation still sees nothing of a Restricted workspace.
    // Removing the delegation takes it away at once.
    const permissions = (await s.call(`/rooms/${s.id}/lock-permissions`, "GET", undefined, s.owner.headers)).json.permissions;
    await s.call(`/rooms/${s.id}/lock-permissions/${permissions[0].id}`, "DELETE", undefined, s.owner.headers);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, s.ta.headers)).status, 404);
  } finally {
    await s.close();
  }
});

test("delegated access through a team, and lock permissions never grant access without sharing", async () => {
  const s = await lockSetup();
  try {
    await s.call(`/rooms/${s.id}/visibility`, "PUT", { visibility: "private" }, s.owner.headers);
    const team = (await s.call("/teams", "POST", { name: "TAs" }, s.owner.headers)).json;
    const teamId = team.id ?? team.team?.id;
    assert.ok(teamId, JSON.stringify(team));
    const r = await s.call(`/rooms/${s.id}/lock-permissions`, "POST", { teamId, access: true, manage: false }, s.owner.headers);
    assert.equal(r.status, 201, r.text);
    await s.lock([{ kind: "folder", id: s.week1 }], "lock");
    // The owner belongs to the team, but someone with only the permission (no share) sees nothing.
    const outsider = await (await import("./helpers.js")).signUp(s.base, undefined, "Outsider");
    const grant = await s.call(`/rooms/${s.id}/lock-permissions`, "POST", { email: outsider.email, access: true, manage: true }, s.owner.headers);
    assert.equal(grant.status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/tree`, "GET", undefined, outsider.headers)).status, 404);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "GET", undefined, outsider.headers)).status, 404);
  } finally {
    await s.close();
  }
});

test("time zones and daylight saving: wall-clock times convert exactly; skipped times are refused", () => {
  assert.equal(new Date(zonedToUtc("2027-03-15", "08:00", "America/New_York")).toISOString(), "2027-03-15T12:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2027-01-15", "08:00", "America/New_York")).toISOString(), "2027-01-15T13:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2027-03-28", "09:00", "Europe/London")).toISOString(), "2027-03-28T08:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2027-07-01", "00:00", "Asia/Kolkata")).toISOString(), "2027-06-30T18:30:00.000Z");
  assert.equal(new Date(zonedToUtc("2027-04-04", "02:30", "Australia/Sydney")).toISOString(), "2027-04-03T15:30:00.000Z", "repeated hour: first occurrence");
  // 2027-03-14 02:30 doesn't exist in New York (clocks jump 02:00 -> 03:00).
  assert.throws(() => zonedToUtc("2027-03-14", "02:30", "America/New_York"), /doesn't exist/);
  // 2027-11-07 01:30 happens twice in New York: the first (EDT, UTC-4).
  assert.equal(new Date(zonedToUtc("2027-11-07", "01:30", "America/New_York")).toISOString(), "2027-11-07T05:30:00.000Z");
  assert.throws(() => zonedToUtc("2027-02-30", "08:00", "UTC"), /valid date/);
  assert.throws(() => zonedToUtc("2027-02-10", "08:00", "Mars/Olympus"), /time zone/);
});

test("scheduled releases: exactly once, never touching other locks, overdue ones processed after a restart", async () => {
  const s = await lockSetup();
  try {
    // Through the API: must be in the future; stored as UTC with its zone.
    const past = await s.lock([{ kind: "folder", id: s.week2 }], "schedule", { release: { date: "2020-01-01", time: "08:00", timeZone: "America/New_York" } });
    assert.equal(past.status, 400);
    const future = await s.lock([{ kind: "folder", id: s.week2 }], "schedule", { release: { date: "2099-03-15", time: "08:00", timeZone: "America/New_York" } });
    assert.equal(future.status, 200, future.text);
    assert.equal(future.json.locks[0].releaseAt, Date.parse("2099-03-15T12:00:00Z"));
    assert.equal(future.json.locks[0].zone, "America/New_York");
    const tree = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.student.headers)).json;
    assert.deepEqual(tree.folders.find((f: any) => f.id === s.week2).lock, { state: "locked", releaseAt: Date.parse("2099-03-15T12:00:00Z") });
    // A release due in a moment (set directly: the API needs 30 s ahead), with a locked parent next to it.
    await s.lock([{ kind: "folder", id: s.week3 }], "lock");
    await s.lock([{ kind: "folder", id: s.labs }], "lock");
    s.app.rooms.db.prepare("UPDATE content_locks SET release_at=? WHERE target_id=?").run(Date.now() + 300, s.labs);
    s.app.rooms.db.prepare("UPDATE content_locks SET release_at=? WHERE target_id=?").run(Date.now() + 300, s.week1);
    (s.app as any).rooms.locks.schedule();
    const student = s.connect(s.id, { folder: s.week2 });
    await until(() => student.provider.synced);
    await until(() => !s.app.rooms.db.prepare("SELECT 1 FROM content_locks WHERE target_id=?").get(s.labs), 4000, "release");
    // Labs was released, but its parent Week 03 is still locked: Labs stays closed.
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, s.student.headers)).status, 423);
    // A second sweep finds nothing: exactly one release event.
    assert.equal((s.app as any).rooms.locks.releaseDue(), 0);
    const events = (await s.call(`/rooms/${s.id}/locks/history?kind=folder&id=${s.labs}`, "GET", undefined, s.owner.headers)).json.events;
    assert.equal(events.filter((e: any) => e.action === "released").length, 1);
    assert.equal(events[0].actor, "Scheduled release");
    await until(() => student.notices.some((n) => n.tree), 3000, "explorer notice");
    // Overdue while the server was stopped: released at startup.
    await s.restart(async () => {
      const db = openDatabase(s.dbPath);
      db.prepare("UPDATE content_locks SET release_at=? WHERE target_id=?").run(Date.now() - 60_000, s.week2);
      db.close();
    });
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.networking}/content`, "GET", undefined, s.student.headers)).status, 200);
    // Changing a release keeps one lock; cancelling keeps it locked.
    await s.lock([{ kind: "folder", id: s.week3 }], "schedule", { release: { date: "2099-01-01", time: "09:00", timeZone: "UTC" } });
    await s.lock([{ kind: "folder", id: s.week3 }], "cancel");
    const rows = (await s.call(`/rooms/${s.id}/locks`, "GET", undefined, s.owner.headers)).json.locks;
    assert.deepEqual(rows.find((l: any) => l.id === s.week3).releaseAt, null);
  } finally {
    await s.close();
  }
});

test("images: one used only by a locked file can't be loaded by restricted people, even by its ID", async () => {
  const s = await lockSetup();
  try {
    const upload = async () => (await s.call(`/rooms/${s.id}/images?folder=${s.week1}`, "POST", PNG, s.owner.headers)).json.id as string;
    const secret = await upload(),
      shown = await upload();
    const put = async (file: string, content: string) => {
      const r = await s.call(`/rooms/${s.id}/documents/${file}/content`, "PUT", { content, baseVersion: "*" }, s.owner.headers);
      assert.equal(r.status, 200);
    };
    await put(s.files.solutions, `![answer](/api/rooms/${s.id}/images/${secret})\n`);
    await put(s.files.intro, `![diagram](/api/rooms/${s.id}/images/${shown})\n`);
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock");
    const get = (image: string, headers = s.student.headers) => s.call(`/rooms/${s.id}/images/${image}`, "GET", undefined, headers);
    assert.equal((await get(secret)).status, 404);
    assert.equal((await get(shown)).status, 200);
    assert.equal((await get(secret, s.owner.headers)).status, 200);
    // An image uploaded and placed in an open file while the lesson has a locked file shows.
    // (A just-uploaded image that no file uses yet is visible only until the lesson's next save
    // drops the unused reference: that timing predates locks, so it isn't asserted here.)
    const fresh = await upload();
    await put(s.files.intro, `![diagram](/api/rooms/${s.id}/images/${shown})\n\n![new](/api/rooms/${s.id}/images/${fresh})\n`);
    assert.equal((await get(fresh)).status, 200, "a new image in an open file shows");
    // The solutions' image is still refused after that save.
    assert.equal((await get(secret)).status, 404);
    await s.lock([{ kind: "folder", id: s.week1 }], "lock");
    assert.equal((await get(shown)).status, 404, "nothing of a locked lesson");
  } finally {
    await s.close();
  }
});

test("folder changes: restricted editors can't change locked folders or delete folders holding locked content; deleting removes locks", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "folder", id: s.labs }], "lock", { visibility: "hidden" });
    await s.lock([{ kind: "folder", id: s.week1 }], "lock");
    const as = s.editor.headers;
    assert.equal((await s.call(`/rooms/${s.id}/folders`, "POST", { name: "Inside", parent_id: s.week1 }, as)).status, 423);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.week1}`, "PATCH", { name: "Renamed" }, as)).status, 423);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.labs}`, "PATCH", { name: "Renamed" }, as)).status, 404);
    const del = await s.call(`/rooms/${s.id}/folders/${s.week3}`, "DELETE", undefined, as);
    assert.equal(del.status, 423, "Week 03 holds hidden locked Labs");
    assert.equal((await s.call(`/rooms/${s.id}/documents?folder=${s.week1}`, "POST", { filename: "x.md", language: "markdown" }, as)).status, 423);
    // Reordering root folders: the editor sees all (none hidden at root); Week 03's own order keeps hidden Labs in place.
    const extra = await s.folder("Extra", s.week3);
    const order = await s.call(`/rooms/${s.id}/folders/order`, "PATCH", { parent_id: s.week3, ids: [extra] }, as);
    assert.equal(order.status, 200, order.text);
    // The owner deletes Week 03: its locks go with it.
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.week3}`, "DELETE", undefined, s.owner.headers)).status, 200);
    assert.equal(s.app.rooms.db.prepare("SELECT COUNT(*) AS n FROM content_locks WHERE target_id=?").get(s.labs)!.n, 0);
    // A deleted file takes its lock along.
    await s.lock([{ kind: "file", id: s.files.networking }], "lock");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.networking}?folder=${s.week2}`, "DELETE", undefined, s.owner.headers)).status, 200);
    assert.equal(s.app.rooms.db.prepare("SELECT COUNT(*) AS n FROM content_locks WHERE target_id=?").get(s.files.networking)!.n, 0);
  } finally {
    await s.close();
  }
});

test("restricted editors reorder the files they can open; locked files keep their place", async () => {
  const s = await lockSetup();
  try {
    const third = await s.doc(s.week1, "Commands.txt", "ls", "plaintext");
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock");
    // Order: Introduction, Lab-solutions (locked), Commands. The editor swaps the two it sees.
    const r = await s.call(`/rooms/${s.id}/documents/order?folder=${s.week1}`, "PATCH", { ids: [third, s.files.intro] }, s.editor.headers);
    assert.equal(r.status, 200, r.text);
    const tree = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, s.owner.headers)).json;
    const order = tree.documents.filter((d: any) => d.folder_id === s.week1).sort((a: any, b: any) => a.position - b.position).map((d: any) => d.filename);
    assert.deepEqual(order, ["Commands.txt", "Lab-solutions.sh", "Introduction.md"]);
    // Naming the locked file (or leaving one out) is refused.
    assert.equal((await s.call(`/rooms/${s.id}/documents/order?folder=${s.week1}`, "PATCH", { ids: [s.files.intro, third, s.files.solutions] }, s.editor.headers)).status, 400);
  } finally {
    await s.close();
  }
});

test("folder-only recipients: their shared folder's locks apply to them like everyone else", async () => {
  const s = await lockSetup();
  try {
    await s.call(`/rooms/${s.id}/visibility`, "PUT", { visibility: "private" }, s.owner.headers);
    const reader = await (await import("./helpers.js")).signUp(s.base, undefined, "Reader");
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.week3}/shares`, "POST", { email: reader.email, role: "viewer" }, s.owner.headers)).status, 201);
    await s.lock([{ kind: "folder", id: s.labs }], "lock", { visibility: "hidden" });
    const tree = (await s.call(`/rooms/${s.id}/tree`, "GET", undefined, reader.headers)).json;
    assert.deepEqual(tree.folders.map((f: any) => f.id), [s.week3]);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.lab}/content`, "GET", undefined, reader.headers)).status, 404);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.files.git}/content`, "GET", undefined, reader.headers)).status, 200);
  } finally {
    await s.close();
  }
});

test("clients from before this release: a filtered lesson asks them to reload instead of merging documents", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock");
    const old = s.connect(s.id, { folder: s.week1, legacy: true });
    await until(() => old.closes.length > 0);
    assert.equal(old.closes[0], 1008);
    assert.match(old.reasons[0], /Reload the page/);
    assert.ok(!Buffer.concat(old.frames).toString("latin1").includes(SECRET));
    // Legacy clients of unaffected lessons keep working unchanged.
    const fine = s.connect(s.id, { folder: s.week2, legacy: true });
    await until(() => fine.provider.synced);
    assert.deepEqual(fileNames(fine.doc), ["Networking.md"]);
    assert.ok(!fine.notices.length, "no new message types for old clients");
  } finally {
    await s.close();
  }
});

test("activity never names hidden items to people locks restrict (REST and live)", async () => {
  const s = await lockSetup();
  try {
    await s.lock([{ kind: "file", id: s.files.solutions }], "lock", { visibility: "hidden" });
    const editorSocket = s.connect(s.id, { folder: s.week2, cookie: s.editor.cookie });
    await until(() => editorSocket.provider.synced);
    // The owner works on the hidden solutions (and on a visible file).
    await s.call(`/rooms/${s.id}/documents/${s.files.solutions}/content`, "PUT", { content: "echo new answers", baseVersion: "*" }, s.owner.headers);
    await s.call(`/rooms/${s.id}/documents/${s.files.networking}/content`, "PUT", { content: "# Networking v2", baseVersion: "*" }, s.owner.headers);
    await pause(200);
    const labels = (headers: Record<string, string>) =>
      s.call(`/rooms/${s.id}/activity?limit=50`, "GET", undefined, headers).then((r) => r.json.entries.map((e: any) => e.label));
    const editorSees = await labels(s.editor.headers);
    assert.ok(editorSees.includes("Networking.md"));
    assert.ok(!editorSees.includes("Lab-solutions.sh"), "the editor's feed never names the hidden file");
    assert.ok((await labels(s.owner.headers)).includes("Lab-solutions.sh"), "the owner's does");
    await until(() => Buffer.concat(editorSocket.frames).toString("latin1").includes("Networking.md"), 3000, "live activity");
    assert.ok(!Buffer.concat(editorSocket.frames).toString("latin1").includes("Lab-solutions"), "nor does the live push");
  } finally {
    await s.close();
  }
});
