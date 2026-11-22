#!/bin/sh
# Nightly backup of the backend state volume (db.json, secret.key, mod/ ...) as a dated tarball, keeping 14 days.
# Runs on the Docker host from cron (see backup.cron). Writes are atomic in the backend (temp file + rename), so a
# tar taken while it runs sees either the old or the new copy of each file, never half of one.
#   OGSOS_BACKUP_DIR   where tarballs go (default /var/backups/ogsos), created mode 700: it holds secrets
#   OGSOS_STATE_VOLUME docker volume name (default ogsos_state)
#   OGSOS_BACKUP_DAYS  days to keep (default 14)
# Restore: see docs/SECURITY.md (stop the backend, untar into the volume, start it).
set -eu
DIR="${OGSOS_BACKUP_DIR:-/var/backups/ogsos}"
VOL="${OGSOS_STATE_VOLUME:-ogsos_state}"
DAYS="${OGSOS_BACKUP_DAYS:-14}"
SRC="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
OUT="$DIR/ogsos-state-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$OUT.part" -C "$SRC" .
mv "$OUT.part" "$OUT"
tar -tzf "$OUT" > /dev/null   # readable archive or the job fails loudly
find "$DIR" -maxdepth 1 -name 'ogsos-state-*.tar.gz' -mtime +"$((DAYS - 1))" -delete
find "$DIR" -maxdepth 1 -name 'ogsos-state-*.part' -delete
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
