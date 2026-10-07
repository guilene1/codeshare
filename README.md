# DevShare — Live DevOps Classroom

One instructor, live read-only students, permanent course history and individually copyable teaching snippets. React/Monaco/Yjs, one Node application, SQLite and Caddy. Code is shared, never executed.

The [final requirements](REQUIREMENTS.md) supersede older specifications. See the complete [Lightsail deployment/backup guide](docs/DEPLOYMENT.md) and [configurable viewer measurement guide](docs/LOAD_TEST.md).

See [final acceptance evidence](docs/ACCEPTANCE.md) for verified browser/backend behavior, measured 50-viewer results and the external deployment checks that require your domain and AWS configuration.

The [final product review](docs/PRODUCT_REVIEW.md) describes the returning-instructor and teaching flows ready for local visual review.

## Run locally

Install Node **24+** and npm (built-in SQLite requires a modern Node release).

```sh
npm ci
npm run dev
```

Open http://localhost:5173. Vite proxies API/WebSockets to port 3000 and is used only for development. On restricted PowerShell use `npm.cmd` and `npx.cmd`.

Production-style preview with compiled assets served by Caddy:

```sh
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.local.yml -p devshare-local up -d --build
```

Open http://localhost:8080. The override binds only to localhost and sets local origins/metrics. Production uses `docker-compose.yml` alone with your `.env`.

## Test instructor/student access

1. Click **Create Workspace**, enter your name, course title and optional description, then choose Empty, Terraform, Kubernetes, Python or General DevOps. Templates create a few sensible starter files. The browser generates a cryptographic 32-byte token and sends only its SHA-256 hash when creating the workspace. Save the private editor link securely.
2. Creators see **Editing**. **Share → Copy Student Link** grants view-only access; **Copy Editor Link** grants editing and must remain private. Public `/w/ID` is always view-only. Private `/w/ID/edit/TOKEN` requires server validation. A selected lesson uses `?folder=FOLDER_ID` on either link.
3. Create folders such as **Week 04 - Terraform**. Open a folder and create files. Folder menus provide subfolders, rename, reorder and confirmed subtree deletion. File toolbar arrows reorder files.
4. Open the student link in an incognito browser. It opens immediately, with no name or onboarding prompt. Verify **View Only / Live**, folder/file navigation, selection/copy, search, personal theme/font and live instructor updates. Editing/paste and management controls must be hidden. Anonymous students contribute only to the viewer count; they never appear as named collaborators.
5. Choose **Code Blocks → + Add Code Block**. Each independent object has an optional title, language, content and its own **Copy → ✓ Copied** button. Copy includes only that block’s exact content; feedback lasts two seconds. Untitled one-line snippets use compact command rows. Instructors edit/delete/reorder blocks; students select/copy them.
6. Refresh and restart the application container, then reopen the same lesson. Content, language, order and directory must remain. Settings allows instructor-only workspace rename and permanent deletion after typing its name.

## Returning instructors and teaching notes

**My Workspaces** remembers workspaces created or opened with server-validated editor access. Home shows up to six recent shortcuts; `/workspaces` shows all remembered shortcuts, search, recent/name sorting, server file/snippet counts and compact recent activity. Use each card's menu to rename the shared workspace, copy either link or remove the local shortcut. **Remove from My Workspaces does not delete server content.** Permanent deletion is a separate confirmed action inside workspace settings.

The obvious **← My Workspaces** control checkpoints the active lesson before returning. Opening a card restores its remembered folder, file and Files & Editor/Code Blocks view. Counts, descriptions and meaningful structure/snippet activity come from lightweight SQLite summaries; dashboard requests never hydrate lesson Yjs documents. Activity is persisted without recording keystrokes.

Shortcuts and private editor tokens live in `devshare.workspaces.v1` in this browser's localStorage. This is intentionally **browser/device-specific**, with no account system. Student links never read or inherit those editor credentials. Clearing browser storage removes shortcuts and locally saved capabilities, but does not remove server content; keep private links separately for recovery. Use a private browser profile on shared devices. Revoked/deleted workspaces keep an explanatory unavailable shortcut until you remove it or open a valid editor link. Existing workspaces are remembered after you reopen their private editor link once; the server does not publicly list private courses.

For Markdown files, instructors use **Edit / Preview**; students start in **Preview** and can switch to read-only **Source**. Preview supports headings, paragraphs, emphasis, inline code, lists, quotes, links and highlighted fenced code with individual Copy buttons. Raw HTML renders as text and unsafe link schemes are disabled. This is a small teaching renderer, not a full CommonMark/GFM implementation; tables, embedded HTML and advanced extensions are not provided.

