#!/usr/bin/env bash
# Restaura la DB desde un backup en S3.
#
# Uso:
#   bash restore-db.sh <s3-key>
#   bash restore-db.sh db/2026-05-11/prode-2026-05-11T04-00-00-000Z.sql.gz
#
# Lista los backups disponibles:
#   aws s3 ls s3://prode-backups/db/ --recursive
#
# IMPORTANTE: el dump está pensado para ejecutarse contra una DB con el mismo
# schema. Hace TRUNCATE de cada tabla antes de re-insertar, así que reemplaza
# todos los datos. Para restore en una DB nueva, ejecutar las migrations primero.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BACKUP_BUCKET:-prode-backups}"
KEY="${1:-}"

if [[ -z "$KEY" ]]; then
  echo "Uso: $0 <s3-key>" >&2
  echo "Ejemplo: $0 db/2026-05-11/prode-2026-05-11T04-00-00-000Z.sql.gz" >&2
  echo "" >&2
  echo "Backups disponibles:" >&2
  aws s3 ls "s3://$BUCKET/db/" --recursive --region "$REGION" >&2
  exit 1
fi

: "${DB_HOST:?Setear DB_HOST}"
: "${DB_USER:?Setear DB_USER}"
: "${DB_PASSWORD:?Setear DB_PASSWORD}"
: "${DB_NAME:?Setear DB_NAME}"
DB_PORT="${DB_PORT:-5432}"

echo "==> Descargando s3://$BUCKET/$KEY"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
aws s3 cp "s3://$BUCKET/$KEY" "$TMP/dump.sql.gz" --region "$REGION"
gunzip "$TMP/dump.sql.gz"

LINES=$(wc -l < "$TMP/dump.sql")
echo "==> Dump: $LINES líneas"
echo "==> Destino: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
read -r -p "ESTO BORRA TODOS LOS DATOS ACTUALES. Escribir 'RESTAURAR' para continuar: " ans
[[ "$ans" == "RESTAURAR" ]] || { echo "Cancelado"; exit 1; }

echo "==> Ejecutando restore..."
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  --set ON_ERROR_STOP=on \
  --single-transaction=off \
  -f "$TMP/dump.sql"

echo "==> OK — restore completado"
