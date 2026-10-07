import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const index = arg.indexOf("=");
    return [
      arg.slice(2, index < 0 ? undefined : index),
      index < 0 ? "true" : arg.slice(index + 1),
    ];
  }),
);
const origin = new URL(args.url ?? "http://localhost:8080").origin;
const viewers = Number(args.viewers ?? 50),
  updates = Number(args.updates ?? 100),
  interval = Number(args["interval-ms"] ?? 100),
  documentKiB = Number(args["document-kib"] ?? 64),
  settleMs = Number(args["settle-ms"] ?? 35000);
assert.ok(
  Number.isSafeInteger(viewers) && viewers >= 1,
  "Use a positive safe integer for --viewers; 50 is the minimum acceptance test target, not a capacity limit",
);
assert.ok(Number.isInteger(updates) && updates >= 1 && updates <= 10000);
assert.ok(Number.isFinite(interval) && interval >= 25 && interval <= 10000);
assert.ok(
  Number.isInteger(documentKiB) && documentKiB >= 1 && documentKiB <= 400,
);
assert.ok(
  settleMs >= 31000,
  "Allow at least 31 seconds to verify idle eviction",
);
const token = randomBytes(32).toString("base64url"),
  hash = createHash("sha256").update(token).digest("hex");
const clients = new Set();
// y-websocket registers one process-exit handler per provider and removes it on destroy.
// Deliberately independent clients legitimately exceed Node's default listener warning threshold.
const exitListenersAtBaseline = process.listenerCount("exit");
process.setMaxListeners(Math.max(process.getMaxListeners(), viewers + 8));
const samples = [],
  latencies = [];
