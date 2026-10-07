# Production deployment (AWS Lightsail)

DevShare v1 runs at **https://devshare.gamela.shop** on one small server:

| Component | Production setting |
|---|---|
| Host | AWS Lightsail `devshare`, us-east-1a, Ubuntu 24.04 LTS, x86_64, `micro_3_0` bundle (2 vCPU, 1 GB RAM, 40 GB SSD), 2 GB swap file |
| Address | Static IP `codeshare-static-ip` = 52.206.92.51; Route 53 `A` record `devshare.gamela.shop` → that IP |
| Runtime | Docker Engine + Compose plugin, project directory `/opt/devshare` (Compose project `devshare`) |
| Web | Caddy (`devshare-caddy` image): HTTPS via Let's Encrypt, static React build, proxies only `/api` and `/ws/*` to Node |
| Application | Node.js (`devshare-application` image): REST, WebSocket/Yjs, SQLite; 512 MiB container cap, 384 MiB V8 heap |
| Data | SQLite at `/data/devshare.sqlite` on the named volume `devshare_sqlite_data`; Caddy certificates on `devshare_caddy_data` |
| Backups | Daily consistent snapshot → gzip → private S3 bucket `devshare-backups-885684264653`, 30-day retention |

```
Internet ── HTTPS ── Caddy ──┬── React static files
                             └── Node API/WebSocket ── SQLite (persistent volume)
```

> [!WARNING]
> **Never run `docker compose down -v`** unless you intend to permanently destroy production data. It deletes the SQLite volume and the TLS certificates. Plain `docker compose down`, `restart` and `up` preserve volumes.

> [!WARNING]
> **Do not build images on the 1 GB production server during normal deployments.** The Vite/Monaco frontend build needs about 1.5 GB; on this host it thrashes swap for a very long time and consumes CPU burst credits. Build off-server and transfer the images (section 3).

## 1. Network and firewall

Lightsail firewall (IPv4 and IPv6):

| Port | Source | Purpose |
|---|---|---|
| 22/TCP | Operator IP `/32` plus the `lightsail-connect` alias (browser SSH) | Administration |
| 80/TCP | Anywhere | ACME HTTP challenge and redirect to HTTPS |
| 443/TCP | Anywhere | HTTPS and WSS |

Port 3000 (Node), 2019 (Caddy admin) and SQLite are never exposed; Compose publishes only Caddy's 80/443. If the operator IP changes, update the SSH rule in the Lightsail console (Networking tab) or use browser SSH. Add an AAAA record only if IPv6 serving is wanted.

## 2. First-time server setup

Only needed when building a new server. Connect as `ubuntu` with the operator SSH key.

```sh
# 2 GB swap (survives reboot); low swappiness keeps the app in RAM
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-devshare-swap.conf && sudo sysctl -p /etc/sysctl.d/99-devshare-swap.conf

# Git, Docker Engine and Compose from Docker's official repository
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

# Code and server-only configuration
sudo install -d -o ubuntu -g ubuntu /opt/devshare
git clone --branch main https://github.com/guilene1/codeshare.git /opt/devshare
cd /opt/devshare
umask 077
cat > .env <<EOF
DOMAIN=devshare.gamela.shop
ACME_EMAIL=guilene.tiako@utrains.org
METRICS_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 .env
sudo docker compose config --quiet
```

`.env` exists only on the server and is ignored by Git. Compose supplies the database path, allowed origin, proxy trust and Node memory limits. Then load images built off-server (section 3, steps 2–3) and start with `sudo docker compose up -d --no-build`. Caddy obtains the certificate automatically once DNS points at the static IP and ports 80/443 are open.

Docker starts at boot and both services use `restart: unless-stopped`, so the stack returns automatically after a reboot.

## 3. Update workflow (build off-server)

The Dockerfile's build stage uses `FROM --platform=$BUILDPLATFORM`: TypeScript/Vite run natively on the build machine (the output is platform-independent), while the `application` and `web` stages target the server's `linux/amd64`. This works from x86_64 and ARM64 workstations with Docker Buildx.

