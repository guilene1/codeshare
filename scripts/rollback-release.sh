#!/usr/bin/env bash
# Fail-closed rollback for the content-locks release.
#
# Releases before content locks (acfbc5d, d4844ea and older) don't know locks exist: on a
# database with locks they would serve locked and hidden content to everyone its sharing allows.
# This script never lets that happen:
#
#   rollback-release.sh --check        read-only report: locks in use, whether a backend rollback
#                                      would be allowed, images present. Changes nothing.
#   rollback-release.sh --frontend     Caddy only, back to the previous frontend. Always safe:
#                                      the backend of this release keeps enforcing locks.
#   rollback-release.sh --backend      stops the application FIRST (from then on nothing is served
#                                      and nothing is written: the frontend shows a maintenance
#                                      message), then reads the stopped database:
#                                        - no locks in use: starts the previous application and
#                                          frontend (they then serve exactly what they always did);
#                                        - any lock, or the database can't be read: the rollback is
#                                          BLOCKED and the application STAYS STOPPED (maintenance)
#                                          until --restore brings the lock-aware release back.
#   rollback-release.sh --maintenance  stops the application (controlled maintenance), nothing else.
#   rollback-release.sh --restore      starts this (lock-aware) release again: leaves maintenance,
#                                      or rolls forward after a rollback.
#
# It never writes to the database, never deletes data and never restores a backup. The new
# tables stay in place; the previous release ignores them, and --restore uses them again.
# Exit codes: 0 done / allowed; 3 blocked, in maintenance (locks in use); 4 blocked, in
# maintenance (database unreadable or check failed); 5 blocked before any change (images missing
# or unexpected); 6 health check failed after a switch; 1 other error.
#
# Overridable (local tests): APP_DIR PROJECT IMG_APP IMG_CADDY NEW_TAG PREV_APP_TAG PREV_CADDY_TAG
# SUDO HEALTH_URL COMPOSE_ARGS APP_SERVICE CADDY_SERVICE HEALTH_SECONDS.
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/devshare}
PROJECT=${PROJECT:-devshare}
IMG_APP=${IMG_APP:-devshare-application}
IMG_CADDY=${IMG_CADDY:-devshare-caddy}
NEW_TAG=${NEW_TAG:?set NEW_TAG to this release tag (the lock-aware images)}
PREV_APP_TAG=${PREV_APP_TAG:-acfbc5d}
PREV_CADDY_TAG=${PREV_CADDY_TAG:-d4844ea}
SUDO=${SUDO-sudo}
HEALTH_URL=${HEALTH_URL:-https://kodelumi.com/api/health}
HEALTH_SECONDS=${HEALTH_SECONDS:-90}
COMPOSE_ARGS=${COMPOSE_ARGS:-}
APP_SERVICE=${APP_SERVICE:-application}
CADDY_SERVICE=${CADDY_SERVICE:-caddy}
APP_C="$PROJECT-$APP_SERVICE-1"
VOLUME="${PROJECT}_sqlite_data"
MODE=${1:-}

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
dc() { (cd "$APP_DIR" && $SUDO docker compose $COMPOSE_ARGS -p "$PROJECT" "$@"); }
case "$MODE" in --check|--frontend|--backend|--maintenance|--restore) ;; *) sed -n '2,32p' "$0"; exit 1 ;; esac

