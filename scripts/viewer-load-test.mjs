// Realistic read-only classroom load test: N anonymous viewers open the same share link
// in a burst, load the page exactly as a browser does (requests recorded from a real
// Chromium viewer: HTML, assets, API calls, images), hold live Yjs WebSockets for a soak
// period while an instructor edits, and are checked for security, latency and stability.
// Run against a LOCAL production-like stack only (see docs/LOAD_TEST.md), never production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { WebSocket } from "ws";
import { chromium } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const i = arg.indexOf("=");
    return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? "true" : arg.slice(i + 1)];
  }),
);
const origin = new URL(args.url ?? "http://localhost:8080").origin;
assert.ok(!/kodelumi\.com|gamela\.shop/i.test(origin), "Never run this load test against production.");
const VIEWERS = Number(args.viewers ?? 100);
const BROWSERS = Number(args.browsers ?? 4);
const BURST_MS = Number(args["burst-ms"] ?? 3000);
const SOAK_MS = Number(args["soak-min"] ?? 15) * 60_000;
const UPDATE_MS = Number(args["update-interval-s"] ?? 5) * 1000;
const docker = args["docker-project"] ?? "devshare-local";
const now = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
async function until(check, timeout = 30_000, step = 20) {
  const start = now();
  while (!(await check())) {
    if (now() - start > timeout) return false;
    await sleep(step);
  }
  return true;
}
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
};
const stats = (values) => ({
  count: values.length,
  p50: pct(values, 0.5),
  p95: pct(values, 0.95),
  p99: pct(values, 0.99),
  max: values.length ? +Math.max(...values).toFixed(1) : null,
});

