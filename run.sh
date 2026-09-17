#!/usr/bin/env bash
# usage: ./run.sh <scenario> (configure load via environment variables)
# scenarios: smoke | soak | stress | spike | mixed
set -euo pipefail
cd "$(dirname "$0")"

SCENARIO="${1:-smoke}"
shift || true

# Scenario/load overrides must be configured through env so recorded plans stay accurate.
if [ "$#" -gt 0 ]; then
  echo 'Use scenario environment variables instead of extra k6 flags (keeps execution and report plans aligned).'
  exit 1
fi

if [ ! -f "scenarios/${SCENARIO}.js" ]; then
  echo "unknown scenario: ${SCENARIO} (smoke|soak|stress|spike|mixed)"
  exit 1
fi

# load .env if present, WITHOUT overriding variables already set in the environment
# (plain `source .env` would clobber explicit BASE_URL=... ./run.sh overrides)
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
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

export BASE_URL API_KEY API_KEYS MODELS REQ_TIMEOUT_MS
export SOAK_VUS SOAK_DURATION STRESS_MAX_VUS SPIKE_MAX_VUS MIXED_RPS MIXED_DURATION
mkdir -p "${OUTPUT_DIR:-logs}"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
export RUN_ID="$STAMP"
LOG="${OUTPUT_DIR:-logs}/${STAMP}-${SCENARIO}.log"
SUMMARY_JSON="${LOG%.log}.json"
META_JSON="${LOG%.log}.meta.json"
EVENTS_JSONL="${LOG%.log}.events.jsonl"
node tools/run-metadata.js "$SCENARIO" "$META_JSON"

echo "=== k6 ${SCENARIO} -> ${BASE_URL} ($(date)) ===" | tee "$LOG"
# config lines — report-generator 解析进"测试条件"表(指南 §9.1)
for c in "BASE_URL=$BASE_URL" "MODELS=$MODELS" "REQ_TIMEOUT_MS=$REQ_TIMEOUT_MS" \
         "SOAK_VUS=${SOAK_VUS:-}" "SOAK_DURATION=${SOAK_DURATION:-}" \
         "STRESS_MAX_VUS=${STRESS_MAX_VUS:-}" "STRESS_STEP_DURATION=${STRESS_STEP_DURATION:-30s}" \
         "STRESS_RAMP_DURATION=${STRESS_RAMP_DURATION:-10s}" "WARMUP_DURATION=${WARMUP_DURATION:-0s}" \
         "SPIKE_BASE_VUS=${SPIKE_BASE_VUS:-}" "SPIKE_MAX_VUS=${SPIKE_MAX_VUS:-}" \
         "MIXED_RPS=${MIXED_RPS:-}" "MIXED_DURATION=${MIXED_DURATION:-}" \
         "MOCK_FAULTS=${MOCK_FAULTS:-off}" "API_KEYS_COUNT=$(echo "$API_KEYS" | tr ',' '\n' | wc -l | tr -d ' ')"; do
  echo "config: ${c%%=*}=$(echo "${c#*=}" | sed 's/ *$//')" | tee -a "$LOG"
done
set +e
# Always connect directly, regardless of proxy variables inherited or loaded from .env.
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    NO_PROXY='*' no_proxy='*' k6 run --log-format=json \
  --console-output "$EVENTS_JSONL" \
  -e BASE_URL="$BASE_URL" \
  -e API_KEY="$API_KEY" \
  -e API_KEYS="$API_KEYS" \
  -e MODELS="$MODELS" \
  -e REQ_TIMEOUT_MS="$REQ_TIMEOUT_MS" \
  -e SEND_MAX_TOKENS="${SEND_MAX_TOKENS:-0}" \
  --summary-export "$SUMMARY_JSON" \
  "scenarios/${SCENARIO}.js" 2>&1 | tee -a "$LOG"

K6_STATUS=${PIPESTATUS[0]}
set -e
node --input-type=module - "$META_JSON" "$K6_STATUS" <<'JS'
import fs from 'node:fs';
const [file, status] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
meta.finishedAt = new Date().toISOString();
meta.elapsedMs = Date.parse(meta.finishedAt) - Date.parse(meta.createdAt);
meta.exitCode = Number(status);
fs.writeFileSync(file, JSON.stringify(meta, null, 2));
JS
echo "" | tee -a "$LOG"
echo "log saved: $LOG"

# 生成 Markdown 报告(优先解析 JSON summary)
if command -v node >/dev/null 2>&1 && [ -f lib/report-generator.js ]; then
  node lib/report-generator.js "$LOG" "$SUMMARY_JSON" "$META_JSON" "$EVENTS_JSONL"
fi

exit "$K6_STATUS"
