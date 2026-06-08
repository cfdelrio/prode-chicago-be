#!/bin/bash
# Push Notifications — Health Check
# Uso: ./scripts/audit-push.sh

run_sql() {
  local label="$1"
  local sql="$2"
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "▶ $label"
  echo "═══════════════════════════════════════════════════════"
  aws lambda invoke \
    --function-name prode-sql-temp \
    --payload "{\"sql\":\"$sql\"}" \
    --cli-binary-format raw-in-base64-out \
    --region us-east-1 \
    /tmp/sql_out.json > /dev/null 2>&1
  cat /tmp/sql_out.json | python3 -m json.tool 2>/dev/null || cat /tmp/sql_out.json
}

run_sql "Total de subscripciones push" \
  "SELECT COUNT(*) AS total_subs, COUNT(DISTINCT user_id) AS unique_users FROM push_subscriptions"

run_sql "Distribución por antigüedad (últimos 14 días)" \
  "SELECT DATE_TRUNC('day', created_at)::date AS dia, COUNT(*) AS subs FROM push_subscriptions GROUP BY 1 ORDER BY 1 DESC LIMIT 14"

run_sql "% de usuarios con push activo (sobre el total)" \
  "SELECT (SELECT COUNT(DISTINCT user_id) FROM push_subscriptions) AS con_push, (SELECT COUNT(*) FROM users) AS total_users, ROUND(100.0 * (SELECT COUNT(DISTINCT user_id) FROM push_subscriptions) / NULLIF((SELECT COUNT(*) FROM users), 0), 1) AS porcentaje"

run_sql "Usuarios con varios devices (subs múltiples)" \
  "SELECT user_id, COUNT(*) AS devices FROM push_subscriptions GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY devices DESC"

run_sql "Subscripciones por endpoint provider" \
  "SELECT CASE WHEN endpoint LIKE '%fcm.googleapis.com%' THEN 'Chrome/Android (FCM)' WHEN endpoint LIKE '%push.apple.com%' THEN 'Safari/iOS (APN)' WHEN endpoint LIKE '%mozilla.com%' THEN 'Firefox' WHEN endpoint LIKE '%windows.com%' THEN 'Edge' ELSE 'Other' END AS provider, COUNT(*) AS subs FROM push_subscriptions GROUP BY 1 ORDER BY 2 DESC"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Audit completo"
echo "═══════════════════════════════════════════════════════"
