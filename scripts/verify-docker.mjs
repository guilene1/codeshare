import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
// v2: an account owns the workspace; socket clients edit through a co-editor link.
let editorToken, owner;
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { chromium, expect } from "@playwright/test";
const execute = promisify(execFile),
  origin = "http://localhost:8080";
let verificationBrowser;
const compose = [
  "compose",
  "--env-file",
  ".env.example",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.local.yml",
  "-p",
  "devshare-local",
];
class Socket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin });
  }
}
async function until(check, ms = 15_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("Verification timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const clients = [];
function client(room, name, editing = true, folderId) {
  const p = new WebsocketProvider(
    origin.replace("http:", "ws:") + "/ws",
    room,
    new Y.Doc(),
    {
      WebSocketPolyfill: Socket,
      disableBc: true,
      connect: false,
      params: folderId ? { folder: folderId } : {},
      protocols: editing ? ["devshare", "editor." + editorToken] : ["devshare"],
    },
  );
  p.awareness.setLocalStateField("user", {
    name,
    color: name === "Alex" ? "#a78bfa" : "#38bdf8",
  });
  p.connect();
  clients.push(p);
  return p;
}
const request = (path, method = "GET", body) =>
  fetch(origin + "/api" + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(editorToken ? { Authorization: "Bearer " + editorToken } : owner),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
try {
  const homepage = await fetch(origin);
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers.get("referrer-policy"), "no-referrer");
  const html = await homepage.text(),
    entry = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  const asset = await fetch(origin + entry);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal((await fetch(origin + "/assets/nonexistent.js")).status, 404);
  await until(async () => {
    try {
      return (await request("/health")).ok;
    } catch {
      return false;
    }
  });
  const password = randomBytes(18).toString("base64url") + "-Dv1";
  const signup = await request("/auth/signup", "POST", {
    displayName: "Docker verifier",
    email: `docker-verify-${Date.now()}@example.test`,
    password,
    confirmPassword: password,
  });
  assert.equal(signup.status, 201);
  const sessionCookie = signup.headers.get("set-cookie").split(";")[0];
  owner = {
    cookie: sessionCookie,
    "x-csrf-token": (await signup.json()).csrfToken,
  };
  const result = await request("/rooms", "POST", {
    name: "Docker persistence verification",
    description: "Permanent lessons and activity",
    language: "hcl",
  });
  assert.equal(result.status, 201);
  const room = await result.json();
  const link = await request(`/rooms/${room.id}/editor-link`, "POST", {});
  assert.equal(link.status, 201);
  editorToken = (await link.json()).token;
  const a = client(room.id, "Alex"),
    b = client(room.id, "Sam");
  await until(() => a.synced && b.synced);
  const id = [...a.doc.getMap("documents").keys()][0],
    text = a.doc.getMap("documents").get(id).get("content"),
    other = b.doc.getMap("documents").get(id).get("content");
  text.insert(0, "# Container persistence marker\n");
  other.insert(0, "# Concurrent Docker edit\n");
  await until(
    () =>
      text.toString() === other.toString() &&
      text.toString().includes("Concurrent Docker edit"),
  );
  await until(() => a.awareness.getStates().size === 2);
  const expected = text.toString();
  const student = client(room.id, "Student", false);
  await until(() => student.synced);
  assert.equal(
    student.doc.getMap("documents").get(id).get("content").toString(),
    expected,
  );
  const blocksPath = "/rooms/" + room.id + "/blocks";
  const snippetContent = 'provider "aws" {\n  region = "us-east-1"\n}';
  const createdBlock = await request(blocksPath, "POST", {
    title: "Terraform Provider",
    language: "hcl",
    content: snippetContent,
  });
  assert.equal(createdBlock.status, 201);
  const snippet = await createdBlock.json();
  await until(
    () =>
      student.doc.getMap("codeBlocks").get(snippet.id)?.content ===
      snippetContent,
  );
  const folder = await (
    await request("/rooms/" + room.id + "/folders", "POST", {
      name: "Week 04 - Terraform",
    })
  ).json();
  const lessonPath = "/rooms/" + room.id + "/documents?folder=" + folder.id;
  const lessonFile = await (
    await request(lessonPath, "POST", {
      filename: "lesson.tf",
      language: "hcl",
    })
  ).json();
  const lesson = client(room.id, "Instructor lesson", true, folder.id);
  await until(() => lesson.synced);
  const lessonStudent = client(room.id, "Lesson student", false, folder.id);
  await until(() => lessonStudent.synced);
  lesson.doc
    .getMap("documents")
    .get(lessonFile.id)
    .get("content")
    .insert(0, "# Folder lesson persists across Docker restart");
  await until(
    () =>
      lessonStudent.doc
        .getMap("documents")
        .get(lessonFile.id)
        .get("content")
        .toString() === "# Folder lesson persists across Docker restart",
  );
  assert.equal(
    (
      await request(
        "/rooms/" + room.id + "/checkpoint?folder=" + folder.id,
        "POST",
      )
    ).status,
    200,
  );
  lesson.destroy();
  lesson.doc.destroy();
  lessonStudent.destroy();
  lessonStudent.doc.destroy();
  student.destroy();
  student.doc.destroy();
  assert.equal(
    (await request("/rooms/" + room.id + "/checkpoint", "POST")).status,
    200,
  );
  a.destroy();
  a.doc.destroy();
  b.destroy();
  b.doc.destroy();
  verificationBrowser = await chromium.launch({ headless: true });
  const context = await verificationBrowser.newContext();
  // The browser is the signed-in owner: no credential appears in the URL.
  const [cookieName, cookieValue] = sessionCookie.split("=");
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(
    `${origin}/w/${room.id}?folder=${folder.id}&file=${lessonFile.id}`,
  );
  await expect(page.getByLabel("Workspace access")).toContainText("Editing");
  await expect(page.locator(".view-lines")).toContainText(
    "Folder lesson persists across Docker restart",
  );
  await page
    .getByRole("button", { name: "My Workspaces", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspaces$/);
  const card = page.getByRole("article", {
    name: "Docker persistence verification",
    exact: true,
  });
  await expect(card).toContainText("2 files · 1 folder");
  await execute("docker", [...compose, "restart", "application"]);
  await until(async () => {
    try {
      return (await request("/health")).ok;
    } catch {
      return false;
    }
  });
  await page.reload();
  await expect(card).toContainText("Permanent lessons and activity");
  await expect(card).toContainText("2 files · 1 folder");
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".view-lines")).toContainText(
    "Folder lesson persists across Docker restart",
  );
  await expect(page.getByLabel("Workspace access")).toContainText("Editing");
  assert.deepEqual(browserErrors, []);
  const fresh = client(room.id, "Alex");
  await until(() => fresh.synced);
  assert.equal(
    fresh.doc.getMap("documents").get(id).get("content").toString(),
    expected,
  );
  assert.equal(
    fresh.doc.getMap("codeBlocks").get(snippet.id)?.content,
    snippetContent,
  );
  const persistedBlocks = await (await request(blocksPath)).json();
  assert.equal(persistedBlocks.blocks[0].content, snippetContent);
  // v2: private summaries are owner-only (the co-editor link gets 404).
  assert.equal((await request("/rooms/" + room.id + "/summary")).status, 404);
  const dashboard = await (
    await fetch(origin + "/api/rooms/" + room.id + "/summary", {
      headers: { origin, ...owner },
    })
  ).json();
  assert.equal(dashboard.description, "Permanent lessons and activity");
  assert.equal(dashboard.files, 2);
  assert.equal(dashboard.blocks, 1);
  assert.ok(
    dashboard.activity.some((event) => event.action === "folder.created"),
  );
  assert.ok(
    dashboard.activity.some((event) => event.action === "block.created"),
  );
  const reopenedLesson = client(room.id, "Instructor lesson", true, folder.id);
  await until(() => reopenedLesson.synced);
  assert.equal(
    reopenedLesson.doc
      .getMap("documents")
      .get(lessonFile.id)
      .get("content")
      .toString(),
    "# Folder lesson persists across Docker restart",
  );
  assert.ok(
    (await (await request("/rooms/" + room.id + "/tree")).json()).folders.some(
      (item) => item.id === folder.id,
    ),
  );
  assert.equal(
    (await (await request("/rooms/" + room.id)).json()).access,
    "editor",
  );
  const logs = await execute("docker", [...compose, "logs", "--no-color"]);
  assert.ok(
    !(logs.stdout + logs.stderr).includes(editorToken),
    "Private editor token appeared in service logs",
  );
  console.log(
    "PASS: Caddy HTTP/WebSocket proxy, concurrent Yjs editing, snippets, lesson content, descriptions, activity and browser shortcuts survive Docker restart",
  );
  console.log("Verification room: " + origin + "/w/" + room.id);
} finally {
  await verificationBrowser?.close();
  for (const p of clients) {
    p.destroy();
    p.doc.destroy();
  }
}
