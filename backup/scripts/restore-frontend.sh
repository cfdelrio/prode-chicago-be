#!/usr/bin/env bash
# Restaura el frontend de S3 (prodecaballito-fe) desde un backup.
#
# Uso:
#   bash restore-frontend.sh <fecha>
#   bash restore-frontend.sh 2026-05-11

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BACKUP_BUCKET:-prode-backups}"
TARGET_BUCKET="${TARGET_BUCKET:-prodecaballito-fe}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"
DATE="${1:-}"

if [[ -z "$DATE" ]]; then
  echo "Uso: $0 <YYYY-MM-DD>" >&2
  echo "" >&2
  echo "Backups disponibles:" >&2
  aws s3 ls "s3://$BUCKET/frontend/" --region "$REGION" >&2
  exit 1
fi

echo "==> Restore: s3://$BUCKET/frontend/$DATE/ → s3://$TARGET_BUCKET/"
read -r -p "Esto va a SOBRESCRIBIR el frontend. Escribir 'RESTAURAR' para continuar: " ans
[[ "$ans" == "RESTAURAR" ]] || { echo "Cancelado"; exit 1; }

aws s3 sync \
  "s3://$BUCKET/frontend/$DATE/" \
  "s3://$TARGET_BUCKET/" \
  --delete \
  --region "$REGION"

if [[ -n "$CLOUDFRONT_DISTRIBUTION_ID" ]]; then
  echo "==> Invalidando CloudFront $CLOUDFRONT_DISTRIBUTION_ID"
  aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/*" >/dev/null
else
  echo "NOTA: CLOUDFRONT_DISTRIBUTION_ID no seteado. Recordá invalidar el CDN."
fi

echo "==> OK"
