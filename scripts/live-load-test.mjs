// Classroom load test for Live Coding sessions: one instructor typing into each session while
// viewers watch through the session link, measuring how long each change takes to reach every
// viewer, whether every change arrives, server CPU and memory (/api/metrics) and reconnects.
//
//   node scripts/live-load-test.mjs --url=http://localhost:3000 --viewers=50 --sessions=1 \
//     --duration-s=60 --edits-per-s=5 --metrics-token=... [--report=out.json]
//
// It signs up a throwaway account (local runs). Never point it at production without approval.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const i = arg.indexOf("=");
    return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? "true" : arg.slice(i + 1)];
  }),
);
const origin = new URL(args.url ?? "http://localhost:3000").origin;
const viewers = Number(args.viewers ?? 50),
  sessions = Number(args.sessions ?? 1),
  durationS = Number(args["duration-s"] ?? 60),
  editsPerS = Number(args["edits-per-s"] ?? 5),
  reconnectShare = Number(args["reconnect-share"] ?? 0.2),
  metricsToken = args["metrics-token"] ?? process.env.METRICS_TOKEN;
assert.ok(Number.isInteger(viewers) && viewers >= 1 && viewers <= 2000);
assert.ok(Number.isInteger(sessions) && sessions >= 1 && sessions <= 50);
assert.ok(durationS >= 5 && durationS <= 3600 && editsPerS > 0 && editsPerS <= 20);
process.setMaxListeners(viewers * sessions + 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 30000, label = "condition") {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error("Timed out: " + label);
    await sleep(10);
  }
}
// ---- An account, sessions and links. Locally a throwaway account signs up; elsewhere pass an
// existing session (--session-cookie=name=value or LOAD_SESSION_COOKIE), so nothing sends email.
let cookie = args["session-cookie"] ?? process.env.LOAD_SESSION_COOKIE,
  csrfToken;
if (cookie) {
  const me = await fetch(origin + "/api/auth/me", { headers: { origin, cookie } });
  ({ csrfToken } = await me.json());
  assert.ok(me.ok && csrfToken, "the session cookie is not signed in");
} else {
  const email = `live-load-${Date.now()}@example.test`;
  const signup = await fetch(origin + "/api/auth/signup", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Load Instructor", email, password: "Correct-Horse-Battery-42", confirmPassword: "Correct-Horse-Battery-42" }),
  });
  assert.equal(signup.status, 201, await signup.clone().text());
  cookie = signup.headers.get("set-cookie").split(";")[0];
  ({ csrfToken } = await signup.json());
}
const call = async (path, method = "GET", body) => {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: { origin, cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
};
const metrics = async () => {
  if (!metricsToken) return undefined;
  const r = await fetch(origin + "/api/metrics", { headers: { authorization: "Bearer " + metricsToken } });
  return r.ok ? r.json() : undefined;
};
const wsBase = origin.replace(/^http/, "ws") + "/ws/live";
const clients = [];
function client(id, { token, instructor = false } = {}) {
  class Socket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { origin, headers: instructor ? { cookie } : {} });
    }
  }
  const provider = new WebsocketProvider(wsBase, id, new Y.Doc(), {
    WebSocketPolyfill: Socket,
    disableBc: true,
    protocols: token ? ["devshare", "live." + token] : ["devshare"],
  });
  provider.awareness.setLocalState(instructor ? { user: { name: "Load Instructor", color: "#a78bfa" } } : { viewer: true });
  clients.push(provider);
  return provider;
}
const text = (doc) => [...doc.getMap("documents").values()][0]?.get("content");
const rooms = [];
for (let s = 0; s < sessions; s++) {
  const { id, token } = await call("/live", "POST", { name: `Load session ${s + 1}` });
  await call(`/live/${id}/status`, "POST", { status: "live" });
  await call(`/live/${id}/files`, "POST", { filename: "playbook.yaml", language: "yaml" });
  const instructor = client(id, { instructor: true });
  await until(() => instructor.synced && text(instructor.doc), 30000, "instructor sync");
  rooms.push({ id, token, instructor, viewers: [], seen: new Map() });
}
// ---- Viewers join (as a class does: within a few seconds).
const joinStart = performance.now();
const latencies = [];
let delivered = 0,
  expected = 0;
