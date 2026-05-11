#!/usr/bin/env bash
# Crea el bucket S3 prode-backups con encriptación, versionado y lifecycle.
# Idempotente: se puede correr múltiples veces.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
BUCKET="${BACKUP_BUCKET:-prode-backups}"

echo "==> Creando bucket s3://$BUCKET (si no existe)"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "    Ya existía"
else
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
fi

echo "==> Bloqueando acceso público"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "==> Habilitando versionado"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

echo "==> Encriptación SSE-S3"
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{
    "Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]
  }'

echo "==> Lifecycle: warm 30d → Glacier IR, expira a 365d, versiones viejas a 90d"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules":[
      {
        "ID":"transition-to-glacier",
        "Status":"Enabled",
        "Filter":{"Prefix":""},
        "Transitions":[{"Days":30,"StorageClass":"GLACIER_IR"}],
        "Expiration":{"Days":365},
        "NoncurrentVersionExpiration":{"NoncurrentDays":90}
      }
    ]
  }'

echo "==> OK — bucket listo"
echo ""
echo "Próximo paso:"
echo "  cd ../lambda && bash deploy.sh --create"