# One line: "<locks> <workspaces with locks> <live sessions>" (small tables only; read-only).
# A database from before this release has no lock table: 0 locks.
CHECK_JS='
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];
const has = (t) => one("SELECT COUNT(*) FROM sqlite_master WHERE type=? AND name=?", "table", t) === 1;
console.log(
  has("content_locks") ? one("SELECT COUNT(*) FROM content_locks") : 0,
  has("content_locks") ? one("SELECT COUNT(DISTINCT workspace_id) FROM content_locks") : 0,
  has("live_sessions") ? one("SELECT COUNT(*) FROM live_sessions") : 0,
);
db.close();'
running() { [ "$($SUDO docker inspect -f '{{.State.Running}}' "$APP_C" 2>/dev/null)" = true ]; }
# Reads the database: through the running application (small tables only), or from the stopped
# application's volume (mounted read-write so SQLite can read its WAL, opened read-only).
read_db() {
  if running; then
    $SUDO docker exec "$APP_C" node -e "$CHECK_JS" /data/devshare.sqlite
  else
    $SUDO docker volume inspect "$VOLUME" >/dev/null 2>&1 || return 1
    $SUDO docker run --rm --network none --user node -v "$VOLUME:/data" --entrypoint node \
      "$IMG_APP:$NEW_TAG" -e "$CHECK_JS" /data/devshare.sqlite
  fi
}
image_present() { $SUDO docker image inspect "$1" >/dev/null 2>&1; }
retag() { $SUDO docker tag "$1:$2" "$1:latest"; }
healthy() {
  for _ in $(seq 1 "$HEALTH_SECONDS"); do
    curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
restore() {
  log "starting the lock-aware release ($NEW_TAG)"
  retag "$IMG_APP" "$NEW_TAG"
  retag "$IMG_CADDY" "$NEW_TAG"
  dc up -d --no-deps --no-build "$APP_SERVICE" 2>&1 | sed 's/^/   /'
  dc up -d --no-deps --no-build "$CADDY_SERVICE" 2>&1 | sed 's/^/   /'
  if healthy; then log "OK: the lock-aware release is serving"; else log "FAILED: not healthy after ${HEALTH_SECONDS}s"; return 6; fi
}
maintenance() {
  log "MAINTENANCE: stopping the application (nothing is served or written until it is started again)"
  dc stop "$APP_SERVICE" 2>&1 | sed 's/^/   /'
  running && { log "the application is still running"; return 1; }
  return 0
}

for image in "$IMG_APP:$NEW_TAG" "$IMG_CADDY:$NEW_TAG"; do
  image_present "$image" || { log "BLOCKED: $image is missing (the lock-aware release must stay available)."; exit 5; }
done

case "$MODE" in
  --check)
    if ! out=$(read_db 2>/dev/null) || ! [[ "$out" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]]; then
      log "could not read the database: a backend rollback would be BLOCKED (fail closed)"; exit 4
    fi
    read -r locks workspaces sessions <<<"$out"
    log "locks in use: $locks (in $workspaces workspace(s)); live sessions: $sessions"
    for image in "$IMG_APP:$PREV_APP_TAG" "$IMG_CADDY:$PREV_CADDY_TAG"; do
      image_present "$image" && log "rollback image present: $image" || log "rollback image MISSING: $image"
    done
    if [ "$locks" -gt 0 ]; then
      log "backend rollback: BLOCKED (the previous release can't enforce locks; it would end in maintenance)"; exit 3
    fi
    log "backend rollback: allowed (no locks in use). Frontend rollback: always allowed."; exit 0 ;;
  --frontend)
    image_present "$IMG_CADDY:$PREV_CADDY_TAG" || { log "BLOCKED: $IMG_CADDY:$PREV_CADDY_TAG is missing."; exit 5; }
    log "frontend only: $IMG_CADDY -> $PREV_CADDY_TAG (the backend keeps enforcing locks)"
    retag "$IMG_CADDY" "$PREV_CADDY_TAG"
    dc up -d --no-deps --no-build "$CADDY_SERVICE" 2>&1 | sed 's/^/   /'
    healthy && { log "OK"; exit 0; }
    log "FAILED: not healthy; restoring the frontend of this release"
    retag "$IMG_CADDY" "$NEW_TAG"
    dc up -d --no-deps --no-build "$CADDY_SERVICE" 2>&1 | sed 's/^/   /'
    exit 6 ;;
  --maintenance)
    maintenance; log "in maintenance. Leave it with: $0 --restore"; exit 0 ;;
  --restore)
    restore; exit $? ;;
  --backend)
    for image in "$IMG_APP:$PREV_APP_TAG" "$IMG_CADDY:$PREV_CADDY_TAG"; do
      image_present "$image" || { log "BLOCKED before any change: $image is missing."; exit 5; }
    done
    # 1. Fail closed first: nothing is served or written while the database is checked.
    maintenance || { log "BLOCKED: could not stop the application; nothing else was changed."; exit 1; }
    # 2. The stopped database decides.
    if ! out=$(read_db 2>/dev/null) || ! [[ "$out" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]]; then
      log "BLOCKED: could not read the stopped database. STAYING IN MAINTENANCE (fail closed)."
      log "Investigate, then: $0 --restore"; exit 4
    fi
    read -r locks workspaces sessions <<<"$out"
    log "stopped database: $locks lock(s) in $workspaces workspace(s); $sessions live session(s)"
    if [ "$locks" -gt 0 ]; then
      log "BLOCKED: the previous release can't enforce locks, so it is NOT started. STAYING IN MAINTENANCE."
      log "Locked content is never exposed. Leave maintenance only with a lock-aware release: $0 --restore"
      exit 3
    fi
    # 3. No locks in use: the previous release serves exactly what it always did.
    log "no locks in use: starting the previous release (app $PREV_APP_TAG, frontend $PREV_CADDY_TAG)"
    [ "$sessions" -gt 0 ] && log "note: $sessions live session(s) are unavailable until the roll-forward (their data stays)."
    retag "$IMG_APP" "$PREV_APP_TAG"
    retag "$IMG_CADDY" "$PREV_CADDY_TAG"
    dc up -d --no-deps --no-build "$APP_SERVICE" 2>&1 | sed 's/^/   /'
    dc up -d --no-deps --no-build "$CADDY_SERVICE" 2>&1 | sed 's/^/   /'
    if healthy; then log "OK: rolled back. Roll forward later with: $0 --restore"; exit 0; fi
    log "FAILED: the previous release is not healthy; restoring the lock-aware release"
    restore || true
    exit 6 ;;
esac