const watch = (room, provider) => {
  const seen = new Set();
  provider.doc.on("update", () => {
    const now = performance.now();
    const content = text(provider.doc)?.toString() ?? "";
    for (const match of content.matchAll(/#(\d+)@(\d+(?:\.\d+)?)/g)) {
      const seq = Number(match[1]);
      if (seen.has(seq)) continue;
      seen.add(seq);
      if (room.sent.has(seq)) {
        latencies.push(now - room.sent.get(seq));
        delivered++;
      }
    }
  });
};
for (const room of rooms) {
  room.sent = new Map();
  for (let v = 0; v < viewers; v++) {
    const provider = client(room.id, { token: room.token });
    watch(room, provider);
    room.viewers.push(provider);
    if (v % 10 === 9) await sleep(50);
  }
}
await until(() => rooms.every((r) => r.viewers.every((p) => p.synced)), 60000, "viewers sync");
const joinMs = performance.now() - joinStart;
// ---- Typing, with samples of server metrics.
const samples = [];
const sample = async () => {
  const m = await metrics();
  if (m) samples.push({ at: Date.now(), heapMB: m.memory.heapUsed / 1048576, rssMB: m.memory.rss / 1048576, cpu: m.cpuMicroseconds.user + m.cpuMicroseconds.system, live: m.liveSessions });
};
await sample();
const sampler = setInterval(() => void sample(), 2000);
let seq = 0;
const typingStart = performance.now();
let reconnected = { count: 0, ms: 0 };
while (performance.now() - typingStart < durationS * 1000) {
  for (const room of rooms) {
    seq++;
    room.sent.set(seq, performance.now());
    const t = text(room.instructor.doc);
    t.insert(t.length, `- task #${seq}@${performance.now().toFixed(1)}\n`);
    expected += room.viewers.length;
  }
  // Halfway through, a fifth of the class drops and reconnects (Wi-Fi blips, laptops waking).
  if (!reconnected.count && performance.now() - typingStart > (durationS * 1000) / 2) {
    const started = performance.now();
    const dropping = rooms.flatMap((r) => r.viewers.slice(0, Math.floor(r.viewers.length * reconnectShare)));
    for (const p of dropping) p.disconnect();
    await sleep(200);
    for (const p of dropping) p.connect();
    await until(() => dropping.every((p) => p.synced), 30000, "reconnect");
    reconnected = { count: dropping.length, ms: performance.now() - started };
  }
  await sleep(1000 / editsPerS);
}
await sleep(3000);
clearInterval(sampler);
await sample();
// Every viewer ends with exactly the instructor's text.
let converged = 0;
for (const room of rooms) {
  const want = text(room.instructor.doc).toString();
  for (const p of room.viewers) if (text(p.doc)?.toString() === want) converged++;
}
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const cpuPercent =
  samples.length > 1
    ? ((samples.at(-1).cpu - samples[0].cpu) / 1000 / (samples.at(-1).at - samples[0].at)) * 100
    : undefined;
const report = {
  url: origin,
  sessions,
  viewersPerSession: viewers,
  totalViewers: viewers * sessions,
  durationS,
  editsPerSecondPerSession: editsPerS,
  joinSeconds: +(joinMs / 1000).toFixed(2),
  deliveries: { expected, delivered, ratio: +(delivered / expected).toFixed(4) },
  latencyMs: { p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), p99: +pct(99).toFixed(1), max: +(sorted.at(-1) ?? NaN).toFixed(1) },
  converged: `${converged}/${viewers * sessions}`,
  reconnect: { viewers: reconnected.count, seconds: +(reconnected.ms / 1000).toFixed(2) },
  server: samples.length
    ? {
        cpuPercentOfOneCore: cpuPercent === undefined ? undefined : +cpuPercent.toFixed(1),
        heapMBMax: +Math.max(...samples.map((s) => s.heapMB)).toFixed(1),
        rssMBMax: +Math.max(...samples.map((s) => s.rssMB)).toFixed(1),
        liveConnectionsMax: Math.max(...samples.map((s) => s.live?.connections ?? 0)),
      }
    : "pass --metrics-token to sample the server",
};
console.log(JSON.stringify(report, null, 2));
if (args.report) await writeFile(args.report, JSON.stringify(report, null, 2));
for (const p of clients) {
  p.destroy();
  p.doc.destroy();
}
for (const room of rooms) await call(`/live/${room.id}`, "DELETE");
process.exit(delivered === expected && converged === viewers * sessions ? 0 : 1);