To save part of a file as an independent teaching snippet, select text in Monaco, right-click and choose **Create Code Block from Selection**. The dialog contains the exact selection and current file language. Add a title if useful, then **Create Block**. It appears in that lesson's Code Blocks view with its own Copy button. Students never receive this creation action. The existing **+ Add Code Block** workflow remains available.

All 15 languages are supported: Terraform/HCL, Python, Bash/Shell, YAML, JSON, JavaScript, TypeScript, Java, Go, Dockerfile, SQL, Markdown, HTML, CSS and plain text. Monaco provides syntax highlighting, line numbers, bracket matching, search/replace (instructor only), word wrap, minimap, font controls and shortcuts. HCL uses a custom tokenizer, not a Terraform language server.

## Persistence and memory

There is **no automatic course expiry or retention deletion**. Root files form the root lesson. Each folder has its own persisted Yjs snapshot and collaboration session. Opening one lesson loads only its code/snippets and lightweight explorer metadata; other lessons’ code remains in SQLite. Access/tree API reads do not load lesson documents.

At most 16 lesson sessions are cached. After the last connection leaves, dirty state is flushed. Idle sessions are disposed after 30 seconds, checked every 15 seconds, without deleting data. Reopening reloads from SQLite. Bounds: 256 nested folders (12 levels), 2,048 files per course, 64 files per lesson, 1,000 snippets per lesson (64 KiB each), 512 KiB combined lesson text, 2 MiB CRDT state. There is no fixed viewer-count maximum. These document/session bounds protect the small server; use the load test to measure actual capacity.

SQLite WAL checkpoints coalesce on a 1.5-second window rather than rewriting documents on each keystroke. Metadata changes persist explicitly; disconnects and graceful shutdown flush dirty state. Abrupt power loss can lose the newest uncheckpointed edit. Named Docker volumes survive restarts/reboots. **`docker compose down -v` deletes data and certificates.** Configure daily backups and test restores.

Investigate and upgrade Lightsail when representative classes cause sustained host RAM above 80–85%, growing swap usage, Node RSS approaching its 512 MiB container limit, OOM restarts, sustained high CPU with rising delivery latency, repeated disconnects/5xx errors or failing checkpoints. Repeated P95 full fan-out above 500 ms on a healthy nearby network warrants investigation. Monitor disk growth because course history is permanent. Run the load generator from another machine so its own RAM/CPU does not distort the 1 GB host measurements.

Public IDs contain 96 random bits; private tokens contain 256 random bits. Only hashes are stored in SQLite. REST validates Bearer credentials and WebSockets validate the request subprotocol credential, returning only fixed `devshare` in the handshake. Every Yjs write rechecks authorization, including after rotation. The server supplies roles, rejects all viewer writes and validates candidate updates. Directory/file/block metadata mutations use authenticated REST. Tokens never enter shared Yjs state, viewer responses or bundles. Caddy omits request details from runtime/error logs; access logging is disabled.

## Checks and load test

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Backend tests use temporary databases and real WebSockets for authorization, spoofed roles, rejected writes, folder isolation, idle eviction, migration, ordering, restart persistence and consistent backups. Browser tests exercise real Monaco, Terraform/Python/YAML highlighting, nested folders, student views, snippets/copying, sharing and responsive themes.

Against the running Docker preview:

```sh
DEVSHARE_BASE_URL=http://localhost:8080 npm run test:e2e
node scripts/verify-docker.mjs
METRICS_TOKEN=local-preview-metrics-only npm run test:load -- --url=http://localhost:8080 --viewers=50 --updates=100 --document-kib=64 --output=load-test-report.json
```

PowerShell: set `$env:DEVSHARE_BASE_URL='http://localhost:8080'` or `$env:METRICS_TOKEN='local-preview-metrics-only'` before its command. The load script creates/removes only its synthetic workspace. It verifies real broadcasts, reconnects, authorization, cleanup and idle persistence. Follow [measurement instructions](docs/LOAD_TEST.md) for CPU/RAM and upgrade criteria. A local pass is not a Lightsail benchmark: repeat against production from a separate machine. Test-managed browser runs use `data/e2e.sqlite`; browser-created fixtures remain until manually deleted.

## Environment

