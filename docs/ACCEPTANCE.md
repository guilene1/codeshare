# Final acceptance evidence

The targeted anonymous student-access update was verified on 2026-10-07: public links open directly in fresh browser contexts with no name or join dialog; instructor-only controls are absent from the student DOM. Viewer connection/disconnection changes the instructor count, and server presence strips viewer names, selections and claimed roles. Nine backend tests and five browser regressions passed, including REST/Yjs mutation rejection and individual snippet clipboard copying. The existing design and private editor flow remain intact. The anonymous load regression (`load-test-report-anonymous.json`) passed with one instructor, 50 anonymous viewers, 100 updates and a 256 KiB lesson. It verified no viewer name/selection fields, read-only write rejection, ten reconnects, socket cleanup, idle eviction and exact content restoration. Local fan-out latency was P95 31.9 ms (maximum 47.4 ms), peak Node RSS 105.7 MiB and sampled CPU 55.3% of one core; the one pre-existing socket remained after cleanup.

Verified on the local Windows development host through the two-container production Docker stack, final product pass 2026-10-07 (America/New_York).

| Check | Evidence |
| --- | --- |
| TypeScript and compiled frontend/backend | `npm run typecheck`, `npm run build` passed |
| Server authorization, persistence and validation | Nine backend tests passed, including malicious REST/Yjs updates, role spoofing, token rotation, folder isolation, SQLite migrations, protected metrics, all five templates and persistent private summaries/activity without lesson hydration |
| Instructor/student browser flows | Five Playwright tests passed: real Monaco collaboration, read-only access, independent snippets/commands and clipboard, nested course management, syntax highlighting, themes, templates/descriptions, safe Markdown preview, exact selected snippets, dashboard return, local shortcut removal and responsive layouts. The product journey also passed twice consecutively and after adding actual mobile clipboard checks |
| Real 50-viewer load | `load-test-report-product.json`: one instructor, 50 read-only viewers, 100 updates, 256 KiB lesson; all clients converged |
| Reconnect and cleanup | Load test verified ten reconnects, rejected student writes, baseline socket count restoration and provider exit-listener cleanup |
| Idle RAM release without deletion | Test checked its exact workspace ID disappeared from loaded sessions and reopening restored exact content |
| Docker persistence and production serving | `node scripts/verify-docker.mjs` passed: root files, nested lesson content, snippet objects, descriptions, activity and credentials survived application container restart; the same browser reloaded My Workspaces and its remembered shortcut opened the saved lesson with editor access. Caddy served static assets and proxied HTTP/WebSockets |
| Safe backup | Backend snapshot test verified a complete, restorable SQLite online backup while WAL database was open, including nested lesson content and snippets; Linux `bash -n scripts/backup.sh` passed |
| Optional S3 | App, browser suite, load test and restart verification ran with no S3 configuration |
| No Vite in production | Compose runs Caddy static files and compiled Node backend; Vite is confined to the build stage |

Peak sampled Node RSS was 103.2 MiB. Full fan-out latency was P95 36.0 ms (maximum 61.7 ms); sampled peak CPU was 63.2% of one core. Two unrelated baseline sockets remained after cleanup; every synthetic load session was disposed. Read [LOAD_TEST.md](LOAD_TEST.md) for workload details, earlier results, monitoring and upgrade thresholds. Local measurements establish a reproducible test result, not capacity on an actual 1 GB Lightsail machine.

The product was visually reviewed using the landing/workspace regression screenshots, dark and light dashboard screenshots and a mobile live Markdown preview with successful per-example clipboard copy. See [PRODUCT_REVIEW.md](PRODUCT_REVIEW.md) for the final user-facing review.

External acceptance remains dependent on operator configuration: deploy to Ubuntu Lightsail, validate public DNS/HTTPS certificate issuance, execute a real S3 upload using the configured bucket/credentials and test its restore. The application does not require these external resources to run locally. See [DEPLOYMENT.md](DEPLOYMENT.md) for complete instructions.

Scalability update verification (2026-10-07): TypeScript checks, Docker production build and all nine backend regressions passed. Configurable `npm run test:load` runs with 50, 100 and 200 anonymous viewers all passed with protected resource measurements, authorization, reconnect, cleanup and persistence checks. Fixed 80-per-lesson/320-global connection caps and the load-script 79-viewer ceiling were removed. Message size/rate limits and slow-client protection remain. The Caddy/Node/SQLite single-server architecture is unchanged; these local test results do not establish a production maximum.
