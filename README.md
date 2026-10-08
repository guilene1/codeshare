# Kodelumi — Real-time coding, documentation and collaboration

**Code • Learn • Create • Share.** Kodelumi was previously named DevShare. Internal identifiers keep the original `devshare` name on purpose: localStorage keys (`devshare.*`), the session cookie (`__Host-devshare_sid`), the WebSocket subprotocol, the SQLite file, Docker volumes and Compose project, the server paths (`/opt/devshare`, `/opt/devshare-backup`) and the S3 bucket. Renaming any of them would sign users out, drop their saved tabs and settings, or detach existing data. Brand assets (logo mark, horizontal logos for dark and light backgrounds, favicon, app icons and web manifest) are in `frontend/public`; the in-app logo is `frontend/src/brand.tsx`.

Instructor accounts that own their workspaces, live read-only student links that need no account, permanent course history and Markdown lessons with individually copyable inline code blocks. React/Monaco/Yjs, one Node application, SQLite and Caddy. Code is shared, never executed.

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

1. **Sign Up** with a display name, email and password (at least 10 characters; common or personal words are rejected), or **Sign In**. Accounts are required to create workspaces; every workspace has exactly one owner.
2. **Create Workspace**: enter a course title and optional description, then choose Empty, Terraform, Kubernetes, Python or General DevOps. The owner opens it at `/w/ID` and sees **Editing** through the session; no credential appears in the URL.
3. **Share → Copy Student Link** gives anyone view-only access at the same `/w/ID` (plus `?folder=FOLDER_ID` for a lesson). Students need no account and see no name or sign-in prompt. Signed-in users who do not own the workspace are viewers too.
4. To let a co-teacher edit without transferring ownership, the owner chooses **Share → Create co-editor link**. The link (`/w/ID/edit/TOKEN`) is shown once; **Replace link** or **Revoke link** invalidates it immediately, including open connections. Co-editors can edit content and manage files and folders, but only the owner can rename, delete or manage links.
5. Create folders such as **Week 04 - Terraform**, open one and create files. Folder menus provide subfolders, rename, reorder and confirmed subtree deletion.
6. Open the student link in an incognito browser. Verify **View Only / Live**, Explorer navigation, selection/copy, search, personal theme/font and live instructor updates. Editing, paste and management controls are hidden, and the server rejects viewer writes over REST and WebSocket.
7. Refresh and restart the application container, then reopen the same lesson; content, order and folders remain.

## My Workspaces, lessons and tabs

**My Workspaces** lists the signed-in account's own workspaces on any device: search, recent/name sorting, file and folder counts and recent activity. Card menus rename, copy the Student Link or permanently delete (after typing the workspace name). Dashboard responses never include editor credentials. **Account** changes the display name, email (with the current password) and password; a password change signs out other devices, and **Sign out other devices** is available separately.

Sessions use an `HttpOnly`, `SameSite=Lax` cookie (`Secure` with the `__Host-` prefix in production) that expires after 14 idle days or 30 days in total; the server stores only its SHA-256 hash. Cookie-authenticated writes also require an allowed `Origin` and a per-session CSRF header. Passwords are hashed with Argon2id (`@node-rs/argon2`, 19 MiB, 2 passes). Sign-in, sign-up and password endpoints are rate-limited, and repeated failures lock an email for 15 minutes. No password, session or editor token is stored in localStorage.

**Lessons with inline code blocks.** Code blocks belong inside Markdown lesson documents, between headings, paragraphs and lists, each with its language label, syntax highlighting and its own **Copy** button. Markdown files open in **Edit / Split / Preview** for editors (Split by default on wide screens) and in **Preview** for students, who can switch to read-only Source. Editors can:

- **Insert code block** at the cursor (language picker), or **Add code block** at the end of the preview;
- select text and choose **Create Code Block from Selection** (right-click): in a Markdown file the selection becomes a block in place; in a source file such as `main.tf` it is added to a lesson document in the same lesson (or a new `lesson.md`), leaving the source file unchanged;
- **Edit**, **Move up/down** and **Delete** each block from the preview. Changes apply only if the block is unchanged since it was displayed, so a co-editor's concurrent edit is never overwritten.

Blocks are standard fenced code blocks in the shared document, so they collaborate live, persist like any text and survive download. Source files (`.tf`, `.py`, `.yaml`, `.js`…) stay plain source. Rendering builds React elements only: raw HTML is shown as text and unsafe link schemes are disabled. This is a small teaching renderer, not full CommonMark/GFM.

**Legacy snippets.** v1's separate Code Blocks panel is retired. Lessons that still contain v1 snippets show a read-only **Legacy snippets** view; an editor can choose **Move snippets into a lesson document**, which appends them, in order and with their titles, to a new `code-blocks.md`. Nothing migrates automatically, and the original snippet data is kept (hidden) so a rollback loses nothing.

**Tabs** work like an editor: clicking a file in the Explorer opens or focuses its tab; the **×** on a tab, middle-click or **Alt+W** closes it (Ctrl+W belongs to the browser). Closing a tab never changes or deletes the shared file, and edits are already live, so nothing is lost. Each browser remembers its open tabs per lesson; viewers manage their own tabs too.

All 15 languages are supported: Terraform/HCL, Python, Bash/Shell, YAML, JSON, JavaScript, TypeScript, Java, Go, Dockerfile, SQL, Markdown, HTML, CSS and plain text. HCL uses a custom tokenizer, not a Terraform language server.

## Persistence and memory

