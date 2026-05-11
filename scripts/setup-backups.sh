#!/usr/bin/env bash
# Idempotent setup for the prodecaballito backup system.
#
# Creates:
#   - S3 bucket prodecaballito-backups (versioning + lifecycle to Glacier → expire)
#   - IAM policy attached to the prode-api Lambda execution role granting S3 + RDS access
#   - EventBridge rule that triggers prode-api daily at 07:00 UTC with source=prode.backup-daily
#   - Lambda env vars BACKUP_BUCKET / RDS_INSTANCE_ID
#   - Bumps RDS automated snapshot retention to 14 days
#
# Re-runnable: all steps tolerate "already exists" responses.
#
# Usage:   ./scripts/setup-backups.sh
# Env:     AWS_PROFILE, AWS_REGION (default us-east-1)

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
LAMBDA_NAME="${LAMBDA_NAME:-prode-api}"
BUCKET="${BACKUP_BUCKET:-prodecaballito-backups}"
RDS_INSTANCE_ID="${RDS_INSTANCE_ID:-prode-db}"
RULE_NAME="prode-backup-daily"
POLICY_NAME="ProdeBackupAccess"
SCHEDULE="cron(0 7 * * ? *)"  # 07:00 UTC = 04:00 ART

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ── 1. S3 bucket ─────────────────────────────────────────────────────────────
log "S3: ensuring bucket s3://$BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
    log "  bucket already exists"
else
    if [ "$REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
    else
        aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
            --create-bucket-configuration "LocationConstraint=$REGION"
    fi
    log "  created"
fi

log "S3: enabling versioning"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled --region "$REGION"

log "S3: blocking public access"
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

log "S3: applying lifecycle (Glacier after 30d, expire after 365d)"
LIFECYCLE_JSON=$(cat <<'JSON'
{
  "Rules": [
    {
      "ID": "archive-and-expire-db-dumps",
      "Status": "Enabled",
      "Filter": {"Prefix": "db/"},
      "Transitions": [{"Days": 30, "StorageClass": "GLACIER"}],
      "Expiration": {"Days": 365},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 30}
    }
  ]
}
JSON
)
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --region "$REGION" \
    --lifecycle-configuration "$LIFECYCLE_JSON"

# ── 2. IAM policy attached to Lambda role ────────────────────────────────────
log "Lambda: looking up execution role for $LAMBDA_NAME"
LAMBDA_ROLE_ARN=$(aws lambda get-function-configuration \
    --function-name "$LAMBDA_NAME" --region "$REGION" \
    --query 'Role' --output text)
ROLE_NAME="${LAMBDA_ROLE_ARN##*/}"
log "  role: $ROLE_NAME"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

log "IAM: putting inline policy $POLICY_NAME"
POLICY_JSON=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3BackupAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject", "s3:GetObject", "s3:DeleteObject",
        "s3:ListBucket", "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::$BUCKET",
        "arn:aws:s3:::$BUCKET/*"
      ]
    },
    {
      "Sid": "RdsSnapshots",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBSnapshot",
        "rds:DescribeDBSnapshots",
        "rds:AddTagsToResource"
      ],
      "Resource": [
        "arn:aws:rds:$REGION:$ACCOUNT_ID:db:$RDS_INSTANCE_ID",
        "arn:aws:rds:$REGION:$ACCOUNT_ID:snapshot:*"
      ]
    },
    {
      "Sid": "RdsDescribe",
      "Effect": "Allow",
      "Action": ["rds:DescribeDBSnapshots"],
      "Resource": "*"
    }
  ]
}
JSON
)
aws iam put-role-policy --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" --policy-document "$POLICY_JSON"

# ── 3. Lambda env vars ───────────────────────────────────────────────────────
log "Lambda: merging env vars BACKUP_BUCKET / RDS_INSTANCE_ID"
EXISTING_ENV=$(aws lambda get-function-configuration \
    --function-name "$LAMBDA_NAME" --region "$REGION" \
    --query 'Environment.Variables' --output json)
MERGED_ENV=$(echo "$EXISTING_ENV" | \
    BACKUP_BUCKET="$BUCKET" RDS_INSTANCE_ID="$RDS_INSTANCE_ID" \
    python3 -c 'import json,os,sys; e=json.load(sys.stdin) or {}; e["BACKUP_BUCKET"]=os.environ["BACKUP_BUCKET"]; e["RDS_INSTANCE_ID"]=os.environ["RDS_INSTANCE_ID"]; print(json.dumps({"Variables": e}))')
aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" --region "$REGION" \
    --environment "$MERGED_ENV" >/dev/null

# ── 4. EventBridge daily schedule ────────────────────────────────────────────
log "EventBridge: ensuring rule $RULE_NAME ($SCHEDULE)"
aws events put-rule --name "$RULE_NAME" --region "$REGION" \
    --schedule-expression "$SCHEDULE" \
    --description "Daily prodecaballito DB backup (app dump + RDS snapshot)" \
    --state ENABLED >/dev/null

LAMBDA_ARN=$(aws lambda get-function-configuration \
    --function-name "$LAMBDA_NAME" --region "$REGION" \
    --query 'FunctionArn' --output text)

log "EventBridge: adding target with source=prode.backup-daily"
aws events put-targets --rule "$RULE_NAME" --region "$REGION" \
    --targets "Id=1,Arn=$LAMBDA_ARN,Input={\"source\":\"prode.backup-daily\"}" >/dev/null

log "Lambda: granting events.amazonaws.com permission to invoke (idempotent)"
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" --region "$REGION" \
    --statement-id "AllowEventBridgeBackup" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$RULE_NAME" \
    2>/dev/null || log "  permission already exists"

# ── 5. RDS automated snapshot retention ──────────────────────────────────────
log "RDS: setting BackupRetentionPeriod=14 on $RDS_INSTANCE_ID"
aws rds modify-db-instance \
    --db-instance-identifier "$RDS_INSTANCE_ID" --region "$REGION" \
    --backup-retention-period 14 \
    --apply-immediately >/dev/null

log "✓ Setup complete."
log "  Bucket:     s3://$BUCKET"
log "  Cron:       $SCHEDULE  → $LAMBDA_NAME with source=prode.backup-daily"
log "  RDS:        $RDS_INSTANCE_ID, 14-day automated snapshots"
log ""
log "Trigger a one-off run with:"
log "  aws lambda invoke --function-name $LAMBDA_NAME --region $REGION \\"
log "    --payload '$(echo -n '{"source":"prode.backup-daily"}' | base64)' \\"
log "    --cli-binary-format raw-in-base64-out out.json && cat out.json"
