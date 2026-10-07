# Scalability update

50 anonymous concurrent viewers is a minimum acceptance target, never an application maximum. Accept additional viewers as resources permit, with no fixed per-lesson or global viewer-count cap. Load tests support configurable positive concurrency including 50, 100 and 200. Preserve anonymous presence, authorization, resource monitoring and the single-server Caddy/Node/SQLite architecture. Capacity depends on production CPU, RAM, network traffic, document size and update frequency; never claim a specific maximum. This supersedes earlier connection-count bounds.

# Final student access update ? October 7, 2026

Public student links open immediately without names, accounts, login or onboarding. Students are anonymous; presence supplies a viewer count, never invented names or a student roster. Instructor-only controls are hidden entirely, including file/folder/block creation, editing, paste, save, rename, delete, reorder, shared language/settings and selection-to-block creation. Students retain navigation, live reading, Markdown preview, selection, search, individual snippet copying and personal theme/font preferences. Private editor capabilities remain the only editing authorization, enforced for REST and WebSocket/Yjs writes. Preserve the existing design and instructor flow. No AWS deployment or GitHub push is authorized by this update.

# Live DevOps Classroom — final requirements

This document supersedes earlier conflicting requirements (latest product pass, 2026-10-07).

## Final product pass

- Preserve the existing architecture and working code. Use workspace terminology throughout the product and polish the existing landing/IDE without rebuilding them.
- Landing keeps its two-column layout, uses the requested teaching-focused copy, professional capability labels and useful recent instructor shortcuts.
- My Workspaces is browser/device-specific: privately remember validated editor capabilities locally, show lightweight server summaries, search/sort/open/rename/copy links and remove local shortcuts without deleting server content. Remember lesson/file/view context; editor credentials never enter student state or shared responses.
- Create Workspace includes an optional description and Empty, Terraform, Kubernetes, Python or General DevOps starter templates.
- Markdown files support source editing and safe rendered preview; students read preview/source and copy. Raw HTML is not executed.
- Instructors can create an independent code block from the exact selected Monaco text, defaulting to the active file language. Keep the existing Add Code Block workflow and per-block copy controls.
- Persist meaningful structural activity in SQLite, never every keystroke. Dashboard summaries/activity must not hydrate inactive Yjs documents.
- Keep permanent history, lazy session disposal, security, optional S3 backups, production Caddy/Node and reproducible 50-viewer testing.
- Do not deploy to AWS or push to GitHub. Complete and visually verify the local product for user review, then report changes, preserved behavior, flows, persistence, tests/load results and limitations.

- Primary deployment: Ubuntu on AWS Lightsail, 2 vCPU / 1 GB RAM. One instructor with at least 50 simultaneous read-only viewers; capacity must be demonstrated with a reproducible load test, not assumed.
- Course history is permanent until an instructor explicitly deletes it. No retention-based deletion. SQLite stores workspaces, nested folders, files, independent snippets, languages, ordering, timestamps and CRDT snapshots.
- Each folder is a separately loaded lesson/collaboration session. Only opened sessions and lightweight explorer metadata belong in RAM. Persist and dispose disconnected idle sessions; reload from SQLite when reopened.
- Public workspace links always grant view-only access. Private cryptographic editor credentials are verified on the server for REST and every Yjs write. SQLite stores only hashes. Never expose private tokens to viewers, shared documents, responses, bundles or service logs.
- Preserve Monaco, all 15 existing languages, selection/copy/search, live collaboration, role indicators, personal themes/font sizes, independent highlighted snippets and per-snippet Copy → Copied feedback.
- Instructors manage nested folders, files, titles, languages, ordering, snippets and shared settings. Students navigate and copy only. Snippets belong to a workspace/lesson and are objects, never Markdown fences inside Monaco.
- Coalesced SQLite checkpoints, disconnect/shutdown flushing, WebSocket heartbeats and bounded sessions/connections protect the small server.
- Production runs built static React through Caddy, HTTPS and API/WebSocket reverse proxy, plus one Node/SQLite application and persistent Docker volumes. No Vite dev server, Redis, Kubernetes or additional databases.
- Optional daily backups create consistent SQLite snapshots, compress and upload timestamped S3 objects, and log both success and failure. Unconfigured S3 does not affect the app.
- A 1-editor/50-viewer load script verifies establishment, broadcasts, reconnects, cleanup, and reports measurable Node/Docker memory, CPU and connection counts. README includes upgrade criteria and complete deployment/recovery instructions.
- After each major phase: TypeScript check, frontend production build, backend tests, then correct failures before proceeding. Final browser checks cover folders, highlighted languages, snippets, student authorization and persistence. Final report includes implementation, structure, local run, access tests, load test, Lightsail deployment, environment and remaining limitations.

Implementation phases: (1) permanent storage and classroom bounds; (2) lazy folder lessons and explorer; (3) Caddy production assets, backups and load measurement; (4) acceptance tests and documentation.
