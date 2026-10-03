#!/usr/bin/env bash
# Test de bout en bout des sauvegardes sur la pile locale (docker compose : PostgreSQL et S3
# SeaweedFS) : image construite, base de test, sauvegarde, rétention, restauration vérifiée, puis
# détection d'un écart. Lancé par la CI (job « backup ») ; aucune donnée existante n'est touchée.
#
#   scripts/backup/test-local.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
image=kaxolax-pg-backup:test
dockerfile=scripts/backup/Dockerfile
# Empreintes des binaires de chaque architecture (étapes downloads-<arch>) : rien n'est exécuté,
# aucune émulation n'est nécessaire.
sed -n 's/^FROM scratch AS downloads-\([a-z0-9]*\)$/\1/p' "$dockerfile" | while read -r arch; do
  docker build -q --platform "linux/$arch" --target "downloads-$arch" --output type=cacheonly \
    -f "$dockerfile" . >/dev/null
done
# Image testée : celle de la plateforme locale (binaires de son architecture).
docker build -q --platform "linux/$(docker version --format '{{.Server.Arch}}')" \
  -f "$dockerfile" -t "$image" . >/dev/null

admin_url=postgres://kaxolax:kaxolax@127.0.0.1:5432/postgres
source_db="kaxolax_backup_selftest_$$"
prefix="backup-selftest-$$"
key="$(docker run --rm "$image" age-keygen 2>/dev/null)"
env_file="$(mktemp)"
run() {
  docker run --rm --network host --env-file "$env_file" "$image" "$@"
}
cleanup() {
  # SeaweedFS peut garder un préfixe vide après la purge (sans objet ni coût).
  run sh -c '. /opt/kaxolax/backup/lib.sh && configure_rclone && rclone purge "$REMOTE"' >/dev/null 2>&1 || true
  run psql "$admin_url" -X -q -c "DROP DATABASE IF EXISTS $source_db WITH (FORCE)" >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT

cat >"$env_file" <<ENV
DATABASE_URL=postgres://kaxolax:kaxolax@127.0.0.1:5432/$source_db
RESTORE_ADMIN_URL=$admin_url
AGE_RECIPIENT=$(printf '%s\n' "$key" | sed -n 's/^# public key: //p')
AGE_IDENTITY=$(printf '%s\n' "$key" | grep '^AGE-SECRET-KEY-')
BACKUP_S3_PROVIDER=Other
BACKUP_S3_ENDPOINT=http://127.0.0.1:8333
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=kaxolax-compile-outputs
BACKUP_S3_ACCESS_KEY_ID=kaxolax
BACKUP_S3_SECRET_ACCESS_KEY=kaxolax-local-secret
BACKUP_PREFIX=$prefix
ENV

run psql "$admin_url" -X -q -c "CREATE DATABASE $source_db"
run psql "postgres://kaxolax:kaxolax@127.0.0.1:5432/$source_db" -X -q -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE users (id int); INSERT INTO users SELECT generate_series(1, 42);
   CREATE TABLE projects (id int); INSERT INTO projects SELECT generate_series(1, 7);"

run /opt/kaxolax/backup/pg-backup.sh
sleep 1
# Deuxième sauvegarde : la première, « expirée », est supprimée (une seule gardée).
run sh -c 'BACKUP_RETENTION_DAYS=0 BACKUP_MIN_KEEP=1 /opt/kaxolax/backup/pg-backup.sh'
count="$(run sh -c '. /opt/kaxolax/backup/lib.sh && configure_rclone && list_backups | wc -l')"
[[ "$count" -eq 1 ]] || { echo "rétention : $count sauvegardes au lieu de 1" >&2; exit 1; }
run /opt/kaxolax/backup/pg-restore-test.sh

# Un manifeste qui ne correspond pas au dump doit faire échouer le test de restauration.
run sh -c '. /opt/kaxolax/backup/lib.sh && configure_rclone && s=$(list_backups | head -n 1) &&
  rclone copyto "$REMOTE/$s/manifest.txt" /tmp/manifest.txt &&
  sed -i "s/^count.users=.*/count.users=1/" /tmp/manifest.txt &&
  rclone copyto "$REMOTE/$s/kaxolax.dump.age" "$REMOTE/20991231T000000Z/kaxolax.dump.age" &&
  rclone copyto /tmp/manifest.txt "$REMOTE/20991231T000000Z/manifest.txt"'
if run /opt/kaxolax/backup/pg-restore-test.sh 2>/dev/null; then
  echo "écart de lignes non détecté" >&2
  exit 1
fi
echo "sauvegarde et restauration vérifiées"
