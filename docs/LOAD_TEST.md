# Configurable anonymous viewer load test

Run this on a laptop or separate machine, **not inside the 1 GB server**: Simulated Yjs clients consume their own RAM. The target receives real WebSocket traffic through Caddy. Use an otherwise quiet instance for repeatable server metrics.

## Test the local production preview

Start the Docker preview from README, install root dependencies, then:

```sh
METRICS_TOKEN=local-preview-metrics-only npm run test:load -- --url=http://localhost:8080 --viewers=50 --updates=100 --interval-ms=100 --document-kib=64 --output=load-test-report.json
```

PowerShell:

```powershell
$env:METRICS_TOKEN='local-preview-metrics-only'
npm.cmd run test:load -- --url=http://localhost:8080 --viewers=50 --updates=100 --interval-ms=100 --document-kib=64 --output=load-test-report.json
```

The local metrics token is public test configuration and is only used by the localhost-bound override. Production has no default token; configure a long random `METRICS_TOKEN` in `.env`, recreate the application and supply the same value only to the operator’s shell. `/api/metrics` returns 404 without a configured/matching credential and contains no course content or editor tokens.

## Test actual Lightsail capacity

```sh
export METRICS_TOKEN=YOUR_OPERATOR_SECRET
npm run test:load -- --url=https://code.example.com --viewers=50 --updates=1000 --interval-ms=100 --document-kib=256 --output=lightsail-load-report.json
```

Arguments: `--url`, `--viewers` (any positive safe integer; default 50, plus one additional instructor), `--updates` (1–10,000), `--interval-ms` (25–10,000), `--document-kib` (1–400), `--settle-ms` (at least 31,000; default 35,000), and optional JSON `--output`. Actual lesson text must stay under its storage limit. The default run takes about a minute because it waits for idle eviction. Use long runs/representative lesson sizes and repeat after deploying changes.

The script creates a temporary workspace, an active lesson and six inactive folders; it removes only its own workspace afterward. It checks:

- One authenticated instructor and the requested number of simultaneous anonymous read-only clients fully synchronize; 50 is the minimum acceptance test target.
- The server overwrites forged viewer role claims.
- Instructor changes reach every viewer; per-update full fan-out latency is measured.
- Student REST and raw Yjs writes are rejected without contaminating instructor content.
- Up to ten clients disconnect/reconnect and receive an edit made while they were away.
- Sockets close and return to the baseline count.
- After the idle timeout/collector cycle, temporary sessions leave RAM. Reopening retains the exact lesson content.

Reports contain connection setup duration, P50/P95/max fan-out latency, peak measured Node RSS, sampled Node CPU as a percentage of one core, loaded sessions and WebSocket counts, plus load-generator RSS separately. Without `METRICS_TOKEN`, protocol checks still run but server measurements are null; use host/Docker monitoring. CPU sampling is process-based, not whole-host utilization; metrics include a 10 ms polling resolution and real network latency. Idle disposal allows Node GC/OS allocation reuse and does not guarantee RSS immediately returns to baseline.

For progressively larger local runs:

```sh
npm run test:load -- --viewers=50
npm run test:load -- --viewers=100
npm run test:load -- --viewers=200
```

These are test sizes, not capacity claims. Use `--url`, `METRICS_TOKEN` and distinct `--output` files when measuring production.

## Monitor RAM, CPU and connections

On the Lightsail host, in separate terminals during the test:

```sh
docker compose stats
docker stats --no-stream
free -h
vmstat 1
top
df -h
docker inspect "$(docker compose ps -q application)" --format '{{.State.OOMKilled}}'
```

For protected Node measurements and active sockets from the operator machine:

```sh
curl --fail -H "Authorization: Bearer $METRICS_TOKEN" https://code.example.com/api/metrics
```

`memory.rss`, `heapUsed`, `heapTotal`, `external` and `arrayBuffers` are bytes. `cpuMicroseconds` is cumulative process CPU; the script samples deltas. `activeSessions` counts loaded root/folder Yjs sessions, not all persisted course folders. `websocketConnections` is the authoritative server socket count. Browser presence badges are user-friendly indicators, not an operational metrics endpoint.

With no other clients, expect 51 open sockets for 50 viewers plus the instructor and zero after cleanup. Inactive folders should not create loaded Yjs sessions. After the idle cycle, test-created sessions should be gone; persistent course rows remain until the script explicitly deletes its fixture.

## Recorded local verification

