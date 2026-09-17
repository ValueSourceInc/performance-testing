#!/usr/bin/env bash
# usage: ./run.sh <scenario> [extra k6 args]
# scenarios: smoke | soak | stress | spike | mixed
set -euo pipefail
cd "$(dirname "$0")"

SCENARIO="${1:-smoke}"
shift || true

if [ ! -f "scenarios/${SCENARIO}.js" ]; then
  echo "unknown scenario: ${SCENARIO} (smoke|soak|stress|spike|mixed)"
  exit 1
fi

# load .env if present, WITHOUT overriding variables already set in the environment
# (plain `source .env` would clobber explicit BASE_URL=... ./run.sh overrides)
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    line="${line%%#*}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"
    v="${BASH_REMATCH[2]}"
    v="${v%"${v##*[![:space:]]}"}"
    [ "${!k+x}" = x ] && continue
    export "$k=$v"
  done < .env
fi

# target config — override here or via env
: "${BASE_URL:=http://localhost:8787}"
: "${API_KEY:=sk-mock}"
# API_KEYS (comma-separated) overrides API_KEY for multi-account testing
: "${MODELS:=gpt-6-astra,claude-sonnet-5}"
: "${REQ_TIMEOUT_MS:=120s}"
: "${API_KEYS:=$API_KEY}"

case "$SCENARIO" in
  soak) : "${SOAK_VUS:=20}"; : "${SOAK_DURATION:=2m}" ;;
  stress) : "${STRESS_MAX_VUS:=${STRESS_PEAK_VUS:-200}}" ;;
  spike) : "${SPIKE_MAX_VUS:=${SPIKE_VUS:-200}}" ;;
  mixed) : "${MIXED_RPS:=20}"; : "${MIXED_DURATION:=3m}" ;;
esac

mkdir -p logs
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="logs/${STAMP}-${SCENARIO}.log"
SUMMARY_JSON="logs/${STAMP}-${SCENARIO}.json"

echo "=== k6 ${SCENARIO} -> ${BASE_URL} ($(date)) ===" | tee "$LOG"
# config lines — report-generator 解析进"测试条件"表(指南 §9.1)
for c in "BASE_URL=$BASE_URL" "MODELS=$MODELS" "REQ_TIMEOUT_MS=$REQ_TIMEOUT_MS" \
         "SOAK_VUS=${SOAK_VUS:-}" "SOAK_DURATION=${SOAK_DURATION:-}" \
         "STRESS_MAX_VUS=${STRESS_MAX_VUS:-}" "STRESS_STEP_DURATION=${STRESS_STEP_DURATION:-30s}" \
         "SPIKE_BASE_VUS=${SPIKE_BASE_VUS:-}" "SPIKE_MAX_VUS=${SPIKE_MAX_VUS:-}" \
         "MIXED_RPS=${MIXED_RPS:-}" "MIXED_DURATION=${MIXED_DURATION:-}" \
         "MOCK_FAULTS=${MOCK_FAULTS:-off}" "API_KEYS_COUNT=$(echo "$API_KEYS" | tr ',' '\n' | wc -l | tr -d ' ')"; do
  echo "config: ${c%%=*}=$(echo "${c#*=}" | sed 's/ *$//')" | tee -a "$LOG"
done
set +e
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e API_KEY="$API_KEY" \
  -e API_KEYS="$API_KEYS" \
  -e MODELS="$MODELS" \
  -e REQ_TIMEOUT_MS="$REQ_TIMEOUT_MS" \
  -e SEND_MAX_TOKENS="${SEND_MAX_TOKENS:-0}" \
  --summary-export "$SUMMARY_JSON" \
  "$@" "scenarios/${SCENARIO}.js" 2>&1 | tee -a "$LOG"

K6_STATUS=${PIPESTATUS[0]}
set -e
echo "" | tee -a "$LOG"
echo "log saved: $LOG"

# 生成 Markdown 报告(优先解析 JSON summary)
if command -v node >/dev/null 2>&1 && [ -f lib/report-generator.js ]; then
  node lib/report-generator.js "$LOG" "$SUMMARY_JSON"
fi

exit "$K6_STATUS"
