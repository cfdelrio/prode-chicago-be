#!/usr/bin/env bash
# Restaura el código de la Lambda prode-api desde un backup en S3.
#
# Uso:
#   bash restore-lambda.sh <fecha>
#   bash restore-lambda.sh 2026-05-11

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BACKUP_BUCKET:-prode-backups}"
DATE="${1:-}"
FUNCTION_NAME="${FUNCTION_NAME:-prode-api}"

if [[ -z "$DATE" ]]; then
  echo "Uso: $0 <YYYY-MM-DD>" >&2
  echo "" >&2
  echo "Backups disponibles:" >&2
  aws s3 ls "s3://$BUCKET/lambda/" --region "$REGION" >&2
  exit 1
fi

KEY="lambda/$DATE/prode-api.zip"
echo "==> Descargando s3://$BUCKET/$KEY"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
aws s3 cp "s3://$BUCKET/$KEY" "$TMP/prode-api.zip" --region "$REGION"

SIZE=$(stat -c%s "$TMP/prode-api.zip" 2>/dev/null || stat -f%z "$TMP/prode-api.zip")
echo "==> Zip descargado: $SIZE bytes"
echo "==> Destino: Lambda $FUNCTION_NAME ($REGION)"
echo ""
read -r -p "Esto va a SOBRESCRIBIR la versión actual. Escribir 'RESTAURAR' para continuar: " ans
[[ "$ans" == "RESTAURAR" ]] || { echo "Cancelado"; exit 1; }

aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$TMP/prode-api.zip" \
  --region "$REGION" >/dev/null

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION"

echo "==> OK — Lambda restaurada"
echo ""
echo "Para revisar la config que estaba activa ese día:"
echo "  aws s3 cp s3://$BUCKET/lambda/$DATE/prode-api-config.json -"