**1. Prepare the code locally.** Pull or change code, run the checks, then commit and push so the server can pull the same commit:

```sh
git pull
npm ci
npm run typecheck && npm run build && npm test
git push origin main
git log -1 --oneline          # note the commit you are deploying
```

**2. Build the linux/amd64 production images locally** from a clean working tree at that commit (repository root):

```sh
docker buildx build --platform linux/amd64 --target application -t devshare-application:latest --load .
docker buildx build --platform linux/amd64 --target web         -t devshare-caddy:latest       --load .
docker image inspect devshare-application:latest devshare-caddy:latest --format '{{index .RepoTags 0}} {{.Architecture}}'   # both amd64
```

The image names must stay `devshare-application` and `devshare-caddy`; they are what Compose project `devshare` on the server expects.

**3. Take a backup and keep the current images for rollback**, then transfer the new images over SSH (encrypted; nothing goes through a registry):

```sh
ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51 '
  sudo /opt/devshare-backup/devshare-backup.sh && sudo tail -1 /var/log/devshare-backup.log
  sudo docker tag devshare-application:latest devshare-application:previous
  sudo docker tag devshare-caddy:latest devshare-caddy:previous
  git -C /opt/devshare rev-parse HEAD | tee /tmp/devshare-previous-commit'

docker save devshare-application:latest devshare-caddy:latest | gzip -1 \
  | ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51 'gunzip | sudo docker load'
```

**4. Update the code on the server** (Compose and the Caddyfile are read from the checkout):

```sh
ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51
cd /opt/devshare
git pull --ff-only origin main
git log -1 --oneline          # must match the commit the images were built from
git status --short            # must be empty
```

**5. Start the new images without building:**

```sh
sudo docker compose config --quiet
sudo docker compose up -d --no-build
```

Only containers whose image or configuration changed are recreated; volumes are untouched. If only the Caddyfile changed, `sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` applies it without a restart.

**6. Verify:**

```sh
sudo docker compose ps                                  # application "healthy", caddy "Up"
curl -fsS https://devshare.gamela.shop/api/health       # {"status":"ok"}
sudo docker compose logs --tail=100
sudo docker inspect devshare-application-1 --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
```

Then open the site, open an existing workspace, and check that a Student Link shows live instructor edits in View Only mode.

When the release is confirmed, reclaim space from replaced images with `sudo docker image prune -f` (removes only dangling images; volumes are never touched). Keep the `:previous` tags until the next release.

### Rollback

```sh
cd /opt/devshare
sudo docker tag devshare-application:previous devshare-application:latest
sudo docker tag devshare-caddy:previous devshare-caddy:latest
git checkout "$(cat /tmp/devshare-previous-commit)"     # or the commit you noted; detached HEAD
sudo docker compose up -d --no-build
sudo docker compose ps && curl -fsS https://devshare.gamela.shop/api/health
```

Return to the branch with `git checkout main` once a fixed release is ready.

- Roll back images **and** the checkout together, so the Caddyfile and Compose settings match the images.
- SQLite migrations are additive (new tables/columns only), so earlier code normally runs against a newer database. If a release ever ships a non-additive migration, restore the pre-deploy backup (section 5) instead of only rolling back images.
- A rollback never requires deleting volumes.

## 4. Backup system

