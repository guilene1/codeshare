import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { DEFAULT_ORIGIN as origin, signUp } from "./helpers.js";

// Regression: a fake, malformed, foreign or revoked Edit Link used to get 403 "invalid or
// revoked" on an existing Restricted workspace but 404 on a missing one, which told anyone
// holding a workspace ID that a private workspace existed. Unauthorized requests must now be
// indistinguishable from a nonexistent workspace over REST and WebSocket, while valid links,
// direct shares, team shares and anonymous student links behave exactly as before.
test("invalid and revoked Edit Links can't reveal that a Restricted workspace exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kodelumi-existence-"));
  const app = createApp({ dbPath: join(dir, "db.sqlite"), origins: [origin], checkpointMs: 30 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json };
  };
  const upgrade = (id: string, protocols: string[], headers: Record<string, string> = {}) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, protocols, { origin, headers });
      ws.on("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
  const fakeToken = () => randomBytes(32).toString("base64url"); // the real token shape
  try {
    const owner = await signUp(base, origin, "Owner"),
      sharedViewer = await signUp(base, origin, "Shared Viewer"),
      teamViewer = await signUp(base, origin, "Team Viewer"),
      outsider = await signUp(base, origin, "Outsider");
    const make = async (name: string, visibility: "private" | "link") => {
      const r = await call("/rooms", "POST", { name, language: "markdown", visibility }, owner.headers);
      assert.equal(r.status, 201);
      const id = r.json.id as string;
      const doc = await call(`/rooms/${id}/documents`, "POST", { filename: "lesson.md", language: "markdown", content: `${name} SECRET` }, owner.headers);
      assert.equal(doc.status, 201);
      const token = (await call(`/rooms/${id}/editor-link`, "POST", {}, owner.headers)).json.token as string;
      return { id, token, docId: doc.json.id as string };
    };
    const restricted = await make("Hidden course", "private"),
      shared = await make("Shared course", "private"),
      open = await make("Open course", "link");
    // A direct viewer share and a team viewer share on the second Restricted workspace.
    assert.equal((await call(`/rooms/${shared.id}/shares`, "POST", { email: sharedViewer.email, role: "viewer" }, owner.headers)).status, 201);
    const team = (await call("/teams", "POST", { name: "Class team" }, owner.headers)).json;
    assert.equal((await call(`/teams/${team.id}/invitations`, "POST", { email: teamViewer.email }, owner.headers)).status, 201);
    const invitation = (await call("/me/invitations", "GET", undefined, teamViewer.headers)).json.invitations[0];
    assert.equal((await call(`/me/invitations/${invitation.id}/accept`, "POST", {}, teamViewer.headers)).status, 200);
    assert.equal((await call(`/rooms/${shared.id}/team-shares`, "POST", { teamId: team.id, role: "viewer" }, owner.headers)).status, 201);

    // A revoked link (removed by the owner) and a replaced link (an old one superseded).
    const revoked = restricted.token;
    assert.equal((await call(`/rooms/${restricted.id}/editor-link`, "DELETE", undefined, owner.headers)).status, 200);
    const replaced = shared.token;
    const current = (await call(`/rooms/${shared.id}/editor-link`, "POST", {}, owner.headers)).json.token as string;
    assert.notEqual(current, replaced);
    const missing = "AAAAAAAAAAAAAAAA";

    const credentials: [string, Record<string, string>][] = [
      ["no credential", {}],
      ["fake Edit Link", { authorization: "Bearer " + fakeToken() }],
      ["malformed Edit Link", { authorization: "Bearer not-a-token" }],
      ["non-Bearer authorization", { authorization: "Basic dXNlcjpwYXNz" }],
      ["another workspace's Edit Link", { authorization: "Bearer " + open.token }],
      ["revoked Edit Link", { authorization: "Bearer " + revoked }],
      ["replaced Edit Link of another workspace", { authorization: "Bearer " + replaced }],
    ];
    const paths = (docId: string) => ["", "/tree", "/blocks", "/activity", "/summary", "/shares", "/team-shares", "/editor-link", `/documents/${docId}/content`, "/images/00000000-0000-0000-0000-000000000000"];

    // REST: for every unauthorized credential, signed out or signed in without a grant, the
    // Restricted workspace answers byte-for-byte like a workspace that doesn't exist.
    for (const [account, session] of [["anonymous", {}], ["signed-in outsider", outsider.headers]] as const)
      for (const [label, credential] of credentials) {
        const headers = { ...session, ...credential };
        const who = `${account}, ${label}`;
        for (const path of paths(restricted.docId)) {
          const hidden = await call(`/rooms/${restricted.id}${path}`, "GET", undefined, headers);
          const absent = await call(`/rooms/${missing}${path}`, "GET", undefined, headers);
          assert.deepEqual([hidden.status, hidden.text], [absent.status, absent.text], `${who} GET ${path || "/"}: same as missing`);
          assert.equal(hidden.status, 404, `${who} GET ${path || "/"}`);
          assert.ok(!hidden.text.includes("Hidden course") && !hidden.text.includes("SECRET"), `${who} ${path}: nothing leaks`);
        }
        for (const [path, method, body] of [
          ["/documents", "POST", { filename: "x.md", language: "markdown" }],
          [`/documents/${restricted.docId}/content`, "PUT", { content: "overwritten" }],
          ["/visibility", "PUT", { visibility: "link" }],
          ["", "PATCH", { name: "Taken" }],
          ["", "DELETE", undefined],
        ] as const) {
          const hidden = await call(`/rooms/${restricted.id}${path}`, method, body, headers);
          const absent = await call(`/rooms/${missing}${path}`, method, body, headers);
          assert.deepEqual([hidden.status, hidden.text], [404, absent.text], `${who} ${method} ${path || "/"}: same as missing`);
        }
      }

    // WebSocket: the same credentials, as the editor subprotocol, are refused like a missing
    // workspace; so are two credentials at once.
    const wsCredentials: [string, string[]][] = [
      ["no credential", ["devshare"]],
      ["fake Edit Link", ["devshare", "editor." + fakeToken()]],
      ["malformed Edit Link", ["devshare", "editor.not-a-token"]],
      ["another workspace's Edit Link", ["devshare", "editor." + open.token]],
      ["revoked Edit Link", ["devshare", "editor." + revoked]],
      ["two Edit Links", ["devshare", "editor." + fakeToken(), "editor." + fakeToken()]],
    ];
    for (const [account, cookie] of [["anonymous", {}], ["signed-in outsider", { cookie: outsider.cookie }]] as const)
      for (const [label, protocols] of wsCredentials) {
        const hidden = await upgrade(restricted.id, protocols, cookie);
        const absent = await upgrade(missing, protocols, cookie);
        assert.deepEqual([hidden, absent], [404, 404], `${account}, ${label}: WebSocket same as missing`);
      }
    app.rooms.release(app.rooms.get(restricted.id)!);
    await upgrade(restricted.id, ["devshare", "editor." + revoked]);
    assert.equal(app.rooms.active.has(restricted.id), false, "a refused link never loads the private lesson");

    // Unchanged: the current Edit Link edits the Restricted workspace (REST and live) and the
    // replaced one is refused like a missing workspace.
    const bearer = (token: string) => ({ authorization: "Bearer " + token });
    assert.equal((await call(`/rooms/${shared.id}`, "GET", undefined, bearer(current))).json.access, "editor");
    assert.equal((await call(`/rooms/${shared.id}/documents/${shared.docId}/content`, "GET", undefined, bearer(current))).status, 200);
    assert.equal(await upgrade(shared.id, ["devshare", "editor." + current]), 101);
    const old = await call(`/rooms/${shared.id}`, "GET", undefined, bearer(replaced));
    assert.deepEqual([old.status, old.text], [404, (await call(`/rooms/${missing}`, "GET", undefined, bearer(replaced))).text]);
    assert.equal(await upgrade(shared.id, ["devshare", "editor." + replaced]), 404);

    // Unchanged: people who can already open the workspace (direct share, team share) still
    // learn that a stale link is invalid (403, so the app reopens it with their own access),
    // and keep their access without it.
    for (const [who, account] of [["direct share", sharedViewer], ["team share", teamViewer]] as const) {
      assert.equal((await call(`/rooms/${shared.id}`, "GET", undefined, account.headers)).json.access, "viewer", `${who}: viewer`);
      assert.equal((await call(`/rooms/${shared.id}/documents/${shared.docId}/content`, "GET", undefined, account.headers)).status, 200, `${who}: reads`);
      const stale = await call(`/rooms/${shared.id}`, "GET", undefined, { ...account.headers, ...bearer(replaced) });
      assert.deepEqual([stale.status, stale.json.error], [403, "This private editor link is invalid or has been revoked."], `${who}: stale link`);
      assert.equal(await upgrade(shared.id, ["devshare"], { cookie: account.cookie }), 101, `${who}: live`);
      assert.equal(await upgrade(shared.id, ["devshare", "editor." + replaced], { cookie: account.cookie }), 403, `${who}: stale link live`);
      assert.equal((await call(`/rooms/${shared.id}/documents`, "POST", { filename: "v.md", language: "markdown" }, account.headers)).status, 403, `${who}: can't write`);
    }

    // Unchanged: anonymous students open the link-visible workspace; a stale or fake link
    // there still gets 403 (its existence is public to link holders), and its valid link edits.
    const student = await call(`/rooms/${open.id}`);
    assert.deepEqual([student.status, student.json.access, student.json.visibility], [200, "viewer", "link"]);
    assert.equal((await call(`/rooms/${open.id}/documents/${open.docId}/content`)).status, 200);
    assert.equal(await upgrade(open.id, ["devshare"]), 101);
    const fakeOpen = await call(`/rooms/${open.id}`, "GET", undefined, bearer(fakeToken()));
    assert.deepEqual([fakeOpen.status, fakeOpen.json.error], [403, "This private editor link is invalid or has been revoked."]);
    assert.equal(await upgrade(open.id, ["devshare", "editor." + fakeToken()]), 403);
    assert.equal((await call(`/rooms/${open.id}`, "GET", undefined, bearer(open.token))).json.access, "editor");
    assert.equal(await upgrade(open.id, ["devshare", "editor." + open.token]), 101);

    // Nothing was changed by any refused request.
    const text = await call(`/rooms/${restricted.id}/documents/${restricted.docId}/content`, "GET", undefined, owner.headers);
    assert.equal(text.json.content, "Hidden course SECRET");
    assert.equal((await call(`/rooms/${restricted.id}`, "GET", undefined, owner.headers)).json.name, "Hidden course");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
