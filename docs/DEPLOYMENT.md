# Ubuntu / AWS Lightsail deployment

The target is the Linux/public-IPv4 **$7/month, 2 vCPU, 1 GB RAM, 40 GB disk** bundle in [AWS’s bundle table](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html). Domain registration, S3, transfer overages and taxes are separate. Confirm current pricing for your region before creating an instance.

## 1. Instance and network

Create an Ubuntu LTS instance, attach a static IPv4 address and point an A record such as `code.example.com` at it. Add AAAA only with working IPv6. Allow TCP 80/443 in the Lightsail firewall; UDP 443 is optional for HTTP/3. Restrict SSH to your operator IP. Never expose 3000 or SQLite. If enabling UFW, allow SSH before enabling the firewall.

Install Docker using its [official Ubuntu repository procedure](https://docs.docker.com/engine/install/ubuntu/). This includes Engine, Buildx and Compose:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

Use `sudo docker` unless a trusted operator is in the Docker group (which grants root-equivalent privileges). Commands below assume your operator has Docker access.

## 2. Copy the project and configure

Copy the repository to `/opt/devshare`, then:

```sh
cd /opt/devshare
cp .env.example .env
chmod 600 .env
nano .env
```

Set `DOMAIN=code.example.com` without scheme or path and `ACME_EMAIL=you@example.com`. Optionally generate an operator metric secret with `openssl rand -hex 32` and set `METRICS_TOKEN` to that value. Do not commit `.env`. Compose supplies the database path, production origin and Node memory ceiling; S3 variables are not required for application startup.

## 3. Build and start

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl --fail https://code.example.com/api/health
docker compose logs --tail=50 application caddy
```

The Node image contains compiled backend code and production backend dependencies. The Caddy image contains compiled React assets and workers. Caddy serves `/assets/*` with immutable caching and HTML with no-cache; missing assets return 404. Caddy handles HTTPS and proxies only `/api/*` and `/ws/*` to Node. There is no Vite dev server in production. SQLite and Caddy certificate/config state use named volumes. Application runs unprivileged, with a 512 MiB container cap and 384 MiB V8 heap cap; Caddy has a 128 MiB cap. These bounds leave space for Ubuntu/Docker and are not a measured Lightsail capacity guarantee.

Builds need more peak RAM than steady-state serving. Prefer building both images on another Linux machine/CI and transferring them:

```sh
# On the build machine, with this same Compose project name/config:
docker compose -p devshare build
docker save -o devshare-images.tar devshare-application devshare-caddy
scp devshare-images.tar ubuntu@YOUR_STATIC_IP:/tmp/

# On Lightsail:
docker load -i /tmp/devshare-images.tar
cd /opt/devshare
docker compose -p devshare up -d --no-build
```

If building on the 1 GB server, monitor RAM and provide temporary swap rather than risking an OOM during compilation. Do not count swap as classroom capacity. A prebuilt image avoids running Node/Vite compilation on the production instance.

Open the HTTPS hostname in an instructor browser, create a course, create a lesson and share its student link with an incognito browser. Verify live read-only updates and test a restart:

```sh
docker compose restart application
```

Reopen the same link and confirm the marker, folder, files and snippets. `restart: unless-stopped` and enabled Docker restore services after reboot; named volumes preserve SQLite. Test an actual reboot during an agreed maintenance window. Caddy’s runtime logging filter omits request details, preventing private editor routes/headers appearing in logs; access logging remains disabled ([Caddy filter documentation](https://caddyserver.com/docs/caddyfile/directives/log#filter)).

## 4. Update safely

Back up first, copy the updated code and preserve `.env` and volumes, then:

```sh
docker compose up -d --build
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose ps
```

Use transferred prebuilt images and `up -d --no-build` on the small host when practical. SQLite migrations are additive. Course data never expires; inactive lesson eviction affects RAM only. `docker compose down` preserves volumes, while **`docker compose down -v` permanently deletes them**.

## 5. Optional daily S3 backup

The app works without S3 or AWS credentials. Install AWS CLI on the Ubuntu **host** following [AWS’s CLI installation guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). Configure a private encrypted bucket with Block Public Access and a host CLI profile limited to `s3:PutObject` under your backup prefix; use a separate restore identity for reads if desired. Configure bucket lifecycle to bound backup storage charges. Never put AWS credentials in frontend code, Docker images or source control.

```sh
export S3_BACKUP_BUCKET=your-private-backup-bucket
export S3_BACKUP_PREFIX=devshare
export AWS_REGION=us-east-1
export AWS_PROFILE=devshare-backup
cd /opt/devshare
bash scripts/backup.sh
```

The script uses Node’s SQLite online backup API, including committed WAL pages, creates a consistent snapshot, gzips it and uploads a UTC timestamped object. It never copies a live WAL database file directly. Temporary files are removed on exit; success/failure is logged. Snapshots include workspaces, folders, lesson states, files, snippets and token hashes. A backup covers committed checkpoints; wait for persistence before an operator-requested snapshot.

Create a host configuration and daily wrapper (adjust paths/profile):

```sh
sudo install -d -m 700 /opt/devshare-backup
sudo nano /opt/devshare-backup/env
# Store the export lines above in this file.
sudo chmod 600 /opt/devshare-backup/env
sudo nano /opt/devshare-backup/run.sh
```

Wrapper content:

```sh
#!/usr/bin/env bash
set -euo pipefail
source /opt/devshare-backup/env
cd /opt/devshare
bash scripts/backup.sh
```

Use an operator account that can access Docker/AWS configuration, set the wrapper executable, and schedule with that account’s `crontab -e`:

```cron
15 3 * * * /opt/devshare-backup/run.sh >> /opt/devshare-backup/backup.log 2>&1
```

This runs daily at 03:15 in the host timezone. Rotate/monitor the log and alert on missing successes or failures. Test a real upload with your credentials and a restore before relying on it. No actual AWS upload can be verified without your bucket and credentials.

## 6. Restore during maintenance

Download the chosen timestamped backup with AWS CLI and decompress it. Stop writers before replacing database files; keep a copy of the current database. The replacement below is an intentional restore, not a routine update:

```sh
aws s3 cp s3://YOUR_BUCKET/devshare/CHOSEN_BACKUP.sqlite.gz /tmp/devshare-restore.sqlite.gz --region YOUR_REGION
gzip -dc /tmp/devshare-restore.sqlite.gz > /tmp/devshare-restore.sqlite
docker compose stop application
docker compose run --rm --no-deps -u root -v /tmp/devshare-restore.sqlite:/restore.sqlite:ro application sh -c 'cp /data/devshare.sqlite /data/pre-restore.sqlite; rm -f /data/devshare.sqlite-wal /data/devshare.sqlite-shm; cp /restore.sqlite /data/devshare.sqlite; chown node:node /data/devshare.sqlite'
docker compose up -d application
```

Before replacing data, inspect the snapshot with SQLite `PRAGMA integrity_check` (or Node’s SQLite API) and retain the original backup. Validate a known course/lesson and private editor access after restore. Original editor links continue to work because the snapshot preserves their hashes. Restoring an older backup may re-enable a previously rotated link; rotate again when needed.

## 7. Operate within the small-server target

Run the [50-viewer load test](LOAD_TEST.md) from a separate machine while monitoring host/container metrics. Keep OS security updates enabled, restrict operator credentials, monitor disk growth and test restores periodically. Domain/DNS and AWS upload checks depend on your live configuration; the local Docker preview cannot establish that public HTTPS and S3 permissions are correct.