| Item | Setting |
|---|---|
| Snapshot | The repository's `scripts/snapshot.mjs`, run inside the running application container. It uses SQLite's online backup API (includes committed WAL pages); the live database file is never copied, and DevShare is never stopped or restarted |
| Checks before upload | SQLite file header, `gzip -t`, SHA-256 recorded |
| Destination | `s3://devshare-backups-885684264653/daily/YYYY/MM/DD/devshare-YYYYMMDD-HHMMSS.sqlite.gz` (UTC); the object's metadata holds `sha256` and `raw-bytes` |
| Bucket | us-east-1; Block Public Access fully on; ACLs disabled (bucket owner enforced); SSE-S3 (AES256) default encryption; versioning on; bucket policy denies non-TLS requests |
| Retention | Lifecycle: `daily/` objects expire after 30 days; non-current versions after 7 days; expired delete markers and incomplete uploads cleaned up |
| Schedule | systemd `devshare-backup.timer`, daily at 03:00 UTC (up to 5 minutes random delay), `Persistent=true` so a missed run happens after downtime |
| Script | `/opt/devshare-backup/devshare-backup.sh` (root-owned, mode 700, not in Git; see appendix) |
| Credentials | IAM user `devshare-backup-writer`; key in `/opt/devshare-backup/aws-credentials` (root, mode 600) |
| Log | `/var/log/devshare-backup.log` (mode 600), rotated by `/etc/logrotate.d/devshare-backup` |

**Server permissions are write-only.** Lightsail instances cannot use IAM instance roles, so the server holds one long-lived access key. Its only permission is:

```json
{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::devshare-backups-885684264653/daily/*"}
```

The server cannot list, read or delete backups or touch any other AWS resource; a leaked key could only add objects under `daily/`. Downloads and restores therefore use an operator identity on a workstation. Never put AWS credentials in Git, `.env`, Docker images or source code.

**Failure behaviour.** A failed run logs `FAILURE` and exits. It never restarts DevShare, never modifies the database or volume, and never deletes earlier backups (new timestamped keys only). A lock prevents overlapping runs and each step has a timeout. There is no alerting: check the log periodically (section 6).

**Rotate the backup access key periodically** (at least yearly, and immediately if the server may be compromised), from an operator workstation:

```sh
aws iam list-access-keys --user-name devshare-backup-writer          # note the old key ID
aws iam create-access-key --user-name devshare-backup-writer --output json \
  | ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51 'sudo python3 -c "
import json,sys,os
k=json.load(sys.stdin)[\"AccessKey\"]; os.umask(0o077)
open(\"/opt/devshare-backup/aws-credentials\",\"w\").write(\"[devshare-backup]\naws_access_key_id = %s\naws_secret_access_key = %s\n\" % (k[\"AccessKeyId\"],k[\"SecretAccessKey\"]))
print(\"stored key ending\", k[\"AccessKeyId\"][-4:])"'
ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51 'sudo systemctl start devshare-backup.service; sudo tail -1 /var/log/devshare-backup.log'   # must be SUCCESS
aws iam delete-access-key --user-name devshare-backup-writer --access-key-id OLD_KEY_ID
```

The secret goes straight from IAM to the root-only file and is never displayed.

**Verify a backup (integrity and restore test).** Run periodically, and always before relying on a backup. Use an operator AWS identity and a temporary directory; this never touches production:

```sh
aws s3 ls s3://devshare-backups-885684264653/daily/ --recursive | sort | tail -3
KEY=daily/YYYY/MM/DD/devshare-YYYYMMDD-HHMMSS.sqlite.gz
aws s3api head-object --bucket devshare-backups-885684264653 --key "$KEY" \
  --query '{size:ContentLength,sse:ServerSideEncryption,sha256:Metadata.sha256}'
tmp=$(mktemp -d)
aws s3 cp "s3://devshare-backups-885684264653/$KEY" "$tmp/backup.sqlite.gz"
sha256sum "$tmp/backup.sqlite.gz"                       # equals the sha256 metadata
gzip -t "$tmp/backup.sqlite.gz" && gzip -dc "$tmp/backup.sqlite.gz" > "$tmp/restored.sqlite"
sqlite3 "$tmp/restored.sqlite" "PRAGMA integrity_check;"   # expected: ok
sqlite3 "$tmp/restored.sqlite" ".tables"                   # activity code_blocks documents folders rooms
rm -rf "$tmp"
```

Without the `sqlite3` CLI, use Python's built-in module:

