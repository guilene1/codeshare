import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";
import { MISSING, noSecrets, pause, PNG, setup, until } from "./folderFixture.js";

// Folder sharing, Phase 3: the REST API that lists, creates, updates and revokes folder
// shares; who may manage them; inherited versus direct grants; Shared with Me; live effects;
// scoped tree notices; and image provenance (a pasted image ID grants nothing).

type S = Awaited<ReturnType<typeof setup>>;
type Person = Awaited<ReturnType<typeof signUp>>;

async function joinTeam(s: S, team: string, member: Person, inviter: Person = s.owner) {
  assert.equal((await s.call(`/teams/${team}/invitations`, "POST", { email: member.email }, inviter.headers)).status, 201);
  for (const invitation of (await s.call("/me/invitations", "GET", undefined, member.headers)).json.invitations)
    assert.equal((await s.call(`/me/invitations/${invitation.id}/accept`, "POST", {}, member.headers)).status, 200);
}
const newTeam = async (s: S, name: string, by: Person = s.owner) =>
  (await s.call("/teams", "POST", { name }, by.headers)).json.id as string;

// Everyone with some relation to the workspace: the owner, a direct Editor (workspace share),
// a team-derived Editor (workspace team share), an Edit Link guest, a workspace Viewer, a
// folder-only Editor and Viewer of the shared folder, and an outsider.
async function cast(s: S) {
  const sign = (name: string) => signUp(s.base, origin, name);
  const directEditor = await sign("Direct Editor"),
    teamEditor = await sign("Team Editor"),
    viewer = await sign("Workspace Viewer"),
    folderEditor = await sign("Folder Editor"),
    folderViewer = await sign("Folder Viewer"),
    outsider = await sign("Outsider");
  const share = async (email: string, role: string) =>
    assert.equal((await s.call(`/rooms/${s.id}/shares`, "POST", { email, role }, s.owner.headers)).status, 201);
  await share(directEditor.email, "editor");
  await share(viewer.email, "viewer");
  const staff = await newTeam(s, "Staff");
  await joinTeam(s, staff, teamEditor);
  assert.equal((await s.call(`/rooms/${s.id}/team-shares`, "POST", { teamId: staff, role: "editor" }, s.owner.headers)).status, 201);
  for (const [who, role] of [[folderEditor, "editor"], [folderViewer, "viewer"]] as const)
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "POST", { email: who.email, role }, s.owner.headers)).status, 201);
  return { directEditor, teamEditor, viewer, folderEditor, folderViewer, outsider, staff, link: { authorization: "Bearer " + s.editLink } };
}

test("only the owner and direct Editors manage folder sharing; everyone else is refused, folder-only recipients and outsiders with the missing-workspace 404", async () => {
  const s = await setup();
  try {
    const c = await cast(s);
    const target = await signUp(s.base, origin, "Target");
    const club = await newTeam(s, "Club");
    // Shares the refused attempts would change.
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.nested}/shares`, "POST", { email: target.email, role: "viewer" }, s.owner.headers)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.nested}/team-shares`, "POST", { teamId: club, role: "viewer" }, s.owner.headers)).status, 201);
    const before = (await s.call(`/rooms/${s.id}/folder-shares`, "GET", undefined, s.owner.headers)).text;
    const operations: [string, string, unknown?][] = [
      ["GET", "/folder-shares"],
      ["GET", `/folders/${s.shared}/shares`],
      ["POST", `/folders/${s.shared}/shares`, { email: target.email, role: "editor" }],
      ["PATCH", `/folders/${s.nested}/shares/${target.user.id}`, { role: "editor" }],
      ["DELETE", `/folders/${s.nested}/shares/${target.user.id}`],
      ["POST", `/folders/${s.shared}/team-shares`, { teamId: club, role: "editor" }],
      ["PATCH", `/folders/${s.nested}/team-shares/${club}`, { role: "editor" }],
      ["DELETE", `/folders/${s.nested}/team-shares/${club}`],
    ];
    const refused: [string, Record<string, string>, 403 | 404][] = [
      ["team-derived Editor", c.teamEditor.headers, 403],
      ["Edit Link guest", c.link, 403],
      ["workspace Viewer", c.viewer.headers, 403],
      ["folder-only Editor", c.folderEditor.headers, 404],
      ["folder-only Viewer", c.folderViewer.headers, 404],
      ["outsider", c.outsider.headers, 404],
      ["anonymous", {}, 404],
    ];
    for (const [who, headers, status] of refused)
      for (const [method, path, body] of operations) {
        const r = await s.call(`/rooms/${s.id}${path}`, method, body, headers);
        assert.equal(r.status, status, `${who}: ${method} ${path}`);
        if (status === 404) {
          const absent = await s.call(`/rooms/${MISSING}${path}`, method, body, headers);
          assert.deepEqual([r.status, r.text], [absent.status, absent.text], `${who}: ${method} ${path} looks like a missing workspace`);
        } else noSecrets(r.text.replace(/WS-SECRET/g, ""), `${who} refusal`);
      }
    assert.equal((await s.call(`/rooms/${s.id}/folder-shares`, "GET", undefined, s.owner.headers)).text, before, "nothing changed");
    // The owner and a direct Editor: the full cycle, for accounts and teams.
    for (const [who, manager] of [["owner", s.owner], ["direct Editor", c.directEditor]] as const) {
      const as = manager.headers;
      const person = await signUp(s.base, origin, `Person of ${who}`);
      const team = await newTeam(s, `Team of ${who}`, manager);
      const base = `/rooms/${s.id}/folders/${s.shared}`;
      let r = await s.call(`${base}/shares`, "POST", { email: person.email, role: "viewer" }, as);
      assert.equal(r.status, 201, `${who} shares`);
      assert.ok(r.json.direct.people.some((p: any) => p.userId === person.user.id && p.role === "viewer"));
      r = await s.call(`${base}/shares`, "POST", { email: person.email, role: "editor" }, as);
      assert.equal(r.status, 200, `${who} re-shares (update)`);
      r = await s.call(`${base}/shares/${person.user.id}`, "PATCH", { role: "viewer" }, as);
      assert.equal(r.status, 200, `${who} changes the role`);
      assert.equal(r.json.direct.people.find((p: any) => p.userId === person.user.id).role, "viewer");
      r = await s.call(`${base}/shares/${person.user.id}`, "DELETE", undefined, as);
      assert.equal(r.status, 200, `${who} revokes`);
      assert.ok(!r.json.direct.people.some((p: any) => p.userId === person.user.id));
      r = await s.call(`${base}/team-shares`, "POST", { teamId: team, role: "viewer" }, as);
      assert.equal(r.status, 201, `${who} shares with their team`);
      assert.equal((await s.call(`${base}/team-shares/${team}`, "PATCH", { role: "editor" }, as)).json.direct.teams.find((t: any) => t.teamId === team).role, "editor");
      assert.equal((await s.call(`${base}/team-shares/${team}`, "DELETE", undefined, as)).status, 200);
      // Only teams they belong to.
      assert.equal((await s.call(`${base}/team-shares`, "POST", { teamId: who === "owner" ? (await newTeam(s, "Other", c.directEditor)) : club, role: "viewer" }, as)).status, 404);
    }
  } finally {
    await s.close();
  }
});

