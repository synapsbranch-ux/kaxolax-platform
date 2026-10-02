#!/bin/sh
# Test de restauration d'une sauvegarde de pg-backup.sh dans une base temporaire.
#
#   pg-restore-test.sh [AAAAMMJJTHHMMSSZ]   (défaut : la plus récente qui a un manifeste)
#
# Télécharge le dump chiffré et son manifeste, vérifie le sha256, déchiffre (clé privée age),
# restaure dans une base neuve kaxolax_restore_<horodatage> du serveur RESTORE_ADMIN_URL, puis
# compare le nombre de lignes des tables clés au manifeste (même instantané que le dump : égalité
# exacte). Échoue aussi si la sauvegarde a plus de BACKUP_MAX_AGE_HOURS heures. La base temporaire
# est supprimée à la fin (sauf KEEP_RESTORE_DB=1).
#
# Variables : RESTORE_ADMIN_URL (postgres://…/postgres, droit CREATEDB ; un serveur de test, pas
# la production), AGE_IDENTITY (clé privée AGE-SECRET-KEY-…) ou AGE_IDENTITY_FILE, BACKUP_S3_*
# comme pg-backup.sh ; facultatives : BACKUP_PREFIX, BACKUP_MAX_AGE_HOURS (26), BACKUP_WORK_DIR,
# KEEP_RESTORE_DB.
set -eu

# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

require_env RESTORE_ADMIN_URL
configure_rclone
[ -n "${AGE_IDENTITY:-}${AGE_IDENTITY_FILE:-}" ] || fail "AGE_IDENTITY ou AGE_IDENTITY_FILE requise"
if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" = "$RESTORE_ADMIN_URL" ]; then
  fail "RESTORE_ADMIN_URL est la base de production"
fi
max_age_hours="${BACKUP_MAX_AGE_HOURS:-26}"
is_number "$max_age_hours" || fail "BACKUP_MAX_AGE_HOURS invalide"

work="$(mktemp -d "${BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}/pg-restore.XXXXXX")"
database=""
admin() {
  psql "$RESTORE_ADMIN_URL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"
}
cleanup() {
  if [ -n "$database" ] && [ "${KEEP_RESTORE_DB:-0}" != "1" ]; then
    admin -c "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" >/dev/null 2>&1 ||
      log "base $database non supprimée"
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

stamp="${1:-}"
if [ -z "$stamp" ]; then
  # Une sauvegarde interrompue n'a pas de manifeste : elle est ignorée.
  for candidate in $(list_backups); do
    if rclone lsf "$REMOTE/$candidate/manifest.txt" 2>/dev/null | grep -qx manifest.txt; then
      stamp="$candidate"
      break
    fi
  done
fi
case "$stamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) fail "aucune sauvegarde trouvée dans $REMOTE" ;;
esac
log "restauration de $REMOTE/$stamp"

rclone copyto "$REMOTE/$stamp/manifest.txt" "$work/manifest.txt"
rclone copyto "$REMOTE/$stamp/kaxolax.dump.age" "$work/kaxolax.dump.age"
manifest() {
  sed -n "s/^$1=//p" "$work/manifest.txt"
}
[ "$(manifest format)" = "kaxolax-pg-backup-v1" ] || fail "manifeste inconnu"
[ "$(sha256_of "$work/kaxolax.dump.age")" = "$(manifest sha256)" ] || fail "sha256 différent du manifeste"

identity="${AGE_IDENTITY_FILE:-$work/identity}"
if [ -z "${AGE_IDENTITY_FILE:-}" ]; then
  (umask 077 && printf '%s\n' "$AGE_IDENTITY" >"$identity")
fi
age --decrypt --identity "$identity" --output "$work/kaxolax.dump" "$work/kaxolax.dump.age"
rm -f "$work/identity" "$work/kaxolax.dump.age"

# Base temporaire : même serveur, autre nom de base (paramètres de connexion conservés).
database="kaxolax_restore_$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')"
base="${RESTORE_ADMIN_URL%%\?*}"
query="${RESTORE_ADMIN_URL#"$base"}"
case "$base" in
  postgres://*/* | postgresql://*/*) ;;
  *) fail "RESTORE_ADMIN_URL doit être de la forme postgres://…/<base>" ;;
esac
target_url="${base%/*}/$database$query"

admin -c "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" >/dev/null 2>&1
admin -c "CREATE DATABASE \"$database\"" >/dev/null
pg_restore --dbname="$target_url" --no-owner --no-acl --exit-on-error "$work/kaxolax.dump"
log "dump restauré dans $database"

# Nombre de lignes des tables clés, comparé au manifeste.
tables="$(sed -n 's/^count\.\([a-z0-9_]*\)=.*/\1/p' "$work/manifest.txt" | tr '\n' ' ')"
[ -n "$tables" ] || fail "aucune table clé dans le manifeste"
psql "$target_url" -X -q -A -t -v ON_ERROR_STOP=1 -c "$(count_query "$tables")" >"$work/restored"
failures=0
for table in $tables; do
  expected="$(manifest "count\\.$table")"
  restored="$(sed -n "s/^$table|//p" "$work/restored")"
  if [ "$restored" = "$expected" ]; then
    log "OK $table : $restored lignes"
  else
    log "ÉCART $table : attendu $expected, restauré ${restored:-table absente}"
    failures=$((failures + 1))
  fi
done
[ "$failures" -eq 0 ] || fail "$failures table(s) en écart"

# Âge de la sauvegarde, d'après son horodatage.
day="$(printf '%s' "$stamp" | cut -c 1-8)"
time="$(printf '%s' "$stamp" | cut -c 10-15)"
taken="$(date -u -d "$(printf '%s-%s-%s %s:%s:%s' \
  "$(printf '%s' "$day" | cut -c 1-4)" "$(printf '%s' "$day" | cut -c 5-6)" \
  "$(printf '%s' "$day" | cut -c 7-8)" "$(printf '%s' "$time" | cut -c 1-2)" \
  "$(printf '%s' "$time" | cut -c 3-4)" "$(printf '%s' "$time" | cut -c 5-6)")" +%s)"
age_hours=$((($(date -u +%s) - taken) / 3600))
if [ "$age_hours" -gt "$max_age_hours" ]; then
  fail "sauvegarde trop ancienne (${age_hours} h > ${max_age_hours} h)"
fi
log "test de restauration réussi ($stamp, ${age_hours} h, PostgreSQL $(manifest server_version))"