```sh
python -c "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('PRAGMA integrity_check').fetchone()[0]); print(sorted(r[0] for r in db.execute(\"select name from sqlite_master where type='table'\")))" "$tmp/restored.sqlite"
```

`scripts/backup.sh` remains in the repository as a simpler manual alternative (it uses the same snapshot script but a different object name and no size logging); production uses the systemd timer above.

## 5. Emergency restore

**Restore the database on the existing server** during a maintenance window. Download and verify the backup on a workstation (section 4), then:

```sh
scp -i ~/.ssh/devshare_lightsail restored.sqlite ubuntu@52.206.92.51:/tmp/devshare-restore.sqlite
ssh -i ~/.ssh/devshare_lightsail ubuntu@52.206.92.51
cd /opt/devshare
sudo /opt/devshare-backup/devshare-backup.sh          # last backup of the current state
sudo docker compose stop application                 # Caddy stays up; volume untouched
sudo docker compose run --rm --no-deps -u root -v /tmp/devshare-restore.sqlite:/restore.sqlite:ro application sh -c '
  set -e; d=/data/pre-restore-$(date -u +%Y%m%d-%H%M%S); mkdir "$d"
  cp -a /data/devshare.sqlite* "$d"/
  rm -f /data/devshare.sqlite-wal /data/devshare.sqlite-shm
  cp /restore.sqlite /data/devshare.sqlite && chown node:node /data/devshare.sqlite'
sudo docker compose up -d application
sudo docker compose ps && curl -fsS https://devshare.gamela.shop/api/health
rm /tmp/devshare-restore.sqlite
```

Open a known workspace to confirm its content. The replaced database stays in `/data/pre-restore-<timestamp>/` inside the volume. Editor links continue to work because the snapshot preserves their hashes; restoring an older backup can re-enable a link rotated after that backup, so rotate again with `scripts/recover-editor.mjs --rotate` if needed.

**If the server is lost:** create a new `micro_3_0` Ubuntu 24.04 instance in us-east-1, reattach the static IP `codeshare-static-ip` (DNS then needs no change), apply the firewall from section 1, follow section 2, load images built off-server (section 3), restore the database as above, and re-create the backup script, credentials and timer (section 4 and appendix; create a fresh access key).

## 6. Operations

Run from `/opt/devshare` on the server.

```sh
# Health
sudo docker compose ps
curl -fsS https://devshare.gamela.shop/api/health

# Resources
sudo docker stats --no-stream
free -h
df -h

# Application logs
sudo docker compose logs --tail=100

# Backup status
systemctl status devshare-backup.service
systemctl status devshare-backup.timer
systemctl list-timers devshare-backup.timer

# Backup log (one SUCCESS/FAILURE line per run)
sudo tail /var/log/devshare-backup.log

# Run a backup now
sudo systemctl start devshare-backup.service
```

Routine notes:

- **Restarts:** `sudo docker compose restart application` (or `caddy`) preserves data; open sessions reconnect automatically.
- **Disk:** after releases, `sudo docker image prune -f` and `sudo docker builder prune -f` reclaim image/build space. Never use `docker system prune --volumes` or `docker volume prune`.
- **Caddy logs** omit request URIs and headers, because editor links carry credentials; access logging is disabled.
- **Metrics:** `GET /api/metrics` requires `Authorization: Bearer <METRICS_TOKEN>` from the server's `.env`; it returns 404 otherwise.
- **OS updates:** apply Ubuntu security updates regularly and reboot in a quiet period; Docker and both containers return automatically.
- **Capacity:** see [LOAD_TEST.md](LOAD_TEST.md). There is no fixed viewer cap; watch Node memory against its 512 MiB limit, swap growth and the restart count.

## Appendix: backup script and units

`/opt/devshare-backup/devshare-backup.sh` (root:root, mode 700). `/opt/devshare-backup` is mode 700 and also holds `aws-credentials` and `aws-config` (both mode 600; the config contains `[profile devshare-backup]` with `region = us-east-1`). Run `sudo /opt/devshare-backup/devshare-backup.sh --dry-run` to snapshot and compress without uploading.

