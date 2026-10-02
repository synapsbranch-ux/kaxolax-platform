#!/bin/sh
# Sauvegarde PostgreSQL quotidienne vers R2 (service cron Railway, deploy/railway/pg-backup.json).
#
# 1. Une transaction REPEATABLE READ exporte un instantané : le nombre de lignes des tables clés
#    et le dump (pg_dump --snapshot) voient exactement les mêmes données.
# 2. pg_dump au format custom (compressé), vérifié (pg_restore --list), puis chiffré avec age pour
#    une clé publique : le job ne détient jamais la clé privée, qui ne sert qu'à restaurer.
# 3. Envoi vers <bucket>/<BACKUP_PREFIX>/<AAAAMMJJTHHMMSSZ>/ : kaxolax.dump.age, puis manifest.txt
#    (sha256, taille, nombres de lignes), qui marque une sauvegarde complète. Jamais d'écrasement.
# 4. Rétention : suppression des sauvegardes de plus de BACKUP_RETENTION_DAYS jours, en gardant
#    toujours les BACKUP_MIN_KEEP plus récentes. Le cycle de vie du bucket (kaxolax-infra) reste
#    le filet de sécurité, et son verrou empêche toute suppression d'une sauvegarde récente.
#
# Variables : DATABASE_URL, AGE_RECIPIENT (clé publique age1…), BACKUP_S3_ENDPOINT,
# BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY ; facultatives :
# BACKUP_S3_REGION (auto), BACKUP_S3_PROVIDER (Cloudflare), BACKUP_PREFIX (postgres),
# BACKUP_RETENTION_DAYS (35), BACKUP_MIN_KEEP (7), BACKUP_KEY_TABLES, BACKUP_WORK_DIR.
set -eu

# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

require_env DATABASE_URL AGE_RECIPIENT
configure_rclone
retention_days="${BACKUP_RETENTION_DAYS:-35}"
min_keep="${BACKUP_MIN_KEEP:-7}"
if ! is_number "$retention_days" || ! is_number "$min_keep"; then fail "rétention invalide"; fi
[ "$min_keep" -ge 1 ] || fail "BACKUP_MIN_KEEP doit valoir au moins 1"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d "${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/pg-backup.XXXXXX")"
psql_pid=""
cleanup() {
  exec 3>&- 2>/dev/null || true
  if [ -n "$psql_pid" ]; then kill "$psql_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Attend une ligne exacte dans la sortie de la session psql (au plus 60 s).
wait_for_line() {
  i=0
  while [ "$i" -lt 600 ]; do
    grep -qx -- "$1" "$work/out" 2>/dev/null && return 0
    kill -0 "$psql_pid" 2>/dev/null || fail "session psql terminée : $(cat "$work/err")"
    sleep 0.1
    i=$((i + 1))
  done
  fail "pas de réponse de PostgreSQL"
}

# 1. Session qui garde l'instantané ouvert pendant le dump.
mkfifo "$work/in"
psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 <"$work/in" >"$work/out" 2>"$work/err" &
psql_pid=$!
exec 3>"$work/in"
{
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
  echo "SELECT 'snapshot=' || pg_export_snapshot();"
  count_query "${BACKUP_KEY_TABLES:-}"
  echo "SELECT 'end-of-counts';"
} >&3
wait_for_line "end-of-counts"
snapshot="$(sed -n 's/^snapshot=//p' "$work/out")"
[ -n "$snapshot" ] || fail "instantané introuvable"
grep -E '^[a-z0-9_]+\|[0-9]+$' "$work/out" >"$work/counts" || fail "aucune table clé trouvée"
log "instantané $snapshot, $(wc -l <"$work/counts" | tr -d ' ') tables comptées"

# 2. Dump compressé, vérifié, puis chiffré (fichiers locaux : sha256 et taille connus avant l'envoi).
pg_dump --dbname="$DATABASE_URL" --snapshot="$snapshot" --format=custom --compress=9 \
  --no-owner --no-acl --file="$work/kaxolax.dump"
echo "COMMIT;" >&3
exec 3>&-
wait "$psql_pid" || fail "fin de transaction en erreur : $(cat "$work/err")"
psql_pid=""
pg_restore --list "$work/kaxolax.dump" >/dev/null || fail "archive illisible"
age --encrypt --recipient "$AGE_RECIPIENT" --output "$work/kaxolax.dump.age" "$work/kaxolax.dump"
rm -f "$work/kaxolax.dump"

size="$(wc -c <"$work/kaxolax.dump.age" | tr -d ' ')"
server_version="$(psql "$DATABASE_URL" -X -A -t -c 'SHOW server_version' | tr -d ' ')"
{
  echo "format=kaxolax-pg-backup-v1"
  echo "created_at=$stamp"
  echo "server_version=$server_version"
  echo "dump=kaxolax.dump.age"
  echo "sha256=$(sha256_of "$work/kaxolax.dump.age")"
  echo "size_bytes=$size"
  sed 's/^\([^|]*\)|\(.*\)$/count.\1=\2/' "$work/counts"
} >"$work/manifest.txt"

# 3. Envoi ; --immutable refuse d'écraser un objet existant, copyto vérifie taille et empreinte.
rclone copyto --immutable "$work/kaxolax.dump.age" "$REMOTE/$stamp/kaxolax.dump.age"
rclone copyto --immutable "$work/manifest.txt" "$REMOTE/$stamp/manifest.txt"
log "sauvegarde envoyée : $REMOTE/$stamp ($size octets)"

# 4. Rétention (horodatages UTC, triables comme du texte).
cutoff="$(date -u -d "@$(($(date -u +%s) - retention_days * 86400))" +%Y%m%dT%H%M%SZ)"
rank=0
for backup in $(list_backups); do
  rank=$((rank + 1))
  [ "$rank" -gt "$min_keep" ] || continue
  if [ "$(printf '%s\n%s\n' "$backup" "$cutoff" | sort | head -n 1)" = "$backup" ] &&
    [ "$backup" != "$cutoff" ]; then
    if rclone purge "$REMOTE/$backup"; then
      log "sauvegarde expirée supprimée : $backup"
    else
      log "suppression refusée (verrou du bucket ?) : $backup"
    fi
  fi
done