There is **no automatic course expiry or retention deletion**. Root files form the root lesson. Each folder has its own persisted Yjs snapshot and collaboration session. Opening one lesson loads only its code/snippets and lightweight explorer metadata; other lessons’ code remains in SQLite. Access/tree API reads do not load lesson documents.

At most 16 lesson sessions are cached. After the last connection leaves, dirty state is flushed. Idle sessions are disposed after 30 seconds, checked every 15 seconds, without deleting data. Reopening reloads from SQLite. Bounds: 256 nested folders (12 levels), 2,048 files per course, 64 files per lesson, 1,000 snippets per lesson (64 KiB each), 512 KiB combined lesson text, 2 MiB CRDT state. There is no fixed viewer-count maximum. These document/session bounds protect the small server; use the load test to measure actual capacity.

SQLite WAL checkpoints coalesce on a 1.5-second window rather than rewriting documents on each keystroke. Metadata changes persist explicitly; disconnects and graceful shutdown flush dirty state. Abrupt power loss can lose the newest uncheckpointed edit. Named Docker volumes survive restarts/reboots. **`docker compose down -v` deletes data and certificates.** Configure daily backups and test restores.

Investigate and upgrade Lightsail when representative classes cause sustained host RAM above 80–85%, growing swap usage, Node RSS approaching its 512 MiB container limit, OOM restarts, sustained high CPU with rising delivery latency, repeated disconnects/5xx errors or failing checkpoints. Repeated P95 full fan-out above 500 ms on a healthy nearby network warrants investigation. Monitor disk growth because course history is permanent. Run the load generator from another machine so its own RAM/CPU does not distort the 1 GB host measurements.

Public IDs contain 96 random bits; session, reset and editor tokens contain 256 random bits. Only hashes are stored in SQLite. Owners are recognised from the session cookie; REST validates Bearer credentials and WebSockets validate the request subprotocol credential, returning only fixed `devshare` in the handshake. Every Yjs write rechecks authorization (ownership with a live session, or a valid editor link), so sign-out, password changes and link rotation take effect immediately. The server supplies roles, rejects all viewer writes and validates candidate updates. Directory/file/block metadata mutations use authenticated REST. Tokens never enter shared Yjs state, viewer responses or bundles. Caddy omits request details from runtime/error logs; access logging is disabled.

## Checks and load test

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Backend tests use temporary databases and real WebSockets for registration, Argon2id hashing, sessions and expiry, CSRF/Origin enforcement, rate limits, password change/reset, ownership and cross-user denial, claiming, editor-link revocation, snippet migration, authorization, spoofed roles, rejected writes, folder isolation, idle eviction, migration, ordering, restart persistence and consistent backups. Browser tests exercise sign-up/sign-in/sign-out, account isolation, claiming and v1 shortcut import, real Monaco, nested folders, inline lesson blocks (insert, from selection, edit, move, delete, copy), closable tabs, student views, sharing and responsive themes.

Against the running Docker preview:

```sh
DEVSHARE_BASE_URL=http://localhost:8080 npm run test:e2e
node scripts/verify-docker.mjs
METRICS_TOKEN=local-preview-metrics-only npm run test:load -- --url=http://localhost:8080 --viewers=50 --updates=100 --document-kib=64 --output=load-test-report.json
```

PowerShell: set `$env:DEVSHARE_BASE_URL='http://localhost:8080'` or `$env:METRICS_TOKEN='local-preview-metrics-only'` before its command. The load script signs up a throwaway account (or uses `DEVSHARE_EMAIL`/`DEVSHARE_PASSWORD` for an existing one) and creates/removes only its synthetic workspace. It verifies real broadcasts, reconnects, authorization, cleanup and idle persistence. Follow [measurement instructions](docs/LOAD_TEST.md) for CPU/RAM and upgrade criteria. A local pass is not a Lightsail benchmark: repeat against production from a separate machine. Test-managed browser runs use `data/e2e.sqlite`; browser-created fixtures remain until manually deleted.

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
| `COOKIE_SECURE` | Defaults to secure cookies when `NODE_ENV=production`; the local HTTP preview sets `0` |
| `AUTH_SIGNUP_PER_HOUR`, `AUTH_SIGNIN_PER_15MIN`, `AUTH_FAILURES_PER_EMAIL` | Optional rate-limit overrides (defaults 10, 20, 10); the local preview raises them for browser tests |
| `DEVSHARE_BASE_URL` | Browser-test target; omit for test-managed local backend |
| `DEVSHARE_EMAIL`, `DEVSHARE_PASSWORD` | Optional existing account for the load test |

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

Append `--rotate` to revoke an existing private link. Operator output is deliberate one-time credential delivery; do not redirect it into logs or share it with students.

**Claiming v1 workspaces.** Existing workspaces have no owner. A signed-in user who opens one with its private editor link sees **Add to my account**; the claim succeeds only once, atomically. Users can also import the v1 shortcuts remembered in their browser from **My Workspaces**; each is claimed with its stored link and then deleted from localStorage. Editor links keep working after a claim. Resolve disputes with:

```sh
docker compose exec -T application node scripts/assign-owner.mjs WORKSPACE_ID owner@example.com
docker compose exec -T application node scripts/assign-owner.mjs WORKSPACE_ID --unowned
```

**Password resets.** Kodelumi does not send email yet, so **Forgot password?** asks users to contact the administrator, who issues a single-use link valid for 30 minutes:

```sh
docker compose exec -T application node scripts/issue-password-reset.mjs user@example.com https://code.example.com
```

The token is in the URL fragment, so it never reaches server or proxy logs; only its hash is stored. Using it signs out every session of that account. Send it to the user over a trusted channel.

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