test("direct and inherited folder shares are listed apart; inherited ones can't be revoked from a child; validation", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader"),
      editor = await signUp(s.base, origin, "Editor");
    const as = s.owner.headers;
    const team = await newTeam(s, "Prep team");
    await joinTeam(s, team, reader);
    assert.equal((await s.call(`/rooms/${s.id}/shares`, "POST", { email: editor.email, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "POST", { email: reader.email, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/team-shares`, "POST", { teamId: team, role: "viewer" }, as)).status, 201);
    // The child lists them as inherited, with where they come from; nothing is direct.
    const child = (await s.call(`/rooms/${s.id}/folders/${s.nested}/shares`, "GET", undefined, as)).json;
    assert.deepEqual(child.folder, { id: s.nested, name: "nested-notes" });
    assert.deepEqual(child.direct, { people: [], teams: [] });
    assert.deepEqual(
      child.inherited.people.map((p: any) => [p.userId, p.role, p.from]),
      [[reader.user.id, "editor", { folderId: s.shared, name: "full-detail-backup" }]],
    );
    assert.deepEqual(child.inherited.teams.map((t: any) => [t.teamId, t.role, t.from.folderId]), [[team, "viewer", s.shared]]);
    // Inherited grants can't be changed or revoked on the child.
    for (const [method, path, body] of [
      ["DELETE", `/folders/${s.nested}/shares/${reader.user.id}`],
      ["PATCH", `/folders/${s.nested}/shares/${reader.user.id}`, { role: "viewer" }],
      ["DELETE", `/folders/${s.nested}/team-shares/${team}`],
      ["PATCH", `/folders/${s.nested}/team-shares/${team}`, { role: "editor" }],
    ] as const) {
      const r = await s.call(`/rooms/${s.id}${path}`, method, body, as);
      assert.equal(r.status, 409, `${method} ${path}`);
      assert.deepEqual(r.json.inheritedFrom, { folderId: s.shared, name: "full-detail-backup" });
      assert.match(r.json.error, /parent folder "full-detail-backup"/);
    }
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.nested}/content`, "PUT", { content: "still editing", baseVersion: "*" }, reader.headers)).status, 200, "inherited access intact");
    // A direct share on the child sits beside the inherited one; removing it keeps the
    // inherited Editor access (another valid grant).
    const both = (await s.call(`/rooms/${s.id}/folders/${s.nested}/shares`, "POST", { email: reader.email, role: "viewer" }, as)).json;
    assert.deepEqual([both.direct.people.map((p: any) => p.role), both.inherited.people.map((p: any) => p.role)], [["viewer"], ["editor"]]);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.nested}/shares/${reader.user.id}`, "DELETE", undefined, as)).status, 200);
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.nested}/content`, "PUT", { content: "and still", baseVersion: "*" }, reader.headers)).status, 200);
    // Overview: shared folders only, with their direct shares.
    const overview = (await s.call(`/rooms/${s.id}/folder-shares`, "GET", undefined, as)).json.folders;
    assert.deepEqual(overview.map((f: any) => [f.id, f.people.length, f.teams.length]), [[s.shared, 1, 1]]);
    // Validation.
    const shares = `/rooms/${s.id}/folders/${s.shared}/shares`;
    const refusals: [string, unknown, Record<string, string>, number, RegExp][] = [
      [shares, { email: reader.email, role: "owner" }, as, 400, /Viewer or Editor/],
      [shares, { email: "nobody@example.test", role: "viewer" }, as, 404, /No Kodelumi account/],
      [shares, { email: s.owner.email, role: "viewer" }, as, 400, /owner already has full access/],
      [shares, { email: editor.email, role: "viewer" }, editor.headers, 400, /yourself/],
      [`/rooms/${s.id}/folders/00000000-0000-0000-0000-000000000000/shares`, { email: reader.email, role: "viewer" }, as, 404, /Folder not found/],
      [`/rooms/${s.id}/folders/not-a-folder/shares`, { email: reader.email, role: "viewer" }, as, 404, /Folder not found/],
    ];
    for (const [path, body, headers, status, message] of refusals) {
      const r = await s.call(path, "POST", body, headers);
      assert.equal(r.status, status, `${path} ${JSON.stringify(body)}`);
      assert.match(r.json.error, message);
    }
    assert.equal((await s.call(`${shares}/${editor.user.id}`, "DELETE", undefined, as)).status, 404, "no share at all");
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "GET", undefined, as)).json.direct.people.length, 1, "refusals changed nothing");
    // Restricted workspaces only.
    const open = (await s.call("/rooms", "POST", { name: "Open class", language: "markdown", visibility: "link" }, as)).json.id;
    const week = (await s.call(`/rooms/${open}/folders`, "POST", { name: "Week 1" }, as)).json.id;
    const r = await s.call(`/rooms/${open}/folders/${week}/shares`, "POST", { email: reader.email, role: "viewer" }, as);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Restricted/);
  } finally {
    await s.close();
  }
});

