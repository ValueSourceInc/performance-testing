#!/usr/bin/env bash
# usage: ./run.sh <scenario> (configure load via environment variables)
# scenarios: smoke | soak | stress | spike | mixed | longstream
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
  echo "unknown scenario: ${SCENARIO} (smoke|soak|stress|spike|mixed|longstream)"
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

# Full monitoring also requires the per-request stream/local-resource meter.
: "${STREAM_METER:=${AWS_METRICS:-0}}"
export STREAM_METER

# target config — override here or via env
: "${BASE_URL:=http://localhost:8787}"
: "${API_KEY:=sk-mock}"
# API_KEYS (comma-separated) overrides API_KEY for multi-account testing
: "${MODELS:=gpt-6-astra,claude-sonnet-5}"
: "${REQ_TIMEOUT_MS:=120s}"
: "${API_KEYS:=$API_KEY}"

case "$SCENARIO" in
  soak) : "${SOAK_VUS:=1000}"; : "${SOAK_DURATION:=2m}" ;;
  stress) : "${STRESS_START_VUS:=2000}"; : "${STRESS_MAX_VUS:=${STRESS_PEAK_VUS:-6000}}" ;;
  spike) : "${SPIKE_MAX_VUS:=${SPIKE_VUS:-1000}}" ;;
  mixed) : "${MIXED_VUS:=2000}"; : "${MIXED_DURATION:=3m}" ;;
  # 长流场景: REQ_TIMEOUT_MS 需大于流时长(8192 tokens → 2731 事件 × 25ms ≈ 68s,建议超时 3m)
  # SEND_MAX_TOKENS 必须=1: mock_max_tokens 过不了 relay,真实 max_tokens 才能控 mock 输出
  longstream) : "${LONG_VUS:=2000}"; : "${LONG_DURATION:=5m}"; : "${MOCK_MAX_TOKENS:=8192}"; : "${REQ_TIMEOUT_MS:=3m}"; : "${SEND_MAX_TOKENS:=1}" ;;
esac

export BASE_URL API_KEY API_KEYS MODELS REQ_TIMEOUT_MS
export SOAK_VUS SOAK_DURATION STRESS_START_VUS STRESS_MAX_VUS SPIKE_MAX_VUS MIXED_VUS MIXED_DURATION
export LONG_VUS LONG_DURATION MOCK_MAX_TOKENS
mkdir -p "${OUTPUT_DIR:-logs}"
STAMP="$(date +%Y%m%d-%H%M%S)-$$"
export RUN_ID="$STAMP"
LOG="${OUTPUT_DIR:-logs}/${STAMP}-${SCENARIO}.log"
SUMMARY_JSON="${LOG%.log}.json"
META_JSON="${LOG%.log}.meta.json"
EVENTS_JSONL="${LOG%.log}.events.jsonl"
node tools/run-metadata.js "$SCENARIO" "$META_JSON"
echo "Report collection: AWS_METRICS=${AWS_METRICS:-0}, STREAM_METER=$STREAM_METER"
if [ "${AWS_METRICS:-0}" != 1 ] || [ "$STREAM_METER" != 1 ]; then
  echo 'WARNING: full AWS/local/TTFT report is disabled. Use bash run-aws.sh for the complete report.'
fi

METER_PID=""
MONITOR_OPEN=0
cleanup() {
  if [ -n "$METER_PID" ]; then
    kill -TERM "$METER_PID" 2>/dev/null || true
    wait "$METER_PID" 2>/dev/null || true
  fi
  if [ "$MONITOR_OPEN" = 1 ]; then
    node tools/aws-monitor.js release "$META_JSON" || true
  fi
}
trap cleanup EXIT
trap 'echo "Interrupted; preserving partial results and collecting the report."' INT
if [ "${AWS_METRICS:-0}" = 1 ]; then
  node tools/aws-monitor.js begin "$META_JSON"
  MONITOR_OPEN=1
fi
TRAFFIC_URL="$BASE_URL"
if [ "${STREAM_METER:-0}" = 1 ]; then
  METER_READY="${LOG%.log}.meter-ready.json"
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY \
    node tools/stream-meter.js "$BASE_URL" "${LOG%.log}.stream.jsonl" "$METER_READY" > "${LOG%.log}.meter.log" 2>&1 &
  METER_PID=$!
  for attempt in $(seq 1 100); do
    [ -f "$METER_READY" ] && break
    kill -0 "$METER_PID" 2>/dev/null || { echo "Stream meter failed; inspect ${LOG%.log}.meter.log"; exit 1; }
    sleep 0.1
  done
  [ -f "$METER_READY" ] || { echo 'Stream meter did not become ready'; exit 1; }
  TRAFFIC_URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$METER_READY")