The final product pass was rerun on 2026-10-07 with the same 256 KiB / 50-viewer / 100-update workload. `load-test-report-product.json` passed: connection setup 445 ms, full fan-out P50 23.2 ms / P95 36.0 ms / maximum 61.7 ms, sampled Node peak RSS 103.2 MiB and sampled peak CPU 63.2% of one core. The client generator used 131.0 MiB RSS. Two unrelated baseline sockets remained: 53 at full load, two after cleanup, and no synthetic session remained after idle disposal. All reconnect, authorization, persistence and cleanup assertions passed. These are local Docker measurements, not cloud capacity claims; machine load differed between runs.

The retained `load-test-report-256k.json` records a passing local Docker run through Caddy: one instructor and 50 viewers, 256 KiB lesson, 100 updates spaced 100 ms apart. Full fan-out latency was P50 31.4 ms, P95 225.1 ms and maximum 765.9 ms; sampled Node peak RSS was 99.8 MiB and peak CPU was 78.7% of one core. The separate client generator used 133.9 MiB RSS. These are measurements on the Windows Docker development host, not an Ubuntu Lightsail benchmark.

There was one unrelated baseline socket/session. The test added 51 sockets (52 total), returned to one after cleanup, and verified by workspace ID that every synthetic lesson session left RAM. Reopening recovered the exact saved content. It also tested student write rejection, ten reconnects, and provider listener cleanup. Container limits were 512 MiB for Node and 128 MiB for Caddy. Repeat on a quiet production host before making capacity decisions.

Student selection stays local; instructor cursor presence remains shared. Ignored echoes of another client's presence do not consume the per-client accepted-update rate budget. Socket frames still have a separate upper bound.

## Upgrade criteria

Investigate slow networks first, then upgrade the instance if representative classes show sustained host RAM above roughly 80–85%, increasing swap activity, Node RSS approaching its 512 MiB limit, OOM restarts, sustained high CPU with increasing broadcast latency, repeated 5xx/reconnects, or checkpoints failing/lagging. A practical investigation trigger is repeated P95 full fan-out above 500 ms on a healthy nearby network; this is an operating threshold, not a guaranteed SLA. More classes opening different large lessons may hit the 16-session guard before a single 50-student lesson does. Monitor disk capacity for permanent history and backup archives.

Local Docker results are evidence of protocol correctness and measured local resource use, not proof of a specific cloud host’s capacity. Record CPU architecture, Docker limits, lesson size, viewer count, update rate and network conditions with every report. There is no fixed viewer-count maximum. Actual capacity depends on production CPU, RAM, network traffic, document size and update frequency. Per-message size/rate limits, slow-client backpressure and lesson-session/document bounds remain resource safeguards, not advertised viewer capacity.

## Anonymous student regression ? October 7, 2026

`load-test-report-anonymous.json` records one instructor and 50 unnamed viewers with 100 updates at 100 ms intervals to a 256 KiB lesson. All viewers synchronized. Instructor-visible presence contained only anonymous viewer markers and server-assigned viewer roles, with no names or selections. Student mutation rejection, ten reconnects, socket/provider cleanup, idle session release and persisted content restoration all passed. Local full fan-out latency: P50 20.7 ms, P95 31.9 ms, maximum 47.4 ms. Peak Node RSS: 105.7 MiB; sampled peak CPU: 55.3% of one core. These are local Docker measurements.

## Configurable concurrency regression ? October 7, 2026

The local Docker stack passed sequential 50-, 100- and 200-anonymous-viewer runs after removing fixed per-lesson/global connection caps. Each run used one additional instructor, a 64 KiB lesson and 100 updates spaced 100 ms apart. Each verified convergence, anonymous presence, viewer REST/Yjs write rejection, ten reconnects, baseline socket/listener cleanup, idle eviction and exact persistence restoration. Reports: `load-test-report-50.json`, `load-test-report-100.json`, `load-test-report-200.json`.

| Anonymous viewers | P95 full fan-out | Peak Node RSS | Sampled peak CPU, one core |
| --- | --- | --- | --- |
| 50 | 31.3 ms | 91.5 MiB | 59.5% |
| 100 | 34 ms | 95.4 MiB | 95% |
| 200 | 81.3 ms | 91.9 MiB | 98.8% |

These are measurements of this local workload, not maximum-capacity claims or Lightsail benchmarks. Repeat representative production tests with host, container and network monitoring before resizing decisions.
