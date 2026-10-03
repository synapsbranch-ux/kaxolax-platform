#!/usr/bin/env bash
# Initialise les buckets S3 locaux. Idempotent : peut être relancé sans risque.
set -euo pipefail

s3api() { aws --endpoint-url "$S3_ENDPOINT" s3api "$@"; }

for bucket in "$S3_BUCKET_PROJECT_FILES" "$S3_BUCKET_COMPILE_OUTPUTS"; do
  if s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "bucket $bucket: already exists"
  else
    s3api create-bucket --bucket "$bucket" >/dev/null
    echo "bucket $bucket: created"
  fi
done

# Le navigateur uploade par URL présignée (PUT) et pdf.js lit le PDF par requêtes Range :
# les deux vont directement vers S3, donc vers une autre origine que l'application.
cors=$(cat <<JSON
{
  "CORSRules": [
    {
      "AllowedOrigins": ["$WEB_ORIGIN"],
      "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON
)
for bucket in "$S3_BUCKET_PROJECT_FILES" "$S3_BUCKET_COMPILE_OUTPUTS"; do
  s3api put-bucket-cors --bucket "$bucket" --cors-configuration "$cors"
done
echo "cors: applied for $WEB_ORIGIN"

# Mêmes règles d'expiration qu'en production (cycle de vie R2 de kaxolax-infra) : sorties de
# compilation à 7 jours, téléversements en attente (uploads/) à 1 jour.
s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET_COMPILE_OUTPUTS" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-outputs","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":7}}]}'
s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET_PROJECT_FILES" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-pending-uploads","Status":"Enabled","Filter":{"Prefix":"uploads/"},"Expiration":{"Days":1}}]}'
echo "lifecycle: applied"
echo "s3-init: done"