fi

echo "=== k6 ${SCENARIO} -> ${BASE_URL} ($(date)) ===" | tee "$LOG"
# config lines — report-generator 解析进"测试条件"表(指南 §9.1)
for c in "BASE_URL=$BASE_URL" "MODELS=$MODELS" "REQ_TIMEOUT_MS=$REQ_TIMEOUT_MS" \
         "SOAK_VUS=${SOAK_VUS:-}" "SOAK_DURATION=${SOAK_DURATION:-}" \
         "STRESS_MAX_VUS=${STRESS_MAX_VUS:-}" "STRESS_STEP_DURATION=${STRESS_STEP_DURATION:-30s}" \
         "STRESS_RAMP_DURATION=${STRESS_RAMP_DURATION:-10s}" "WARMUP_DURATION=${WARMUP_DURATION:-0s}" \
         "STRESS_RECOVERY_DURATION=${STRESS_RECOVERY_DURATION:-0s}" \
         "SPIKE_BASE_VUS=${SPIKE_BASE_VUS:-}" "SPIKE_MAX_VUS=${SPIKE_MAX_VUS:-}" \
         "MIXED_RPS=${MIXED_RPS:-}" "MIXED_DURATION=${MIXED_DURATION:-}" \
         "MIXED_PREALLOCATED_VUS=${MIXED_PREALLOCATED_VUS:-}" "MIXED_MAX_VUS=${MIXED_MAX_VUS:-}" \
         "MOCK_FAULTS=${MOCK_FAULTS:-off}" "API_KEYS_COUNT=$(echo "$API_KEYS" | tr ',' '\n' | wc -l | tr -d ' ')" \
         "PROMPTS_FILE=${PROMPTS_FILE:-}" "PROMPT_KIND=${PROMPT_KIND:-}" "STREAM_RATIO=${STREAM_RATIO:-}" "MOCK_MAX_TOKENS=${MOCK_MAX_TOKENS:-}"; do
  echo "config: ${c%%=*}=$(echo "${c#*=}" | sed 's/ *$//')" | tee -a "$LOG"
done
set +e
# Always connect directly, regardless of proxy variables inherited or loaded from .env.
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    NO_PROXY='*' no_proxy='*' node tools/run-supervised.js "$METER_PID" "$LOG" k6 run --log-format=json \
  --console-output "$EVENTS_JSONL" \
  -e BASE_URL="$TRAFFIC_URL" \
  -e API_KEY="$API_KEY" \
  -e API_KEYS="$API_KEYS" \
  -e MODELS="$MODELS" \
  -e REQ_TIMEOUT_MS="$REQ_TIMEOUT_MS" \
  -e MIXED_PREALLOCATED_VUS="${MIXED_PREALLOCATED_VUS:-}" \
  -e MIXED_MAX_VUS="${MIXED_MAX_VUS:-}" \
  -e SEND_MAX_TOKENS="${SEND_MAX_TOKENS:-0}" \
  -e PROMPTS_FILE="${PROMPTS_FILE:-}" \
  -e PROMPT_KIND="${PROMPT_KIND:-}" \
  -e STREAM_RATIO="${STREAM_RATIO:-}" \
  -e MOCK_MAX_TOKENS="${MOCK_MAX_TOKENS:-}" \
  --summary-export "$SUMMARY_JSON" \
  "scenarios/${SCENARIO}.js"

K6_STATUS=$?
set -e
if [ -n "$METER_PID" ]; then
  kill -TERM "$METER_PID" 2>/dev/null || true
  wait "$METER_PID" || echo 'Stream meter exited with an error; report will show missing measurements.'
  METER_PID=""
fi
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

if [ "${AWS_METRICS:-0}" = 1 ]; then
  if node tools/aws-monitor.js end "$META_JSON"; then
    MONITOR_OPEN=0
  else
    echo 'AWS monitoring is incomplete; preserving load-test results and retrying lease release on exit.'
  fi
fi

# 生成 Markdown 报告(优先解析 JSON summary)
if command -v node >/dev/null 2>&1 && [ -f lib/report-generator.js ]; then
  node lib/report-generator.js "$LOG" "$SUMMARY_JSON" "$META_JSON" "$EVENTS_JSONL"
fi

exit "$K6_STATUS"