test("Shared with Me lists shared folders by folder name and owner only, and follows shares and team membership", async () => {
  const s = await setup();
  try {
    const reader = await signUp(s.base, origin, "Reader");
    const team = await newTeam(s, "Prep team");
    await joinTeam(s, team, reader);
    const as = s.owner.headers;
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares`, "POST", { email: reader.email, role: "viewer" }, as)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.nested}/team-shares`, "POST", { teamId: team, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/team-shares`, "POST", { teamId: team, role: "editor" }, as)).status, 201);
    const shared = await s.call("/me/shared", "GET", undefined, reader.headers);
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.json.workspaces, [], "no workspace entry for a folder-only recipient");
    noSecrets(shared.text, "Shared with Me");
    const byId = new Map(shared.json.folders.map((f: any) => [f.folderId, f]));
    assert.equal(byId.size, 2);
    const top = byId.get(s.shared) as any;
    assert.deepEqual(Object.keys(top).sort(), ["folderId", "name", "ownerName", "role", "sharedAt", "via", "workspaceId"]);
    assert.deepEqual([top.name, top.ownerName, top.workspaceId, top.role], ["full-detail-backup", "Owner", s.id, "editor"], "highest of direct Viewer and team Editor");
    assert.deepEqual(top.via.map((v: any) => v.kind).sort(), ["direct", "team"]);
    assert.deepEqual((byId.get(s.nested) as any).via, [{ kind: "team", teamName: "Prep team" }]);
    // Leaving the team removes the team-derived entries at once.
    assert.equal((await s.call(`/teams/${team}/members/${reader.user.id}`, "DELETE", undefined, as)).status, 200);
    const after = (await s.call("/me/shared", "GET", undefined, reader.headers)).json.folders;
    assert.deepEqual(after.map((f: any) => [f.folderId, f.role, f.via]), [[s.shared, "viewer", [{ kind: "direct" }]]]);
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/shares/${reader.user.id}`, "DELETE", undefined, as)).status, 200);
    assert.deepEqual((await s.call("/me/shared", "GET", undefined, reader.headers)).json.folders, []);
  } finally {
    await s.close();
  }
});

