#!/usr/bin/env bash
# Crea (o actualiza) la EventBridge rule diaria que dispara el voice survey
# 5 días antes del primer partido de un torneo. Idempotente — safe re-run.
#
# Requiere AWS CLI v2 y credenciales con permisos sobre Lambda + EventBridge
# en us-east-1.
#
# Uso:
#   bash scripts/setup-voice5day-eventbridge.sh           # crea/actualiza
#   bash scripts/setup-voice5day-eventbridge.sh --dry-run # solo imprime los comandos
#   bash scripts/setup-voice5day-eventbridge.sh --delete  # remueve la rule

set -euo pipefail

REGION="us-east-1"
FUNCTION_NAME="prode-api"
RULE_NAME="prode-voice-5day-reminder"
# 14:00 hora Argentina (UTC-3) = 17:00 UTC. Cron EventBridge: minute hour day-of-month month day-of-week year
SCHEDULE_EXPR="cron(0 17 * * ? *)"
TARGET_INPUT='{"source":"prode.voice-5day-reminder"}'
STATEMENT_ID="${RULE_NAME}-invoke"

ACTION="apply"
for arg in "$@"; do
    case "$arg" in
        --dry-run) ACTION="dry-run" ;;
        --delete)  ACTION="delete" ;;
    esac
done

run() {
    if [[ "$ACTION" == "dry-run" ]]; then
        echo "[dry-run] $*"
    else
        echo "+ $*"
        eval "$@"
    fi
}

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
RULE_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

echo "Region:        $REGION"
echo "Account:       $ACCOUNT_ID"
echo "Lambda:        $LAMBDA_ARN"
echo "Rule:          $RULE_ARN"
echo "Schedule:      $SCHEDULE_EXPR  (14h ART = 17h UTC)"
echo "Action:        $ACTION"
echo

if [[ "$ACTION" == "delete" ]]; then
    run "aws events remove-targets --region $REGION --rule $RULE_NAME --ids 1 || true"
    run "aws events delete-rule --region $REGION --name $RULE_NAME || true"
    run "aws lambda remove-permission --region $REGION --function-name $FUNCTION_NAME --statement-id $STATEMENT_ID || true"
    echo "✅ Rule eliminada."
    exit 0
fi

# 1. Crear/actualizar la rule
run "aws events put-rule \
    --region $REGION \
    --name $RULE_NAME \
    --schedule-expression '$SCHEDULE_EXPR' \
    --state ENABLED \
    --description 'Daily: trigger prode.voice_survey 5 days before tournament starts'"

# 2. Dar permiso a EventBridge para invocar la Lambda (idempotente: ignora si ya existe)
run "aws lambda add-permission \
    --region $REGION \
    --function-name $FUNCTION_NAME \
    --statement-id $STATEMENT_ID \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn $RULE_ARN \
    2>/dev/null || echo '  (permission ya existe, skip)'"

# 3. Setear Lambda como target con el payload custom
TARGETS_JSON=$(cat <<EOF
[
  {
    "Id": "1",
    "Arn": "$LAMBDA_ARN",
    "Input": "$(echo $TARGET_INPUT | sed 's/"/\\"/g')"
  }
]
EOF
)

if [[ "$ACTION" == "dry-run" ]]; then
    echo "[dry-run] aws events put-targets --rule $RULE_NAME --targets <json>"
    echo "$TARGETS_JSON"
else
    echo "$TARGETS_JSON" > /tmp/voice5day-targets.json
    aws events put-targets \
        --region "$REGION" \
        --rule "$RULE_NAME" \
        --targets file:///tmp/voice5day-targets.json
    rm -f /tmp/voice5day-targets.json
fi

echo
echo "✅ EventBridge rule lista. La Lambda se dispara diariamente a las 14h ART."
echo
echo "Smoke test manual (no espera al cron):"
echo "  aws lambda invoke --function-name $FUNCTION_NAME --region $REGION \\"
echo "    --invocation-type RequestResponse \\"
echo "    --cli-binary-format raw-in-base64-out \\"
echo "    --payload '$TARGET_INPUT' out.json && cat out.json"