```bash
#!/usr/bin/env bash
# DevShare daily SQLite backup -> private S3 bucket.
# Installed at /opt/devshare-backup/devshare-backup.sh (root-owned, not in Git).
# Uses the repository's scripts/snapshot.mjs (SQLite online backup API) inside the
# running application container, so the live database is never copied directly and
# DevShare is never stopped or restarted. Uploads only the compressed database.
set -Eeuo pipefail
umask 077

APP_DIR=/opt/devshare
BUCKET=devshare-backups-885684264653
REGION=us-east-1
LOG=/var/log/devshare-backup.log
export AWS_PROFILE=devshare-backup
export AWS_SHARED_CREDENTIALS_FILE=/opt/devshare-backup/aws-credentials
export AWS_CONFIG_FILE=/opt/devshare-backup/aws-config
export AWS_PAGER=""
DRY_RUN=${1:-}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

# One backup at a time.
exec 9>/run/devshare-backup.lock
flock -n 9 || { log "SKIP: another backup is already running"; exit 0; }

work=$(mktemp -d /var/tmp/devshare-backup.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
trap 'log "FAILURE: backup failed at line $LINENO (exit $?); production untouched, previous backups kept"; exit 1' ERR

stamp=$(date -u +%Y%m%d-%H%M%S)
key="daily/$(date -u +%Y/%m/%d)/devshare-$stamp.sqlite.gz"

# 1. Consistent snapshot (read-only; the app keeps running).
cd "$APP_DIR"
timeout 300 docker compose exec -T application node scripts/snapshot.mjs >"$work/snapshot.sqlite"

# 2. Sanity-check the snapshot before uploading anything.
[ "$(head -c 16 "$work/snapshot.sqlite" | tr -d '\0')" = "SQLite format 3" ] || { log "FAILURE: snapshot is not a SQLite database"; exit 1; }
raw_size=$(stat -c %s "$work/snapshot.sqlite")

# 3. Compress and verify the archive.
gzip -9 -c "$work/snapshot.sqlite" >"$work/backup.sqlite.gz"
gzip -t "$work/backup.sqlite.gz"
gz_size=$(stat -c %s "$work/backup.sqlite.gz")
sha=$(sha256sum "$work/backup.sqlite.gz" | cut -d' ' -f1)

if [ "$DRY_RUN" = "--dry-run" ]; then
  log "DRY-RUN OK: would upload s3://$BUCKET/$key raw=${raw_size}B gz=${gz_size}B sha256=$sha"
  exit 0
fi

# 4. Upload (new timestamped key; never overwrites or deletes earlier backups).
timeout 300 aws s3 cp "$work/backup.sqlite.gz" "s3://$BUCKET/$key" \
  --region "$REGION" --only-show-errors \
  --content-type application/gzip --metadata "sha256=$sha,raw-bytes=$raw_size"

log "SUCCESS: s3://$BUCKET/$key raw=${raw_size}B gz=${gz_size}B sha256=$sha"
```

`/etc/systemd/system/devshare-backup.service`:

```ini
[Unit]
Description=DevShare SQLite backup to S3
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/opt/devshare-backup/devshare-backup.sh
Nice=10
IOSchedulingClass=idle
```

`/etc/systemd/system/devshare-backup.timer` (enable with `sudo systemctl daemon-reload && sudo systemctl enable --now devshare-backup.timer`):

```ini
[Unit]
Description=Daily DevShare SQLite backup at 03:00 UTC

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

`/etc/logrotate.d/devshare-backup`:

```
/var/log/devshare-backup.log {
    monthly
    rotate 6
    size 256k
    compress
    missingok
    notifempty
    create 0600 root root
    su root syslog
}
```

The AWS CLI v2 is installed on the host from AWS's official installer (`https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip`).