let roomId, folderId, sampleTimer;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 30000) {
  const start = performance.now();
  while (!(await check())) {
    if (performance.now() - start > timeout)
      throw new Error("Timed out waiting for collaboration");
    await sleep(10);
  }
}
async function request(path, method = "GET", body, editor = true) {
  return fetch(origin + "/api" + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(editor ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function metrics() {
  if (!process.env.METRICS_TOKEN) return null;
  const response = await fetch(origin + "/api/metrics", {
    headers: { Authorization: "Bearer " + process.env.METRICS_TOKEN },
  });
  assert.equal(
    response.status,
    200,
    "Configured METRICS_TOKEN must match the server",
  );
  const value = { timeMs: performance.now(), ...(await response.json()) };
  samples.push(value);
  return value;
}
class Socket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin });
  }
}
function client(name, editor = false) {
  const provider = new WebsocketProvider(
    origin.replace(/^http/, "ws") + "/ws",
    roomId,
    new Y.Doc(),
    {
      WebSocketPolyfill: Socket,
      disableBc: true,
      connect: false,
      params: { folder: folderId },
      protocols: editor ? ["devshare", "editor." + token] : ["devshare"],
    },
  );
  provider.awareness.setLocalState({
    ...(editor ? { user: { name, color: "#a78bfa" } } : { viewer: true }),
    role: "editor",
  }); // Intentionally forged viewer role; server must overwrite it.
  provider.connect();
  clients.add(provider);
  return provider;
}
function destroy(provider) {
  provider.destroy();
  provider.doc.destroy();
  clients.delete(provider);
}
let report;
try {
  const baseline = await metrics();
  const created = await request("/rooms", "POST", {
    name: `Temporary ${viewers}-viewer load test`,
    language: "hcl",
    editorTokenHash: hash,
  });
  assert.equal(created.status, 201);
  roomId = (await created.json()).id;
  const folder = await request(`/rooms/${roomId}/folders`, "POST", {
    name: "Active Terraform lesson",
  });
  assert.equal(folder.status, 201);
  folderId = (await folder.json()).id;
  for (let week = 1; week <= 6; week++)
    assert.equal(
      (
        await request(`/rooms/${roomId}/folders`, "POST", {
          name: `Inactive week ${week}`,
        })
      ).status,
      201,
    );
  const file = await request(
    `/rooms/${roomId}/documents?folder=${folderId}`,
    "POST",
    { filename: "main.tf", language: "hcl" },
  );
  assert.equal(file.status, 201);
  const fileId = (await file.json()).id;
  const instructor = client("Instructor", true);
  await until(() => instructor.synced);
  const text = instructor.doc.getMap("documents").get(fileId).get("content");
  text.insert(
    0,
    "# Terraform lesson seed\n".repeat(Math.ceil((documentKiB * 1024) / 24)),
  );
  const students = [];
  const connectStart = performance.now();
  for (let offset = 0; offset < viewers; offset += 10) {
    const batch = Array.from(
      { length: Math.min(10, viewers - offset) },
      (_, index) => client(`Student ${offset + index + 1}`),
    );
    students.push(...batch);
    await until(() => batch.every((provider) => provider.synced));
  }
  const content = (provider) =>
    provider.doc.getMap("documents").get(fileId).get("content").toString();
  await until(() =>
    students.every((provider) => content(provider) === text.toString()),
  );
  await until(() => instructor.awareness.getStates().size === viewers + 1);
  const connectionMs = performance.now() - connectStart;
  const serverRoles = [...instructor.awareness.getStates()]
    .filter(([id]) => id !== instructor.doc.clientID)
    .map(([, state]) => state.role);
  assert.ok(serverRoles.every((role) => role === "viewer"));
  assert.ok(
    [...instructor.awareness.getStates()]
      .filter(([id]) => id !== instructor.doc.clientID)
      .every(
        ([, state]) =>
          state.viewer === true &&
          !("user" in state) &&
          !("selection" in state),
      ),
  );
  const full = await metrics();
  if (full)
    assert.equal(
      full.websocketConnections - baseline.websocketConnections,
      viewers + 1,
    );
  console.log(
    `Connected 1 instructor + ${viewers} viewers; all documents synchronized.`,
  );
  sampleTimer = setInterval(
    () =>
      metrics().catch((error) =>
        console.error("Metrics sample:", error.message),
      ),
    1000,
  );
  for (let update = 0; update < updates; update++) {
    const start = performance.now();
    text.insert(text.length, `\n# Update ${update}`);
    await until(() =>
      students.every((provider) => content(provider) === text.toString()),
    );
    latencies.push(performance.now() - start);
    await sleep(interval);
  }
  assert.equal(
    (
      await request(
        `/rooms/${roomId}/documents?folder=${folderId}`,
        "POST",
        { filename: "attack.tf", language: "hcl" },
        false,
      )
    ).status,
    403,
  );
  const victim = students[0];
  const denied = new Promise((resolve) =>
    victim.on("connection-close", (event) => {
      if (event) {
        victim.shouldConnect = false;
        resolve(event.code);
      }
    }),
  );
  victim.doc
    .getMap("documents")
    .get(fileId)
    .get("content")
    .insert(0, "# FORBIDDEN VIEWER WRITE\n");
  assert.equal(
    await Promise.race([
      denied,
      sleep(10000).then(() => {
        throw new Error("Viewer write was not rejected");
      }),
    ]),
    1008,
  );
  destroy(victim);
  students[0] = client("Student 1");
  await until(
    () => students[0].synced && content(students[0]) === text.toString(),
  );
  const reconnecting = students.slice(0, 10);
  reconnecting.forEach((provider) => provider.disconnect());
  await until(() => reconnecting.every((provider) => !provider.wsconnected));
  text.insert(text.length, "\n# Edit while students disconnected");
  reconnecting.forEach((provider) => provider.connect());
  await until(() =>
    students.every(
      (provider) => provider.synced && content(provider) === text.toString(),
    ),
  );
  assert.ok(!text.toString().includes("FORBIDDEN VIEWER WRITE"));
  assert.equal(
    (await request(`/rooms/${roomId}/checkpoint?folder=${folderId}`, "POST"))
      .status,
    200,
  );
  const expected = text.toString();
  clearInterval(sampleTimer);
  await metrics();
  for (const provider of [...clients]) destroy(provider);
  assert.equal(
    process.listenerCount("exit"),
    exitListenersAtBaseline,
    "Every simulated provider must remove its exit listener",
  );
  let cleaned;
  await until(async () => {
    cleaned = await metrics();
    return (
      !cleaned || cleaned.websocketConnections === baseline.websocketConnections
    );
  });
  console.log(
    `Broadcasts, student write rejection, ${reconnecting.length} reconnects and socket cleanup passed. Waiting for idle eviction...`,
  );
  await sleep(settleMs + 15000); // Collect runs every 15 seconds; allow a full cycle beyond the idle threshold.
  const idle = await metrics();
  if (idle)
    assert.ok(
      !idle.sessions.some((session) => session.workspaceId === roomId),
      "Every load-test lesson session must leave RAM after idle timeout",
    );
  const reopened = client("Instructor reopen", true);
  await until(() => reopened.synced);
  assert.equal(
    content(reopened),
    expected,
    "Idle eviction must preserve course content",
  );
  destroy(reopened);
  const sorted = [...latencies].sort((a, b) => a - b);
  const peakRss = samples.length
    ? Math.max(...samples.map((sample) => sample.memory.rss))
    : null;
  const cpu = samples
    .slice(1)
    .map(
      (sample, index) =>
        ((sample.cpuMicroseconds.user +
          sample.cpuMicroseconds.system -
          samples[index].cpuMicroseconds.user -
          samples[index].cpuMicroseconds.system) /
          ((sample.timeMs - samples[index].timeMs) * 1000)) *
        100,
    )
    .filter((value) => Number.isFinite(value));
  report = {
    testedAt: new Date().toISOString(),
    origin,
    instructor: 1,
    viewers,
    updates,
    intervalMs: interval,
    documentKiB,
    baselineWebsocketConnections: baseline?.websocketConnections ?? null,
    baselineActiveSessions: baseline?.activeSessions ?? null,
    connectMs: Math.round(connectionMs),
    broadcastLatencyMs: {
      p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
      p95: +sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
      ].toFixed(1),
      max: +sorted.at(-1).toFixed(1),
    },
    serverPeakRssMiB:
      peakRss === null ? null : +(peakRss / 1024 / 1024).toFixed(1),
    serverPeakCpuPercentOfOneCore: cpu.length
      ? +Math.max(...cpu).toFixed(1)
      : null,
    websocketConnectionsAtFullLoad: full?.websocketConnections ?? null,
    websocketConnectionsAfterCleanup: cleaned?.websocketConnections ?? null,
    activeSessionsAfterIdle: idle?.activeSessions ?? null,
    clientGeneratorRssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(
      1,
    ),
    passed: true,
  };
  if (args.output)
    await writeFile(args.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (!baseline)
    console.log(
      "Server metrics were not configured. Set METRICS_TOKEN and measure Docker/host RAM and CPU separately.",
    );
} finally {
  clearInterval(sampleTimer);
  for (const provider of [...clients]) destroy(provider);
  if (roomId)
    assert.equal(
      (await request(`/rooms/${roomId}`, "DELETE")).status,
      200,
      "Remove only the test workspace",
    );
}