// ---------- Realistic fixture content ----------
function png(width, height, noiseShare) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height, 0xff);
  // Detailed regions (icons, text) compress poorly; flat background compresses well.
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0;
    if ((y * 7919) % 100 < noiseShare * 100) randomBytes(width * 3).copy(rows, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function animatedGif(size, frames) {
  const lzw = (index, pixels) => {
    const codes = [];
    for (let i = 0; i < pixels; i++) {
      if (i % 2 === 0) codes.push(4);
      codes.push(index);
    }
    codes.push(5);
    const bytes = [];
    let bits = 0,
      count = 0;
    for (const code of codes) {
      bits |= code << count;
      count += 3;
      while (count >= 8) {
        bytes.push(bits & 0xff);
        bits >>= 8;
        count -= 8;
      }
    }
    if (count) bytes.push(bits & 0xff);
    const blocks = [Buffer.from([2])];
    for (let i = 0; i < bytes.length; i += 255) {
      const part = bytes.slice(i, i + 255);
      blocks.push(Buffer.from([part.length, ...part]));
    }
    blocks.push(Buffer.from([0]));
    return Buffer.concat(blocks);
  };
  const le = (n) => Buffer.from([n & 0xff, n >> 8]);
  const parts = [
    Buffer.from("GIF89a", "latin1"), le(size), le(size), Buffer.from([0x80, 0, 0]),
    Buffer.from([0x32, 0x6c, 0xe5, 0xff, 0xff, 0xff]),
    Buffer.from("21ff0b4e45545343415045322e300301000000", "hex"),
  ];
  for (let f = 0; f < frames; f++)
    parts.push(
      Buffer.from("21f9040414000000", "hex"),
      Buffer.from([0x2c, 0, 0, 0, 0]), le(size), le(size), Buffer.from([0]),
      lzw(f % 2, size * size),
    );
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
const FENCE = "```";
const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: quickbite-api
  labels:
    app: quickbite
    tier: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: quickbite
  template:
    metadata:
      labels:
        app: quickbite
    spec:
      containers:
        - name: api
          image: ghcr.io/guilene1/quickbite:1.4.2
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: quickbite-db
                  key: url
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
`;
function lesson(images) {
  return [
    "# Kubernetes architecture and deployments",
    "",
    "Source code: https://github.com/guilene1/Quickbite",
    "Official docs: [Kubernetes concepts](https://kubernetes.io/docs/concepts/) and https://kubernetes.io/docs/home/",
    "",
    "## Architecture",
    "",
    `![Kubernetes architecture](${images[0]})`,
    "",
    "The control plane schedules pods onto worker nodes.",
    "",
    `![Cluster networking](${images[1]})`,
    "",
    "## Deploy the API",
    "",
    `${FENCE}yaml`,
    deploymentYaml.trimEnd(),
    FENCE,
    "",
    `${FENCE}bash`,
    "kubectl apply -f deployment.yaml",
    "kubectl rollout status deployment/quickbite-api",
    "kubectl get pods -l app=quickbite -o wide",
    FENCE,
    "",
    "Rolling update in action:",
    "",
    `![Rolling update](${images[2]})`,
    "",
    "## Live notes",
    "",
  ].join("\n");
}

// ---------- Server measurements ----------
const samples = [];
async function serverMetrics() {
  const response = await fetch(origin + "/api/metrics", {
    headers: { Authorization: "Bearer " + (process.env.METRICS_TOKEN ?? "local-preview-metrics-only") },
  });
  if (response.status !== 200) return null;
  return { t: now(), ...(await response.json()) };
}
async function dockerStats() {
  try {
    const { stdout } = await promisify(execFile)(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", `${docker}-application-1`, `${docker}-caddy-1`],
      { timeout: 15_000 },
    );
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .map((s) => ({ name: s.Name, cpu: parseFloat(s.CPUPerc), mem: s.MemUsage }));
  } catch {
    return null;
  }
}
const toMiB = (text) => {
  const m = /([\d.]+)\s*([KMG]i?B)/.exec(text ?? "");
  if (!m) return null;
  const factor = { KiB: 1 / 1024, MiB: 1, GiB: 1024, kB: 1 / 1000, MB: 1, GB: 1000 }[m[2]] ?? 1;
  return +(parseFloat(m[1]) * factor).toFixed(1);
};

// ---------- HTTP helpers ----------
let owner;
async function api(path, method = "GET", body, headers = {}) {
  return fetch(origin + "/api" + path, {
    method,
    headers: { origin, ...headers, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
}
const asOwner = () => ({ cookie: owner.cookie, "x-csrf-token": owner.csrf });

class Socket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin });
  }
}

// y-websocket adds one process exit listener per client; these are deliberate.
process.setMaxListeners(VIEWERS + 20);
const report = { testedAt: new Date().toISOString(), origin, viewers: VIEWERS, realBrowsers: BROWSERS };
const providers = new Set();
let browser;
try {
  // ---------- 1. Fixture ----------
  const baseline = await serverMetrics();
  assert.ok(baseline, "Set METRICS_TOKEN to the local stack's metrics token");
  const password = randomBytes(12).toString("base64url") + "-Kq7";
  let response = await api("/auth/signup", "POST", {
    email: `viewer-load-${Date.now()}@example.test`,
    password,
    confirmPassword: password,
    displayName: "Load-test instructor",
  });
  let body = await response.text();
  assert.equal(response.status, 201, body);
  owner = { cookie: response.headers.get("set-cookie").split(";")[0], csrf: JSON.parse(body).csrfToken };
  response = await api("/rooms", "POST", { name: "Kubernetes classroom load test" }, asOwner());
  assert.equal(response.status, 201);
  const roomId = (await response.json()).id;
  report.workspace = roomId;
  const editorToken = (await (await api(`/rooms/${roomId}/editor-link`, "POST", {}, asOwner())).json()).token;
  const imageFiles = [
    ["image/png", png(1536, 1024, 0.3)],
    ["image/png", png(2400, 1600, 0.25)],
    ["image/gif", animatedGif(240, 6)],
  ];
  const imageUrls = [];
  for (const [type, data] of imageFiles) {
    response = await api(`/rooms/${roomId}/images`, "POST", new Uint8Array(data), { ...asOwner(), "content-type": type });
    body = await response.text();
    assert.equal(response.status, 201, body);
    imageUrls.push(`/api/rooms/${roomId}/images/${JSON.parse(body).id}`);
  }
  report.imageBytes = imageFiles.map(([type, data]) => `${type} ${(data.length / 1024 / 1024).toFixed(2)} MiB`);
  const docs = {};
  for (const [filename, language, content] of [
    ["lesson.md", "markdown", lesson(imageUrls)],
    ["deployment.yaml", "yaml", deploymentYaml],
    ["service.yaml", "yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: quickbite\nspec:\n  selector:\n    app: quickbite\n  ports:\n    - port: 80\n      targetPort: 8080\n"],
    ["notes.txt", "plaintext", "Repo: https://github.com/guilene1/Quickbite\nApp: http://localhost:3000\n"],
  ]) {
    response = await api(`/rooms/${roomId}/documents`, "POST", { filename, language, content }, asOwner());
    body = await response.text();
    assert.equal(response.status, 201, body);
    docs[filename] = JSON.parse(body).id;
  }
  const shareUrl = `${origin}/w/${roomId}`;
  log(`Fixture ready: ${shareUrl} (4 documents, 3 images: ${report.imageBytes.join(", ")})`);

  // ---------- 2. Record what a real anonymous viewer requests ----------
  browser = await chromium.launch();
  const recorder = await (await browser.newContext()).newPage();
  const recorded = [];
  const sockets = [];
  recorder.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && request.resourceType() !== "websocket")
      recorded.push({ method: request.method(), path: url.pathname + url.search, type: request.resourceType() });
  });
  recorder.on("websocket", (ws) => sockets.push(ws.url()));
  await recorder.goto(shareUrl);
  await recorder.locator(".sidebar").getByRole("button", { name: "lesson.md", exact: true }).click();
  assert.ok(
    await until(() => recorder.locator(".doc-image img").evaluateAll((list) => list.length === 3 && list.every((img) => img.complete && img.naturalWidth > 0)), 30_000, 100),
    "Recorder: images did not load",
  );
  await sleep(1000);
  await recorder.context().close();
  const replay = recorded.filter((r, i, all) => all.findIndex((o) => o.path === r.path && o.method === r.method) === i);
  assert.ok(replay.every((r) => r.method === "GET"), "An anonymous page load should only read");
  const wsUrl = new URL(sockets.find((url) => url.includes(`/ws/${roomId}`)));
  report.pageLoadRequests = {
    total: replay.length,
    api: replay.filter((r) => r.path.startsWith("/api/") && !r.path.includes("/images/")).length,
    images: replay.filter((r) => r.path.includes("/images/")).length,
    static: replay.filter((r) => !r.path.startsWith("/api/")).length,
    websockets: sockets.length,
  };
  log(`Recorded a real viewer: ${JSON.stringify(report.pageLoadRequests)}; socket ${wsUrl.pathname}${wsUrl.search}`);

  // ---------- Sampling ----------
  const dockerSamples = [];
  let sampling = true;
  const sampler = (async () => {
    let tick = 0;
    while (sampling) {
      const m = await serverMetrics().catch(() => null);
      if (m) samples.push(m);
      if (tick++ % 2 === 0) {
        const d = await dockerStats();
        if (d) dockerSamples.push({ t: now(), stats: d });
      }
      await sleep(5000);
    }
  })();

  // ---------- 3. Burst: VIEWERS protocol viewers + real browsers join together ----------
  const httpStatuses = {};
  const rateLimited = [];
  async function loadPage(viewer) {
    const queue = [...replay];
    const timings = [];
    const worker = async () => {
      for (let item; (item = queue.shift()); ) {
        const start = now();
        try {
          const r = await fetch(origin + item.path, { headers: { accept: item.type === "image" ? "image/*" : "*/*" } });
          const body = await r.arrayBuffer();
          httpStatuses[r.status] = (httpStatuses[r.status] ?? 0) + 1;
          if (r.status === 429) rateLimited.push(item.path);
          timings.push({ path: item.path, status: r.status, ms: now() - start, bytes: body.byteLength });
        } catch (error) {
          httpStatuses.error = (httpStatuses.error ?? 0) + 1;
          timings.push({ path: item.path, status: "error", ms: now() - start, bytes: 0 });
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker)); // browsers use ~6 connections per host
    viewer.http = timings;
  }
  const viewers = [];
  function connect(viewer) {
    const provider = new WebsocketProvider(`${wsUrl.origin}${wsUrl.pathname.replace(/\/[^/]+$/, "")}`, roomId, new Y.Doc(), {
      WebSocketPolyfill: Socket,
      disableBc: true,
      params: Object.fromEntries(wsUrl.searchParams),
      protocols: ["devshare"],
    });
    provider.awareness.setLocalState({ viewer: true, role: "editor" }); // forged; server must overwrite
    provider.on("status", ({ status }) => {
      if (status === "disconnected" && !viewer.closing) viewer.disconnects++;
      if (status === "connected" && viewer.connectedOnce) viewer.reconnects++;
      if (status === "connected") viewer.connectedOnce = true;
    });
    provider.on("connection-close", (event) => {
      if (event && !viewer.closing) viewer.closeCodes.push(event.code);
    });
    providers.add(provider);
    viewer.provider = provider;
  }
  const lessonText = (provider) => provider.doc.getMap("documents").get(docs["lesson.md"])?.get("content");
  log(`Burst: ${VIEWERS} viewers + ${BROWSERS} real browsers join within ${BURST_MS} ms`);
  const burstStart = now();
  const burstCpuBefore = samples.at(-1);
  const realPages = [];
  const browserJoins = Array.from({ length: BROWSERS }, async (_, i) => {
    await sleep(Math.random() * BURST_MS);
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    const apiStatuses = {};
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/"))
        apiStatuses[r.status()] = (apiStatuses[r.status()] ?? 0) + 1;
    });
    const start = now();
    let ok = false,
      failure = null;
    try {
      await page.goto(shareUrl);
      await page.locator(".sidebar").getByRole("button", { name: "lesson.md", exact: true }).click({ timeout: 30_000 });
      ok = await until(
        () => page.locator(".doc-image img").evaluateAll((list) => list.length === 3 && list.every((img) => img.complete && img.naturalWidth > 0)).catch(() => false),
        60_000,
        100,
      );
    } catch (error) {
      failure = {
        error: error.message.split("\n")[0],
        visibleText: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300),
      };
      await page.screenshot({ path: `test-results/load-browser-${i}-failure.png` }).catch(() => {});
    }
    realPages.push({ page, errors, loadMs: now() - start, imagesOk: ok, apiStatuses, failure });
  });
  await Promise.all([
    ...Array.from({ length: VIEWERS }, async (_, i) => {
      const viewer = { id: i, disconnects: 0, reconnects: 0, closeCodes: [], arrivals: new Map() };
      viewers.push(viewer);
      await sleep(Math.random() * BURST_MS);
      viewer.start = now();
      await loadPage(viewer);
      connect(viewer);
      viewer.synced = await until(() => viewer.provider.synced && !!lessonText(viewer.provider), 60_000);
      viewer.pageLoadMs = now() - viewer.start;
      lessonText(viewer.provider)?.observe(() => {
        const text = lessonText(viewer.provider).toString();
        for (const match of text.matchAll(/LIVE-(\d+)\b/g))
          if (!viewer.arrivals.has(+match[1])) viewer.arrivals.set(+match[1], now());
      });
    }),
    ...browserJoins,
  ]);
  const burstMs = now() - burstStart;
  await sleep(3000);
  const afterBurst = await serverMetrics();
  const syncedCount = viewers.filter((v) => v.synced).length;
  const httpOk = viewers.filter((v) => v.http.every((t) => t.status === 200 || t.status === 304)).length;
  report.burst = {
    joinWindowMs: BURST_MS,
    totalMs: Math.round(burstMs),
    viewersSynced: syncedCount,
    viewersAllHttpOk: httpOk,
    connectionSuccessRate: +((Math.min(syncedCount, httpOk) / VIEWERS) * 100).toFixed(1),
    pageLoadMs: stats(viewers.filter((v) => v.pageLoadMs).map((v) => v.pageLoadMs)),
    imageRequestMs: stats(viewers.flatMap((v) => v.http.filter((t) => t.path.includes("/images/")).map((t) => t.ms))),
    apiRequestMs: stats(viewers.flatMap((v) => v.http.filter((t) => t.path.startsWith("/api/") && !t.path.includes("/images/")).map((t) => t.ms))),
    httpStatuses: { ...httpStatuses },
    rateLimited: rateLimited.length,
    rateLimitedExamples: [...new Set(rateLimited.map((p) => p.replace(/[\w-]{16,}/g, ":id")))].slice(0, 5),
    realBrowsers: realPages.map((p) => ({
      loadMs: Math.round(p.loadMs),
      imagesOk: p.imagesOk,
      errors: p.errors.length,
      apiStatuses: p.apiStatuses,
      failure: p.failure,
    })),
    websocketConnections: afterBurst?.websocketConnections,
  };
  log(`Burst done: ${JSON.stringify(report.burst)}`);

  // ---------- 4. Soak: instructor edits while everyone stays connected ----------
  const instructor = new WebsocketProvider(`${wsUrl.origin}${wsUrl.pathname.replace(/\/[^/]+$/, "")}`, roomId, new Y.Doc(), {
    WebSocketPolyfill: Socket,
    disableBc: true,
    params: Object.fromEntries(wsUrl.searchParams),
    protocols: ["devshare", "editor." + editorToken],
  });
  providers.add(instructor);
  assert.ok(await until(() => instructor.synced));
  const sent = new Map();
  const updateLatency = [];
  const perUpdateFull = [];
  let update = 0;
  const soakStart = now();
  const soakFirst = samples.at(-1);
  let refreshWaveDone = false;
  log(`Soak: ${SOAK_MS / 60000} min, one instructor edit every ${UPDATE_MS / 1000} s`);
  while (now() - soakStart < SOAK_MS) {
    const n = ++update;
    const text = lessonText(instructor);
    sent.set(n, now());
    instructor.doc.transact(() => text.insert(text.length, `LIVE-${n} instructor note at ${new Date().toISOString()}\n`));
    if (n % 6 === 0) {
      // Every 30 s the instructor also changes the YAML file's replica count.
      const yaml = instructor.doc.getMap("documents").get(docs["deployment.yaml"]).get("content");
      const at = yaml.toString().indexOf("replicas: ") + 10;
      instructor.doc.transact(() => {
        yaml.delete(at, 1);
        yaml.insert(at, String(((n / 6) % 9) + 1));
      });
    }
    await until(() => viewers.every((v) => v.arrivals.has(n)), UPDATE_MS * 4, 5);
    const arrivals = viewers.map((v) => v.arrivals.get(n)).filter(Boolean);
    updateLatency.push(...arrivals.map((t) => t - sent.get(n)));
    perUpdateFull.push({ n, delivered: arrivals.length, fullMs: arrivals.length ? Math.max(...arrivals) - sent.get(n) : null });
    // Halfway: every viewer refreshes the page at once (images re-fetched, cache bypassed).
    if (!refreshWaveDone && now() - soakStart > SOAK_MS / 2) {
      refreshWaveDone = true;
      const before = { ...httpStatuses };
      const waveStart = now();
      await Promise.all(viewers.map(loadPage));
      const imageMs = viewers.flatMap((v) => v.http.filter((t) => t.path.includes("/images/")).map((t) => t.ms));
      report.refreshWave = {
        totalMs: Math.round(now() - waveStart),
        imageRequestMs: stats(imageMs),
        newStatuses: Object.fromEntries(Object.entries(httpStatuses).map(([k, v]) => [k, v - (before[k] ?? 0)])),
      };
      log(`Refresh wave: ${JSON.stringify(report.refreshWave)}`);
    }
    if (n % 24 === 0) {
      const m = samples.at(-1);
      log(
        `t+${((now() - soakStart) / 60000).toFixed(1)} min: update ${n}, last fan-out ${perUpdateFull.at(-1).fullMs?.toFixed(0)} ms, ` +
          `RSS ${(m.memory.rss / 1048576).toFixed(0)} MiB, heap ${(m.memory.heapUsed / 1048576).toFixed(0)} MiB, sockets ${m.websocketConnections}, ` +
          `disconnects ${viewers.reduce((s, v) => s + v.disconnects, 0)}`,
      );
    }
    await sleep(Math.max(0, UPDATE_MS - (now() - sent.get(n))));
  }
  const soakLast = samples.at(-1);
  // Real browsers show the latest live edit in their rendered preview.
  const lastMarker = `LIVE-${update}`;
  const realBrowserLive = [];
  for (const { page } of realPages)
    realBrowserLive.push(
      await until(() => page.locator(".markdown-preview").textContent().then((t) => t.includes(lastMarker)).catch(() => false), 20_000, 200),
    );
  const realChecks = [];
  for (const { page } of realPages)
    realChecks.push(
      await page.evaluate(() => ({
        images: [...document.querySelectorAll(".doc-image img")].filter((img) => img.complete && img.naturalWidth > 0).length,
        links: document.querySelectorAll(".markdown-preview a.doc-link").length,
        yamlKeys: document.querySelectorAll(".inline-block .tk-key").length,
        viewToggle: document.querySelectorAll(".markdown-switch").length,
        insertImage: [...document.querySelectorAll("button")].filter((b) => /Insert Image/.test(b.textContent)).length,
      })),
    );
  const soakSeconds = (soakLast.t - soakFirst.t) / 1000;
  const cpuSeconds = (s) => (s.cpuMicroseconds.user + s.cpuMicroseconds.system) / 1e6;
  const soakSamples = samples.filter((s) => s.t >= soakFirst.t);
  const heapMiB = soakSamples.map((s) => s.memory.heapUsed / 1048576);
  const rssMiB = soakSamples.map((s) => s.memory.rss / 1048576);
  // Leak check: compare the first and last thirds of the soak (heap after GC noise).
  const third = Math.max(1, Math.floor(heapMiB.length / 3));
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const windows = samples.slice(1).map((s, i) => ({
    t: s.t,
    cpu: ((cpuSeconds(s) - cpuSeconds(samples[i])) / ((s.t - samples[i].t) / 1000)) * 100,
  }));
  report.soak = {
    minutes: +(soakSeconds / 60).toFixed(1),
    updates: update,
    deliveredToAll: perUpdateFull.filter((u) => u.delivered === VIEWERS).length,
    fanOutLatencyMs: stats(updateLatency),
    fullFanOutMs: stats(perUpdateFull.map((u) => u.fullMs).filter((v) => v !== null)),
    unexpectedDisconnects: viewers.reduce((s, v) => s + v.disconnects, 0),
    reconnects: viewers.reduce((s, v) => s + v.reconnects, 0),
    closeCodes: [...new Set(viewers.flatMap((v) => v.closeCodes))],
    websocketConnectionsAtEnd: soakLast.websocketConnections,
    realBrowsersShowLatestEdit: realBrowserLive,
    realBrowserChecks: realChecks,
  };
  report.server = {
    baselineRssMiB: +(baseline.memory.rss / 1048576).toFixed(1),
    peakRssMiB: +Math.max(...samples.map((s) => s.memory.rss / 1048576)).toFixed(1),
    peakHeapUsedMiB: +Math.max(...samples.map((s) => s.memory.heapUsed / 1048576)).toFixed(1),
    soakRssFirstThirdMiB: +avg(rssMiB.slice(0, third)).toFixed(1),
    soakRssLastThirdMiB: +avg(rssMiB.slice(-third)).toFixed(1),
    soakHeapFirstThirdMiB: +avg(heapMiB.slice(0, third)).toFixed(1),
    soakHeapLastThirdMiB: +avg(heapMiB.slice(-third)).toFixed(1),
    cpuPercentOfOneCore: {
      burstPeak: +Math.max(...windows.filter((w) => w.t <= soakFirst.t).map((w) => w.cpu)).toFixed(1),
      soakAverage: +(((cpuSeconds(soakLast) - cpuSeconds(soakFirst)) / soakSeconds) * 100).toFixed(1),
      soakPeak: +Math.max(...windows.filter((w) => w.t > soakFirst.t).map((w) => w.cpu)).toFixed(1),
    },
    cpuSecondsTotal: +(cpuSeconds(soakLast) - cpuSeconds(burstCpuBefore ?? baseline)).toFixed(1),
    dockerPeak: (() => {
      const peaks = {};
      for (const { stats: list } of dockerSamples)
        for (const s of list) {
          const key = s.name.replace(`${docker}-`, "").replace(/-1$/, "");
          const mem = toMiB(s.mem.split("/")[0]);
          peaks[key] = {
            cpuPercent: Math.max(peaks[key]?.cpuPercent ?? 0, s.cpu),
            memMiB: Math.max(peaks[key]?.memMiB ?? 0, mem ?? 0),
            limit: s.mem.split("/")[1]?.trim(),
          };
        }
      return peaks;
    })(),
  };
  log(`Soak done: ${JSON.stringify(report.soak)}`);

  // ---------- 5. Anonymous viewers cannot change anything ----------
  const anon = {};
  const before = lessonText(instructor).toString();
  anon.uploadImage = (await api(`/rooms/${roomId}/images`, "POST", new Uint8Array(imageFiles[2][1]), { "content-type": "image/gif" })).status;
  anon.importImage = (await api(`/rooms/${roomId}/images/import`, "POST", { url: "https://example.com/a.png" })).status;
  anon.createDocument = (await api(`/rooms/${roomId}/documents`, "POST", { filename: "x.md", language: "markdown" })).status;
  anon.renameDocument = (await api(`/rooms/${roomId}/documents/${docs["lesson.md"]}`, "PATCH", { filename: "hacked.md" })).status;
  anon.deleteDocument = (await api(`/rooms/${roomId}/documents/${docs["lesson.md"]}`, "DELETE")).status;
  anon.deleteWorkspace = (await api(`/rooms/${roomId}`, "DELETE")).status;
  const victim = viewers[0];
  victim.closing = true;
  const closed = new Promise((resolve) => victim.provider.on("connection-close", (e) => e && resolve(e.code)));
  lessonText(victim.provider).insert(0, "VIEWER WRITE ");
  anon.yjsWriteCloseCode = await Promise.race([closed, sleep(10_000).then(() => "not rejected")]);
  victim.provider.shouldConnect = false;
  await sleep(1000);
  anon.contentUnchanged = !lessonText(instructor).toString().includes("VIEWER WRITE") && lessonText(instructor).toString() === before;
  // Every viewer claimed role "editor"; the server must show them all as viewers. Read from
  // a fresh client so the full presence list is requested from the server.
  const observer = new WebsocketProvider(`${wsUrl.origin}${wsUrl.pathname.replace(/\/[^/]+$/, "")}`, roomId, new Y.Doc(), {
    WebSocketPolyfill: Socket,
    disableBc: true,
    params: Object.fromEntries(wsUrl.searchParams),
    protocols: ["devshare"],
  });
  providers.add(observer);
  await until(() => observer.synced && observer.awareness.getStates().size > VIEWERS / 2, 20_000);
  await sleep(1000);
  const roles = [...observer.awareness.getStates()]
    .filter(([id]) => id !== observer.doc.clientID)
    .map(([, s]) => s.role ?? "none");
  anon.presenceSeen = roles.length;
  anon.rolesSeen = Object.fromEntries([...new Set(roles)].map((r) => [r, roles.filter((x) => x === r).length]));
  anon.forgedRolesOverwritten = roles.length > 0 && roles.every((role) => role === "viewer" || role === "editor") &&
    roles.filter((role) => role === "editor").length <= 1; // only the real instructor is an editor
  report.security = anon;
  log(`Security: ${JSON.stringify(anon)}`);

  // ---------- 6. Teardown and leak check ----------
  for (const v of viewers) v.closing = true;
  for (const provider of providers) {
    provider.destroy();
    provider.doc.destroy();
  }
  providers.clear();
  for (const { page } of realPages) await page.context().close();
  await until(async () => (await serverMetrics())?.websocketConnections === baseline.websocketConnections, 30_000, 500);
  const released = await serverMetrics();
  log("All clients closed; waiting for idle session eviction (~50 s)...");
  await sleep(50_000);
  const idle = await serverMetrics();
  sampling = false;
  await sampler;
  report.teardown = {
    websocketConnectionsAfterClose: released.websocketConnections,
    baselineWebsocketConnections: baseline.websocketConnections,
    sessionsForWorkspaceAfterIdle: idle.sessions.filter((s) => s.workspaceId === roomId).length,
    rssAfterIdleMiB: +(idle.memory.rss / 1048576).toFixed(1),
    heapAfterIdleMiB: +(idle.memory.heapUsed / 1048576).toFixed(1),
  };
  report.generatorRssMiB = +(process.memoryUsage().rss / 1048576).toFixed(1);
  // Remove the test workspace (and its images) from the local stack.
  report.cleanup = (await api(`/rooms/${roomId}`, "DELETE", undefined, asOwner())).status;
  if (args.output) await writeFile(args.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const provider of providers) {
    provider.destroy();
    provider.doc.destroy();
  }
  await browser?.close();
}
