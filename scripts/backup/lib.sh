# shellcheck shell=sh
# Fonctions communes à pg-backup.sh et pg-restore-test.sh (sourcé, jamais exécuté seul). POSIX sh :
# l'image (postgres alpine) n'a pas bash. rclone est configuré par variables d'environnement :
# aucun fichier de configuration ni secret sur le disque.

# Tables comptées au moment de la sauvegarde, puis après restauration (absentes : ignorées).
DEFAULT_KEY_TABLES="adonis_schema users workspaces projects project_members documents files compiles"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

fail() {
  log "ERREUR : $*"
  exit 1
}

require_env() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    # shellcheck disable=SC2154 # value est affectée par eval juste au-dessus.
    [ -n "$value" ] || fail "variable $name manquante"
  done
}

is_number() {
  case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# Remote rclone « backup: » vers R2 (fournisseur Cloudflare : région auto, chemins de style
# « path », pas d'ACL). BACKUP_S3_PROVIDER=Other pour un autre stockage S3 (SeaweedFS en local).
configure_rclone() {
  require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  export RCLONE_CONFIG_BACKUP_TYPE=s3
  export RCLONE_CONFIG_BACKUP_PROVIDER="${BACKUP_S3_PROVIDER:-Cloudflare}"
  export RCLONE_CONFIG_BACKUP_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_BACKUP_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_BACKUP_FORCE_PATH_STYLE=true
  # Le jeton n'a que les droits sur les objets : ne pas tenter de créer le bucket.
  export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG=/dev/null
  REMOTE="backup:${BACKUP_S3_BUCKET}/${BACKUP_PREFIX:-postgres}"
}

# Horodatages des sauvegardes du remote (AAAAMMJJTHHMMSSZ), du plus récent au plus ancien. Par
# les fichiers et non les « dossiers » : certains stockages S3 gardent un dossier vide.
list_backups() {
  rclone lsf --recursive --files-only "$REMOTE/" 2>/dev/null |
    sed -n 's#^\([0-9]\{8\}T[0-9]\{6\}Z\)/.*$#\1#p' | sort -ru
}

# Requête SQL qui renvoie « table|nombre de lignes » pour chaque table clé existante.
count_query() {
  list=""
  for table in ${1:-$DEFAULT_KEY_TABLES}; do
    case "$table" in
      '' | *[!a-z0-9_]*) fail "nom de table invalide : $table" ;;
    esac
    list="${list}${list:+,}'${table}'"
  done
  printf '%s\n' "SELECT t || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text FROM unnest(ARRAY[${list}]::text[]) AS t WHERE to_regclass(t) IS NOT NULL ORDER BY t;"
}

sha256_of() {
  sha256sum "$1" | cut -d ' ' -f 1
}