test("share changes take effect at once on live sockets; removing one grant keeps access through another", async () => {
  const s = await setup();
  try {
    const a = await signUp(s.base, origin, "Recipient A"),
      b = await signUp(s.base, origin, "Recipient B");
    const as = s.owner.headers;
    const team = await newTeam(s, "Prep team");
    await joinTeam(s, team, a);
    const shares = `/rooms/${s.id}/folders/${s.shared}/shares`;
    assert.equal((await s.call(shares, "POST", { email: a.email, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(shares, "POST", { email: b.email, role: "viewer" }, as)).status, 201);
    const liveA = s.connect(s.id, { folder: s.shared, cookie: a.cookie }),
      liveB = s.connect(s.id, { folder: s.shared, cookie: b.cookie }),
      ownerLive = s.connect(s.id, { cookie: s.owner.cookie });
    await until(() => liveA.provider.synced && liveB.provider.synced && ownerLive.provider.synced);
    // A gains another folder: A (and only A) is told to re-read their tree; nobody disconnects.
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.unrelated}/shares`, "POST", { email: a.email, role: "viewer" }, as)).status, 201);
    await until(() => liveA.notices.includes('{"tree":true}'));
    assert.equal((await s.call(`/rooms/${s.id}/tree`, "GET", undefined, a.headers)).json.folders.some((f: any) => f.id === s.unrelated), true);
    await pause(200);
    // The owner manages sharing, so only the data-free "folder shares changed" notice.
    assert.deepEqual([liveB.notices, ownerLive.notices, liveA.closes, liveB.closes], [[], ['{"folderShares":true}'], [], []]);
    // Downgraded to Viewer: A's socket closes at once; B and the owner are untouched.
    assert.equal((await s.call(`${shares}/${a.user.id}`, "PATCH", { role: "viewer" }, as)).status, 200);
    await until(() => liveA.closes.includes(1008));
    const text = (doc: Y.Doc) => [...doc.getMap<Y.Map<unknown>>("documents").values()][0].get("content") as Y.Text;
    const again = s.connect(s.id, { folder: s.shared, cookie: a.cookie });
    await until(() => again.provider.synced);
    text(again.doc).insert(0, "not allowed ");
    await until(() => again.closes.includes(1008));
    // A team grant on the same folder: revoking the direct share keeps A connected.
    assert.equal((await s.call(`/rooms/${s.id}/folders/${s.shared}/team-shares`, "POST", { teamId: team, role: "viewer" }, as)).status, 201);
    const kept = s.connect(s.id, { folder: s.shared, cookie: a.cookie });
    await until(() => kept.provider.synced);
    assert.equal((await s.call(`${shares}/${a.user.id}`, "DELETE", undefined, as)).status, 200);
    await pause(300);
    assert.deepEqual(kept.closes, [], "still a Viewer through the team");
    assert.equal((await s.call(`/rooms/${s.id}/documents/${s.docs.shared}/content`, "GET", undefined, a.headers)).status, 200);
    // Removed from the team: nothing left on this folder, so the socket closes and the
    // folder disappears; the other folder share stays.
    assert.equal((await s.call(`/teams/${team}/members/${a.user.id}`, "DELETE", undefined, as)).status, 200);
    await until(() => kept.closes.includes(1008));
    assert.equal(await s.upgrade(s.id, s.shared, a.cookie), 404);
    assert.equal(await s.upgrade(s.id, s.unrelated, a.cookie), 101);
    assert.deepEqual([liveB.closes, ownerLive.closes], [[], []]);
  } finally {
    await s.close();
  }
});

test("folder-share notices reach only the workspace's sharing managers, in every open tab", async () => {
  const s = await setup();
  try {
    const c = await cast(s);
    const as = s.owner.headers;
    const SHARES = '{"folderShares":true}';
    // Managers: the owner in two tabs (root and a folder lesson) and a direct Editor.
    const managers = {
      owner: s.connect(s.id, { cookie: s.owner.cookie }),
      ownerOtherTab: s.connect(s.id, { folder: s.sibling, cookie: s.owner.cookie }),
      directEditor: s.connect(s.id, { cookie: c.directEditor.cookie }),
    };
    // Everyone else who can be connected to this workspace.
    const others = {
      teamEditor: s.connect(s.id, { cookie: c.teamEditor.cookie }),
      viewer: s.connect(s.id, { cookie: c.viewer.cookie }),
      linkGuest: s.connect(s.id, { token: s.editLink }),
      folderEditor: s.connect(s.id, { folder: s.shared, cookie: c.folderEditor.cookie }),
      folderViewer: s.connect(s.id, { folder: s.shared, cookie: c.folderViewer.cookie }),
    };
    const all = [...Object.values(managers), ...Object.values(others)];
    await until(() => all.every((l) => l.provider.synced));
    const heard = (l: (typeof all)[number]) => l.notices.filter((n) => n === SHARES).length;
    const expectRound = async (round: number, what: string) => {
      for (const [who, l] of Object.entries(managers)) await until(() => heard(l) >= round).catch(() => assert.fail(`${who} was not told about ${what}`));
      await pause(200);
      for (const [who, l] of Object.entries(others)) assert.equal(heard(l), 0, `${who} never hears about folder sharing (${what})`);
    };
    // Account shares: add, change, remove; team shares: add, change, remove.
    const person = await signUp(s.base, origin, "Person");
    const base = `/rooms/${s.id}/folders/${s.nested}`;
    const steps: [string, string, string, unknown?][] = [
      ["share", "POST", `${base}/shares`, { email: person.email, role: "viewer" }],
      ["role change", "PATCH", `${base}/shares/${person.user.id}`, { role: "editor" }],
      ["removal", "DELETE", `${base}/shares/${person.user.id}`],
    ];
    const team = await newTeam(s, "Temporary");
    steps.push(
      ["team share", "POST", `${base}/team-shares`, { teamId: team, role: "viewer" }],
      ["team role change", "PATCH", `${base}/team-shares/${team}`, { role: "editor" }],
      ["team removal", "DELETE", `${base}/team-shares/${team}`],
    );
    let round = 0;
    for (const [what, method, path, body] of steps) {
      assert.ok([200, 201].includes((await s.call(path, method, body, as)).status), what);
      await expectRound(++round, what);
    }
    // A direct Editor's change reaches the owner as well.
    assert.equal((await s.call(`${base}/shares`, "POST", { email: person.email, role: "viewer" }, c.directEditor.headers)).status, 201);
    await expectRound(++round, "a direct Editor's share");
    // A deleted team takes its folder shares with it: managers re-read too.
    const gone = await newTeam(s, "Disbanded");
    assert.equal((await s.call(`${base}/team-shares`, "POST", { teamId: gone, role: "viewer" }, as)).status, 201);
    await expectRound(++round, "a team share");
    assert.equal((await s.call(`/teams/${gone}`, "DELETE", undefined, as)).status, 200);
    await expectRound(++round, "a deleted team");
    assert.equal((await s.call(`/rooms/${s.id}/folder-shares`, "GET", undefined, as)).json.folders.some((f: any) => f.id === s.nested), true, "the account share remains");
    // A direct Editor downgraded to Viewer stops being a manager: their socket closes, and
    // after reconnecting they hear nothing about folder sharing.
    assert.equal((await s.call(`/rooms/${s.id}/shares/${c.directEditor.user.id}`, "PATCH", { role: "viewer" }, as)).status, 200);
    await until(() => managers.directEditor.closes.includes(1008));
    const downgraded = s.connect(s.id, { cookie: c.directEditor.cookie });
    await until(() => downgraded.provider.synced);
    assert.equal((await s.call(`${base}/shares/${person.user.id}`, "DELETE", undefined, as)).status, 200);
    await until(() => heard(managers.owner) >= round + 1 && heard(managers.ownerOtherTab) >= round + 1);
    await pause(200);
    assert.equal(heard(downgraded), 0, "a former manager hears nothing");
    for (const [who, l] of Object.entries(others)) assert.equal(heard(l), 0, `${who} never hears about folder sharing`);
    // The notice carries no data at all.
    for (const l of all) for (const n of l.notices) assert.ok(['{"tree":true}', SHARES].includes(n), n);
  } finally {
    await s.close();
  }
});

test("tree notices reach a folder-only recipient only for changes inside their folders", async () => {
  const s = await setup();
  try {
    const a = await signUp(s.base, origin, "Recipient A"),
      sib = await signUp(s.base, origin, "Sibling recipient"),
      bystander = await signUp(s.base, origin, "Bystander");
    const as = s.owner.headers,
      ws = `/rooms/${s.id}`;
    assert.equal((await s.call(`${ws}/folders/${s.shared}/shares`, "POST", { email: a.email, role: "viewer" }, as)).status, 201);
    assert.equal((await s.call(`${ws}/folders/${s.sibling}/shares`, "POST", { email: sib.email, role: "viewer" }, as)).status, 201);
    const liveA = s.connect(s.id, { folder: s.shared, cookie: a.cookie }),
      liveSib = s.connect(s.id, { folder: s.sibling, cookie: sib.cookie }),
      ownerLive = s.connect(s.id, { cookie: s.owner.cookie });
    await until(() => liveA.provider.synced && liveSib.provider.synced && ownerLive.provider.synced);
    // Activity everywhere except inside A's folders.
    const file = (await s.call(`${ws}/documents?folder=${s.sibling}`, "POST", { filename: "x.md", language: "markdown" }, as)).json.id;
    await s.call(`${ws}/documents/${file}?folder=${s.sibling}`, "PATCH", { filename: "y.md" }, as);
    await s.call(`${ws}/documents/order?folder=${s.sibling}`, "PATCH", { ids: [s.docs.sibling, file] }, as);
    await s.call(`${ws}/documents/${file}?folder=${s.sibling}`, "DELETE", undefined, as);
    const sub = (await s.call(`${ws}/folders`, "POST", { name: "new under parent", parent_id: s.parent }, as)).json.id;
    await s.call(`${ws}/folders/${s.sibling}`, "PATCH", { name: "sibling renamed SIBLING-SECRET" }, as);
    await s.call(`${ws}/folders/order`, "PATCH", { parent_id: s.parent, ids: [sub, s.sibling, s.shared] }, as);
    await s.call(`${ws}/folders/${sub}`, "DELETE", undefined, as);
    await s.call(`${ws}/documents`, "POST", { filename: "root2.md", language: "markdown" }, as);
    await s.call(`${ws}/documents?folder=${s.unrelated}`, "POST", { filename: "u2.md", language: "markdown" }, as);
    await s.call(ws, "PATCH", { name: "Renamed WS-SECRET" }, as);
    await s.call(`${ws}/shares`, "POST", { email: bystander.email, role: "viewer" }, as);
    await s.call(`${ws}/folders/${s.unrelated}/shares`, "POST", { email: bystander.email, role: "editor" }, as);
    await s.call(`${ws}/folders/${s.sibling}/shares/${sib.user.id}`, "PATCH", { role: "editor" }, as);
    await until(() => ownerLive.notices.length >= 10 && liveSib.closes.includes(1008));
    await pause(300);
    assert.deepEqual(liveA.notices, [], "no notices about activity outside A's folder");
    assert.equal(liveA.frames.filter((f) => f[0] === 4 || f[0] === 5).length, 0, "no presence, activity or notices");
    assert.ok(liveSib.notices.includes('{"tree":true}'), "the sibling's recipient heard about the sibling's changes");
    assert.deepEqual(liveA.closes, []);
    // Inside A's folders: create, rename, delete in the subfolder; rename of the shared folder.
    let heard = 0;
    const expectNotice = async () => {
      await until(() => liveA.notices.length > heard);
      heard = liveA.notices.length;
    };
    const inner = (await s.call(`${ws}/folders`, "POST", { name: "inner", parent_id: s.nested }, as)).json.id;
    await expectNotice();
    await s.call(`${ws}/documents?folder=${s.nested}`, "POST", { filename: "n2.md", language: "markdown" }, as);
    await expectNotice();
    await s.call(`${ws}/folders/${s.shared}`, "PATCH", { name: "renamed share" }, as);
    await expectNotice();
    await s.call(`${ws}/folders/${inner}`, "DELETE", undefined, as);
    await expectNotice();
    // A new subfolder widens A's scope and is announced once; a later sharing change for
    // someone else (which re-checks every socket) must not announce it a second time.
    await s.call(`${ws}/folders`, "POST", { name: "kept", parent_id: s.nested }, as);
    await expectNotice();
    await s.call(`${ws}/folders/${s.unrelated}/shares/${bystander.user.id}`, "PATCH", { role: "viewer" }, as);
    await s.call(`${ws}/shares/${bystander.user.id}`, "DELETE", undefined, as);
    await pause(300);
    assert.equal(liveA.notices.length, heard, "no notice caused by someone else's sharing change");
    noSecrets(Buffer.concat(liveA.frames).toString("latin1"), "A's frames");
  } finally {
    await s.close();
  }
});

test("image provenance: pasting an image ID grants a folder-only recipient nothing; uploads and links placed by people who can see the image do", async () => {
  const s = await setup();
  try {
    const writer = await signUp(s.base, origin, "Folder Editor"),
      reader = await signUp(s.base, origin, "Folder Viewer"),
      member = await signUp(s.base, origin, "Workspace Viewer");
    const as = s.owner.headers,
      ws = `/rooms/${s.id}`;
    assert.equal((await s.call(`${ws}/folders/${s.shared}/shares`, "POST", { email: writer.email, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(`${ws}/folders/${s.shared}/shares`, "POST", { email: reader.email, role: "viewer" }, as)).status, 201);
    const link = (image: string) => `![x](/api/rooms/${s.id}/images/${image})`;
    const rootImage = await s.image(null),
      replayImage = await s.image(null),
      memberImage = await s.image(s.parent);
    const hidden = async (image: string, who: Person, label: string) => {
      const r = await s.call(`${ws}/images/${image}`, "GET", undefined, who.headers);
      const absent = await s.call(`/rooms/${MISSING}/images/${image}`, "GET", undefined, who.headers);
      assert.deepEqual([r.status, r.text], [absent.status, absent.text], label);
    };
    const visible = async (image: string, who: Person, label: string) =>
      assert.equal((await s.call(`${ws}/images/${image}`, "GET", undefined, who.headers)).status, 200, label);
    const vouched = (image: string, folder: string) =>
      s.app.rooms.db.prepare("SELECT vouched FROM image_refs WHERE image_id=? AND folder_id=?").get(image, folder)?.vouched;
    // 1. REST: the folder Editor pastes the sibling's private image into a shared document.
    const current = (await s.call(`${ws}/documents/${s.docs.shared}/content`, "GET", undefined, writer.headers)).json.content;
    assert.equal((await s.call(`${ws}/documents/${s.docs.shared}/content`, "PUT", { content: current + link(s.siblingImage), baseVersion: "*" }, writer.headers)).status, 200);
    assert.equal(vouched(s.siblingImage, s.shared), 0, "recorded, but unvouched");
    await hidden(s.siblingImage, writer, "the paster can't load it");
    await hidden(s.siblingImage, reader, "nor can the folder's other recipients");
    // ...also in a new file.
    assert.equal((await s.call(`${ws}/documents?folder=${s.nested}`, "POST", { filename: "steal.md", language: "markdown", content: link(rootImage) }, writer.headers)).status, 201);
    await hidden(rootImage, writer, "new file with a pasted root image");
    // 2. Live: the same through the editor socket.
    const live = s.connect(s.id, { folder: s.shared, cookie: writer.cookie });
    await until(() => live.provider.synced);
    const text = [...live.doc.getMap<Y.Map<unknown>>("documents").values()].find((d) => d.get("filename") === "s-shared.md")!.get("content") as Y.Text;
    text.insert(text.length, "\n" + link(memberImage));
    await until(() => ((s.app.rooms.active.get(`${s.id}:${s.shared}`)?.doc.getMap<Y.Map<unknown>>("documents").get(s.docs.shared)?.get("content") as Y.Text | undefined)?.toString() ?? "").includes(memberImage));
    assert.equal((await s.call(`${ws}/checkpoint?folder=${s.shared}`, "POST", {}, as)).status, 200);
    assert.equal(vouched(memberImage, s.shared), 0);
    await hidden(memberImage, writer, "pasted live");
    // 3. The owner editing that document (around the pasted link) vouches for nothing.
    const withPaste = (await s.call(`${ws}/documents/${s.docs.shared}/content`, "GET", undefined, as)).json.content;
    assert.equal((await s.call(`${ws}/documents/${s.docs.shared}/content`, "PUT", { content: "Owner was here\n" + withPaste, baseVersion: "*" }, as)).status, 200);
    await hidden(s.siblingImage, reader, "still hidden after the owner edits the same file");
    // 4. A workspace Viewer with folder Editor rights can see every image, so a link they add
    // is vouched for; so is one added by the owner.
    assert.equal((await s.call(`${ws}/shares`, "POST", { email: member.email, role: "viewer" }, as)).status, 201);
    assert.equal((await s.call(`${ws}/folders/${s.shared}/shares`, "POST", { email: member.email, role: "editor" }, as)).status, 201);
    assert.equal((await s.call(`${ws}/documents?folder=${s.shared}`, "POST", { filename: "member.md", language: "markdown", content: link(memberImage) }, member.headers)).status, 201);
    await visible(memberImage, reader, "placed by someone who could see it");
    assert.equal((await s.call(`${ws}/documents?folder=${s.shared}`, "POST", { filename: "owner.md", language: "markdown", content: link(s.siblingImage) }, as)).status, 201);
    await visible(s.siblingImage, reader, "placed by the owner");
    // 5. A folder-only Editor of two folders may carry an image from one to the other.
    assert.equal((await s.call(`${ws}/folders/${s.unrelated}/shares`, "POST", { email: writer.email, role: "viewer" }, as)).status, 201);
    const unrelatedImage = await s.image(s.unrelated);
    await s.doc(s.unrelated, "pic.md", link(unrelatedImage));
    await visible(unrelatedImage, writer, "visible to the writer in the unrelated folder");
    await hidden(unrelatedImage, reader, "not to the shared folder's reader");
    assert.equal((await s.call(`${ws}/documents?folder=${s.shared}`, "POST", { filename: "carried.md", language: "markdown", content: link(unrelatedImage) }, writer.headers)).status, 201);
    await visible(unrelatedImage, reader, "carried by someone who could see it");
    // 6. Uploads into the share are visible to its recipients at once.
    const uploaded = (await s.call(`${ws}/images?folder=${s.shared}`, "POST", PNG, writer.headers)).json.id;
    await visible(uploaded, reader, "uploaded into the share");
    // 7. Fail-safe: an edit replayed on reconnect (SyncStep2) vouches for nothing, even from
    // the owner, because its author can't be known.
    const ownerLive = s.connect(s.id, { folder: s.nested, cookie: s.owner.cookie });
    await until(() => ownerLive.provider.synced);
    ownerLive.provider.disconnect();
    const nestedText = [...ownerLive.doc.getMap<Y.Map<unknown>>("documents").values()].find((d) => d.get("filename") === "n-nested.md")!.get("content") as Y.Text;
    nestedText.insert(0, link(replayImage) + "\n");
    ownerLive.provider.connect();
    await until(() => ((s.app.rooms.active.get(`${s.id}:${s.nested}`)?.doc.getMap<Y.Map<unknown>>("documents").get(s.docs.nested)?.get("content") as Y.Text | undefined)?.toString() ?? "").includes(replayImage));
    assert.equal((await s.call(`${ws}/checkpoint?folder=${s.nested}`, "POST", {}, as)).status, 200);
    assert.equal(vouched(replayImage, s.nested), 0);
    await hidden(replayImage, reader, "replayed link");
    // The workspace's own members still see every image.
    for (const image of [s.siblingImage, rootImage, replayImage, memberImage]) await visible(image, member, "workspace Viewer");
  } finally {
    await s.close();
  }
});

test("folder-roles tells each caller only their own folder grants; outsiders get the missing-workspace 404", async () => {
  const s = await setup();
  try {
    const c = await cast(s);
    const ws = `/rooms/${s.id}`;
    // The workspace Viewer also gets Editor rights on the subfolder only.
    assert.equal((await s.call(`${ws}/folders/${s.nested}/shares`, "POST", { email: c.viewer.email, role: "editor" }, s.owner.headers)).status, 201);
    const roles = async (headers: Record<string, string>) => (await s.call(`${ws}/folder-roles`, "GET", undefined, headers)).json.roles;
    assert.deepEqual(await roles(c.folderEditor.headers), { [s.shared]: "editor", [s.nested]: "editor" });
    assert.deepEqual(await roles(c.folderViewer.headers), { [s.shared]: "viewer", [s.nested]: "viewer" });
    assert.deepEqual(await roles(c.viewer.headers), { [s.nested]: "editor" });
    for (const headers of [s.owner.headers, c.directEditor.headers, c.teamEditor.headers, c.link]) assert.deepEqual(await roles(headers), {});
    for (const [who, headers] of [["outsider", c.outsider.headers], ["anonymous", {}]] as const) {
      const hidden = await s.call(`${ws}/folder-roles`, "GET", undefined, headers);
      const absent = await s.call(`/rooms/${MISSING}/folder-roles`, "GET", undefined, headers);
      assert.deepEqual([hidden.status, hidden.text], [absent.status, absent.text], who);
      assert.equal(hidden.status, 404);
    }
    // Read-only: anything but GET is a workspace-level route, so a folder-only Editor gets 404.
    assert.equal((await s.call(`${ws}/folder-roles`, "POST", {}, c.folderEditor.headers)).status, 404);
  } finally {
    await s.close();
  }
});

test("a workspace Viewer with folder Editor rights can write only inside the shared subtree", async () => {
  const s = await setup();
  try {
    const v = await signUp(s.base, origin, "Viewer and folder Editor");
    const as = s.owner.headers,
      ws = `/rooms/${s.id}`;
    assert.equal((await s.call(`${ws}/shares`, "POST", { email: v.email, role: "viewer" }, as)).status, 201);
    assert.equal((await s.call(`${ws}/folders/${s.shared}/shares`, "POST", { email: v.email, role: "editor" }, as)).status, 201);
    const blockIn = (lesson: string | null) => `${ws}/blocks${lesson ? "?folder=" + lesson : ""}`;
    const sibBlock = (await s.call(blockIn(s.sibling), "POST", { content: "echo sibling", language: "python" }, as)).json.id;
    const rootBlock = (await s.call(blockIn(null), "POST", { content: "echo root", language: "python" }, as)).json.id;
    const snapshot = async () =>
      JSON.stringify([
        (await s.call(`${ws}/tree`, "GET", undefined, as)).json,
        (await s.call(`${ws}`, "GET", undefined, as)).json,
        (await s.call(`${ws}/shares`, "GET", undefined, as)).json,
        (await s.call(`${ws}/folder-shares`, "GET", undefined, as)).json,
        (await s.call(`${ws}/editor-link`, "GET", undefined, as)).json,
        ...(await Promise.all(
          [s.docs.root, s.docs.parent, s.docs.sibling].map(async (d) => (await s.call(`${ws}/documents/${d}/content`, "GET", undefined, as)).json.content),
        )),
        (await s.call(blockIn(null), "GET", undefined, as)).json,
        (await s.call(blockIn(s.sibling), "GET", undefined, as)).json,
      ]);
    assert.ok(sibBlock && rootBlock, "block fixtures exist");
    const before = await snapshot();
    const outside: [string, string, unknown?][] = [];
    for (const [lesson, file, block] of [
      [null, s.docs.root, rootBlock],
      [s.parent, s.docs.parent, undefined],
      [s.sibling, s.docs.sibling, sibBlock],
    ] as const) {
      const q = lesson ? `?folder=${lesson}` : "";
      outside.push(
        ["POST", `/documents${q}`, { filename: "x.md", language: "markdown" }],
        ["PUT", `/documents/${file}/content${q}`, { content: "x", baseVersion: "*" }],
        ["PUT", `/documents/${file}/content`, { content: "x", baseVersion: "*" }],
        ["PATCH", `/documents/${file}${q}`, { filename: "x.md" }],
        ["DELETE", `/documents/${file}${q}`],
        ["PATCH", `/documents/order${q}`, { ids: [file] }],
        ["POST", `/blocks${q}`, { content: "x", language: "python" }],
        ["PATCH", `/blocks/order${q}`, { ids: block ? [block] : [] }],
        ["POST", `/checkpoint${q}`, {}],
        ["POST", `/migrate-snippets${q}`, {}],
        ["POST", `/images${q}`, PNG],
        ["POST", `/images/import${q}`, { url: "http://127.0.0.1:9/x.png" }],
        ["POST", "/folders", { name: "x", parent_id: lesson }],
        ["PATCH", "/folders/order", { parent_id: lesson, ids: [] }],
      );
      if (block) outside.push(["PATCH", `/blocks/${block}${q}`, { content: "x", language: "python" }], ["DELETE", `/blocks/${block}${q}`]);
    }
    outside.push(
      ["PATCH", `/folders/${s.parent}`, { name: "x" }], ["DELETE", `/folders/${s.parent}`],
      ["PATCH", `/folders/${s.sibling}`, { name: "x" }], ["DELETE", `/folders/${s.sibling}`],
      ["PATCH", `/folders/${s.shared}`, { name: "x" }], ["DELETE", `/folders/${s.shared}`],
      ["PATCH", "", { name: "x" }], ["DELETE", ""], ["PUT", "/visibility", { visibility: "private" }],
      ["POST", "/editor-link", {}], ["DELETE", "/editor-link"], ["POST", "/claim", {}],
      ["POST", "/shares", { email: s.owner.email, role: "editor" }], ["DELETE", `/shares/${v.user.id}`],
      ["POST", "/team-shares", { teamId: "00000000-0000-0000-0000-000000000000", role: "editor" }],
      ["POST", `/folders/${s.shared}/shares`, { email: s.owner.email, role: "editor" }],
      ["DELETE", `/folders/${s.shared}/shares/${v.user.id}`],
    );
    for (const [method, path, body] of outside) {
      const r = await s.call(`${ws}${path}`, method, body, v.headers);
      assert.equal(r.status, 403, `${method} ${path || "/"}: ${r.text}`);
    }
    // A file of another lesson addressed through the shared lesson isn't found there.
    for (const method of ["PATCH", "DELETE"] as const)
      assert.equal((await s.call(`${ws}/documents/${s.docs.root}?folder=${s.shared}`, method, { filename: "x.md" }, v.headers)).status, 404);
    assert.equal((await s.call(`${ws}/documents/${s.docs.root}/content?folder=${s.shared}`, "PUT", { content: "x", baseVersion: "*" }, v.headers)).status, 404);
    assert.equal(await snapshot(), before, "nothing outside the subtree changed");
    // Inside the subtree, every write works.
    const inside = `?folder=${s.shared}`;
    const created = (await s.call(`${ws}/documents${inside}`, "POST", { filename: "v.md", language: "markdown" }, v.headers)).json.id;
    for (const [method, path, body, status] of [
      ["PUT", `/documents/${created}/content`, { content: "v", baseVersion: "*" }, 200],
      ["PATCH", `/documents/${created}${inside}`, { filename: "v2.md" }, 200],
      ["PATCH", `/documents/order${inside}`, { ids: [created, s.docs.shared] }, 200],
      ["POST", `/blocks${inside}`, { content: "echo v", language: "python" }, 201],
      ["POST", `/checkpoint${inside}`, {}, 200],
      ["POST", `/images${inside}`, PNG, 201],
      ["POST", "/folders", { name: "v-sub", parent_id: s.shared }, 201],
      ["PATCH", `/folders/${s.nested}`, { name: "nested-v" }, 200],
      ["PUT", `/documents/${s.docs.nested}/content`, { content: "v nested", baseVersion: "*" }, 200],
      ["DELETE", `/documents/${created}${inside}`, undefined, 200],
    ] as const)
      assert.equal((await s.call(`${ws}${path}`, method, body, v.headers)).status, status, `${method} ${path}`);
    // Live: the root lesson is view-only for them, the shared lesson editable.
    const text = (doc: Y.Doc) => [...doc.getMap<Y.Map<unknown>>("documents").values()][0].get("content") as Y.Text;
    const root = s.connect(s.id, { cookie: v.cookie }),
      share = s.connect(s.id, { folder: s.shared, cookie: v.cookie }),
      ownerShare = s.connect(s.id, { folder: s.shared, cookie: s.owner.cookie });
    await until(() => root.provider.synced && share.provider.synced && ownerShare.provider.synced);
    text(root.doc).insert(0, "nope ");
    await until(() => root.closes.includes(1008));
    text(share.doc).insert(0, "yes ");
    await until(() => text(ownerShare.doc).toString().startsWith("yes "));
    assert.equal((await s.call(`${ws}/documents/${s.docs.root}/content`, "GET", undefined, as)).json.content, "root text ROOT-SECRET");
  } finally {
    await s.close();
  }
});
