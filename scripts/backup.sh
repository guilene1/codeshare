#!/usr/bin/env bash
set -euo pipefail
trap 'echo "$(date -u +%FT%TZ) ERROR: SQLite/S3 backup failed (exit $?)" >&2' ERR
# Run on the Ubuntu host from the project directory. AWS CLI must be installed.
: "${S3_BACKUP_BUCKET:?Export S3_BACKUP_BUCKET before running backups}"
: "${AWS_REGION:?Export AWS_REGION before running backups}"
command -v aws >/dev/null || { echo 'Install AWS CLI on the host first.' >&2; exit 1; }
task_backup_dir=$(mktemp -d)
trap 'rm -rf -- "$task_backup_dir"' EXIT
task_backup_name="devshare-$(date -u +%Y%m%dT%H%M%SZ).sqlite.gz"
docker compose exec -T application node scripts/snapshot.mjs > "$task_backup_dir/snapshot.sqlite"
gzip -c "$task_backup_dir/snapshot.sqlite" > "$task_backup_dir/$task_backup_name"
aws s3 cp "$task_backup_dir/$task_backup_name" "s3://$S3_BACKUP_BUCKET/${S3_BACKUP_PREFIX:-devshare}/$task_backup_name" --region "$AWS_REGION" --only-show-errors
echo "$(date -u +%FT%TZ) SUCCESS: Uploaded $task_backup_name"
