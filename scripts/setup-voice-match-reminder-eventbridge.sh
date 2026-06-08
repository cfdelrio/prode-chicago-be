#!/usr/bin/env bash
# Crea (o actualiza) la EventBridge rule cada 5 min que dispara voice_match_reminder
# 30 min antes del kickoff de cada partido. Idempotente — safe re-run.
#
# Uso:
#   bash scripts/setup-voice-match-reminder-eventbridge.sh           # crea/actualiza
#   bash scripts/setup-voice-match-reminder-eventbridge.sh --dry-run # solo imprime
#   bash scripts/setup-voice-match-reminder-eventbridge.sh --delete  # remueve la rule

set -euo pipefail

REGION="us-east-1"
FUNCTION_NAME="prode-api"
RULE_NAME="prode-voice-match-reminder"
SCHEDULE_EXPR="cron(*/5 * * * ? *)"
TARGET_INPUT='{"source":"prode.voice-match-reminder"}'
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
echo "Lambda:        $LAMBDA_ARN"
echo "Rule:          $RULE_ARN"
echo "Schedule:      $SCHEDULE_EXPR  (cada 5 min)"
echo "Action:        $ACTION"
echo

if [[ "$ACTION" == "delete" ]]; then
    run "aws events remove-targets --region $REGION --rule $RULE_NAME --ids 1 || true"
    run "aws events delete-rule --region $REGION --name $RULE_NAME || true"
    run "aws lambda remove-permission --region $REGION --function-name $FUNCTION_NAME --statement-id $STATEMENT_ID || true"
    echo "✅ Rule eliminada."
    exit 0
fi

run "aws events put-rule \
    --region $REGION \
    --name $RULE_NAME \
    --schedule-expression '$SCHEDULE_EXPR' \
    --state ENABLED \
    --description 'Every 5 min: trigger prode.voice_match_reminder 30 min before kickoff'"

run "aws lambda add-permission \
    --region $REGION \
    --function-name $FUNCTION_NAME \
    --statement-id $STATEMENT_ID \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn $RULE_ARN \
    2>/dev/null || echo '  (permission ya existe, skip)'"

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
    echo "[dry-run] aws events put-targets --rule $RULE_NAME"
    echo "$TARGETS_JSON"
else
    echo "$TARGETS_JSON" > /tmp/voice-match-reminder-targets.json
    aws events put-targets \
        --region "$REGION" \
        --rule "$RULE_NAME" \
        --targets file:///tmp/voice-match-reminder-targets.json
    rm -f /tmp/voice-match-reminder-targets.json
fi

echo
echo "✅ EventBridge rule lista. Se dispara cada 5 min."