| Variable | Usage |
| --- | --- |
| `DOMAIN` | Required production Compose hostname, such as `code.example.com` |
| `ACME_EMAIL` | Required production Compose certificate email |
| `METRICS_TOKEN` | Optional random operator secret for `/api/metrics`; blank disables it |
| `PORT`, `DB_PATH` | Local defaults `3000`, `data/devshare.sqlite`; Compose uses `3000`, `/data/devshare.sqlite` |
| `ALLOWED_ORIGINS` | Exact comma-separated browser origins; Compose uses `https://DOMAIN` |
| `TRUST_PROXY` | Local `0`; Compose `1` for Caddy’s single hop |
| `NODE_OPTIONS` | Compose sets `--max-old-space-size=384`; app container limited to 512 MiB |
| `S3_BACKUP_BUCKET`, `S3_BACKUP_PREFIX`, `AWS_REGION` | Optional host backup configuration; app never requires S3 |
| `AWS_PROFILE` / AWS CLI credentials | Host authentication only, never committed or embedded in images |
| `DEVSHARE_BASE_URL` | Browser-test target; omit for test-managed local backend |

Old retention variables are ignored. Preserve existing volumes during upgrades; migrations add folders, positions and nullable folder associations without removing root files or snippets.

## Legacy recovery and rotation

Workspaces created before token hashes remain publicly readable. Knowing their ID never grants editing. An operator can create a private link:

```sh
docker compose exec -T application node scripts/recover-editor.mjs WORKSPACE_ID https://code.example.com
```

Local preview:

```sh
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.local.yml -p devshare-local exec -T application node scripts/recover-editor.mjs WORKSPACE_ID http://localhost:8080
```

Append `--rotate` to revoke an existing private link. Operator output is deliberate one-time credential delivery; do not redirect it into logs or share it with students. No public ownership-claim endpoint exists.

## Project structure

```text
frontend/src/
  App.tsx / lib.ts / styles.css
  components/
    CodeEditor.tsx       Monaco/Yjs and HCL tokenizer
    CourseExplorer.tsx   Nested folders, files and instructor management
    CreateWorkspace.tsx  Description and starter-template creation
    WorkspaceDashboard.tsx  Browser-specific courses and recent activity
    MarkdownPreview.tsx Safe live teaching notes and copyable fenced examples
    ClassroomAwareness.ts  Local student selections, shared instructor presence
    CodeBlocks.tsx       Independent highlighted, individually copyable snippets
    AccessShare.tsx      Public/private lesson sharing
    SettingsPanel.tsx    Personal settings and workspace management
    Modal.tsx
backend/src/
  app.ts                 Authorized API, directory and protected metrics
  rooms.ts               Lazy lesson sessions and coalesced persistence
  templates.ts           Small starter file collections
  database.ts            Additive schema migrations
  blocks.ts / access.ts  Snippet validation and credential hashing
  websocket.ts           Yjs sync, server roles, heartbeat and bounds
  index.ts               Startup and graceful shutdown
backend/test/            Real-client integration and snapshot tests
tests/                   Browser acceptance tests
scripts/
  load-test.mjs          1 instructor + configurable anonymous viewers
  verify-docker.mjs      Caddy and restart verification
  snapshot.mjs           Consistent SQLite online backup
  backup.sh              Compressed timestamped S3 upload
  recover-editor.mjs     Operator-only recovery/rotation
docs/DEPLOYMENT.md / LOAD_TEST.md
REQUIREMENTS.md / README.md
Dockerfile / docker-compose.yml / docker-compose.local.yml / Caddyfile
```

## Practical limitations

- One Node replica owns SQLite and active sessions. Horizontal scaling requires different coordination.
- Students navigate lessons independently; broadcasts go to students in the opened lesson. Share a lesson-specific link to keep a class together.
- Private links are bearer capabilities without accounts or individual revocation; rotation revokes the workspace’s previous private link.
- Create files inside their intended lesson; moving files between folders is not provided. Folder/file/block ordering is supported.
- Abrupt power loss can lose uncheckpointed edits. Disk space, backup success and restores require monitoring.
- The load generator uses real protocol clients, not full browser renderers. Run it away from the 1 GB host and perform longer tests there before capacity decisions.
- Actual S3 upload and public HTTPS certificate issuance require your bucket/AWS credentials/domain. Local tests validate snapshots, production containers and optional-backup operation without those external credentials.

## Configurable viewer testing

50 concurrent viewers is the minimum acceptance test target, not an application limit. Additional anonymous read-only viewers can connect as server resources permit. Actual capacity depends on production CPU, RAM, network traffic, document size and update frequency; no specific maximum capacity is claimed. The single-server Caddy/Node/SQLite architecture is unchanged.

```sh
npm run test:load -- --viewers=50
npm run test:load -- --viewers=100
npm run test:load -- --viewers=200
```

These commands target the local preview by default. Set `--url` for your production target and `METRICS_TOKEN` for protected backend CPU/RAM/connection measurements. Keep host/Docker monitoring enabled and use the existing upgrade criteria above to decide when to resize Lightsail. Run the load generator on a separate machine.
