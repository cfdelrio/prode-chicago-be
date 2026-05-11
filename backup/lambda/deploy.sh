#!/usr/bin/env bash
# Crea o actualiza la Lambda prode-backup.
#
# Uso (primera vez): bash deploy.sh --create
# Uso (update):      bash deploy.sh

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FUNCTION_NAME="prode-backup"
ROLE_NAME="prode-backup-role"
BACKUP_BUCKET="${BACKUP_BUCKET:-prode-backups}"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "==> Instalando dependencias"
rm -rf node_modules package-lock.json
npm install --omit=dev --silent

echo "==> Empaquetando zip"
ZIP=/tmp/prode-backup.zip
rm -f "$ZIP"
zip -rq "$ZIP" index.mjs package.json node_modules

if [[ "${1:-}" == "--create" ]]; then
  echo "==> Buscando config de prode-api para reusar VPC + DB env vars"
  CFG="$(aws lambda get-function-configuration \
    --function-name prode-api --region "$REGION")"
  SUBNETS="$(echo "$CFG" | jq -r '.VpcConfig.SubnetIds | join(",")')"
  SGS="$(echo "$CFG" | jq -r '.VpcConfig.SecurityGroupIds | join(",")')"
  DB_HOST="$(echo "$CFG" | jq -r '.Environment.Variables.DB_HOST')"
  DB_NAME="$(echo "$CFG" | jq -r '.Environment.Variables.DB_NAME')"
  DB_USER="$(echo "$CFG" | jq -r '.Environment.Variables.DB_USER')"
  DB_PASSWORD="$(echo "$CFG" | jq -r '.Environment.Variables.DB_PASSWORD')"
  DB_PORT="$(echo "$CFG" | jq -r '.Environment.Variables.DB_PORT // "5432"')"

  if [[ -z "$SUBNETS" || -z "$SGS" || "$DB_HOST" == "null" ]]; then
    echo "ERROR: no pude leer VPC/DB de prode-api. Ajustá las vars manualmente." >&2
    exit 1
  fi

  echo "==> Creando IAM role $ROLE_NAME (si no existe)"
  if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROLE_NAME" \
      --assume-role-policy-document '{
        "Version":"2012-10-17",
        "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
      }' >/dev/null

    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole

    aws iam put-role-policy --role-name "$ROLE_NAME" \
      --policy-name s3-backup-write \
      --policy-document "{
        \"Version\":\"2012-10-17\",
        \"Statement\":[{
          \"Effect\":\"Allow\",
          \"Action\":[\"s3:PutObject\",\"s3:PutObjectAcl\"],
          \"Resource\":\"arn:aws:s3:::${BACKUP_BUCKET}/*\"
        }]
      }"

    echo "    Esperando 10s a que el role propague..."
    sleep 10
  fi

  ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

  echo "==> Creando Lambda $FUNCTION_NAME"
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file "fileb://$ZIP" \
    --timeout 600 \
    --memory-size 1024 \
    --vpc-config "SubnetIds=$SUBNETS,SecurityGroupIds=$SGS" \
    --environment "Variables={BACKUP_BUCKET=$BACKUP_BUCKET,DB_HOST=$DB_HOST,DB_PORT=$DB_PORT,DB_NAME=$DB_NAME,DB_USER=$DB_USER,DB_PASSWORD=$DB_PASSWORD}" \
    --region "$REGION"
else
  echo "==> Actualizando código de Lambda $FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP" \
    --region "$REGION" >/dev/null
  aws lambda wait function-updated \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION"
fi

echo "==> OK"
