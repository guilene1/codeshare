# Content locks and Live Coding sessions

## Content locks

Instructors prepare a whole course in advance and decide when students can open each part.

- **What can be locked:** the workspace, any folder or nested folder, and individual files. Locks are independent: a locked parent restricts everything inside it, unlocking a child never bypasses a locked parent, and unlocking a parent (or the workspace) leaves individually locked children locked. Example: release *Week 01* while *Lab-solutions.sh* inside it stays locked.
- **Visibility before release:** *visible* (name, amber padlock, "Locked" and any "Available from" date) or *hidden* (the item and everything inside it is left out of every response, as if it didn't exist).
- **Scheduled release:** a date, time and IANA time zone, stored as one UTC instant. Times skipped by a daylight-saving change are refused; a time that occurs twice means its first occurrence. One server-wide timer fires at the next release, with a 15-second sweep as a safety net. Each release is a single conditional `DELETE`, so it happens exactly once, and releases that fell due while the server was stopped are processed at startup. A release removes only its own lock: it never overrides a locked parent and never changes sharing.
- **Who manages locks:** the workspace owner. The owner can let accounts or teams (who already have access through sharing) lock and unlock, schedule releases, and open locked content, in the whole workspace or one folder. Lock permissions never grant access by themselves. Ordinary Editors keep their editing rights but get neither lock management nor access to locked content.
- **History:** every change (including automatic releases and permission changes) is recorded in `lock_events`, with who made it.

### Enforcement (server side)

Locks are enforced by the server on every path, not only in the interface:

| Path | Behaviour for people locks restrict |
| --- | --- |
| Explorer tree (REST) | hidden items left out; locked items carry `lock` (state, release date) |
| File, block and lesson routes | visible lock: `423 Locked` with the release date; hidden: the same `404` as a missing item |
| Folder changes | no creating, renaming, moving or deleting inside or of locked folders; a folder holding locked content can't be deleted |
| File reordering | only the files they can open; locked files keep their place |
| Images | only images used by a file they may open (or unused, just uploaded, in an open lesson) |
| WebSocket | the lesson's live document is replaced by a filtered copy without locked files (blank when the lesson itself is locked); hidden lessons refuse the connection |
| Student links, Edit Links, workspace/folder/team shares | all go through the same gate |
| Activity feed (REST and live) | entries naming hidden items are left out |
| Live sessions associated with locked content | closed to everyone but their runners until released |

**Filtered live copies.** A lesson's live (Yjs) document holds every file of that lesson, so a socket connected to it would receive a locked file's text. People restricted there are connected to a filtered copy kept on the server (`backend/src/lessonView.ts`). Every change to either copy is applied to the other at once, as the exact text change, so both stay identical. Each client sends which copy it holds (`doc` URL parameter, from the `{doc}` notice); a client holding another copy (after a lock change or a server restart) is closed with `4001` and starts over with a fresh document, so two unrelated copies are never merged. Tabs from before this release send no `doc` and are asked to reload when they would need a filtered copy.

**Immediate revocation.** Every lock change re-checks the live sockets of the workspace: sockets that must switch copies are closed (`4001`) and reconnect with what they may now see; filtered copies gain or lose files live; open Explorers re-read their tree.

### Limitations

- **Content already downloaded, copied, screenshotted or cached cannot be recalled.** Locking stops future access only. Images are cached by browsers for up to a year (`Cache-Control: private, immutable`), so an image a student has already loaded may still show from their cache.
- In a lesson that contains locked files, restricted viewers don't see instructors' live cursors (cursor positions refer to the full document).
- A restricted Editor who creates a file with the same name as a hidden file is told the name is taken.
- Filtered copies are not saved: after a server restart, people restricted in a lesson with locked files reconnect once with a fresh copy (their editor reloads briefly). Content is never lost: edits always land in the lesson itself.
- Releases before locks (d4844ea and earlier) can't enforce them. Roll back only with `scripts/rollback-release.sh` (below), which never starts one of them on a database where locks are in use.

## Live Coding sessions

A session is its own live document (files like a lesson, with the same limits: 64 files, 1 MB per file, 2 MB per session) and its own images. It is never part of a workspace.

- **States:** draft (owner and collaborators only), live, paused (viewers keep what they had at the pause and catch up exactly on resume; the pause snapshot survives restarts), ended (read-only; viewers keep access only if the owner allows it) and archived (owner and collaborators only).
- **Links:** `/live/<token>`: 43 random characters, stored only as a SHA-256 hash, sealed with the Edit Link key so the owner can copy it again, never logged (the application logs no URLs; Caddy drops URIs from its logs). Links can be replaced, revoked or given an expiry; affected viewers are disconnected at once.
- **Viewer access:** anyone with the link (read-only, no name asked), signed-in accounts with the link, or invited people only. Viewers never write: the server refuses changes over both REST and WebSocket.
- **Collaborators:** invited accounts edit with the owner.
- **Save to Workspace:** copies the session's files and their images into a workspace folder the person can edit (optionally a new or existing subfolder), without overwriting unless asked to replace, and records it in the workspace activity. A locked destination is refused to people locks restrict there; saved files can be locked at once. The session stays as it is.
- **Associated folder:** a session may be associated with a workspace folder; while that folder (or a parent) is locked, only the owner (and people allowed to open locked content) can open the session.

### Capacity settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_LIVE_SESSIONS` | 8 | sessions loaded in memory at once (idle ones are unloaded after 30 s) |
| `MAX_LIVE_VIEWERS` | 300 | viewers per session (the owner and collaborators are never refused) |

Workspace lessons keep their own limit (`MAX_ACTIVE_LESSONS`, 16).

Measured locally with `node scripts/live-load-test.mjs` (one instructor per session typing 5 changes a second, viewers joining through the link, 20% of them dropping and reconnecting halfway), against the production image limited to the production container's 1.5 CPUs and 512 MB:

| Load | Delivered | Delay p50 / p95 / p99 | Server memory (RSS) |
| --- | --- | --- | --- |
| 50 viewers | 100% | 7 / 12 / 26 ms | 92 MB |
| 100 viewers | 100% | 10 / 16 / 25 ms | 97 MB |
| 3 sessions × 50 viewers | 100% | 13 / 23 / 27 ms | 100 MB |
| 300 viewers, 10 changes a second | 100% | 23 / 54 / 67 ms | 109 MB (6–24% CPU) |

These were measured on a fast local machine (arm64, native), not on the 1 GB Lightsail server; they show the design's cost, not a guaranteed production capacity.

## Database

All changes are additive (new tables only; `IF NOT EXISTS`; safe to run again): `content_locks`, `lock_permissions`, `lock_events`, `live_sessions`, `live_session_members`, `live_images`, `live_image_chunks`, plus a trigger that removes a folder's lock with the folder. No existing table, index or trigger changes, and no existing row is modified.

**Reversal:** an older release ignores the new tables (verified with d4844ea). The data in them stays and is used again after rolling forward.

## Rollback (fail closed)

`scripts/rollback-release.sh` (on the server: `NEW_TAG=<this release> rollback-release.sh <mode>`):

| Mode | What it does |
| --- | --- |
| `--check` | read-only: locks in use, live sessions, rollback images present; says whether a backend rollback would be allowed |
| `--frontend` | Caddy only, back to the previous frontend; always safe (this backend keeps enforcing locks) |
| `--backend` | stops the application **first** (nothing is served or written from then on; the frontend shows a maintenance message), then reads the stopped database. No lock in use: starts the previous application and frontend. **Any lock, or a database it can't read: the rollback is blocked and the application stays stopped (maintenance)**; locked content is never served by a release that can't enforce it |
| `--maintenance` | stops the application on purpose |
| `--restore` | starts this lock-aware release again (leaves maintenance, or rolls forward) |

Rehearsed on representative data with the real images (no locks: rollback and roll-forward; locks: blocked, everything answers 502, the previous release never starts, nothing lost; frontend-only rollback keeps enforcement; unreadable database: blocked).
