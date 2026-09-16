#!/usr/bin/env bash
# usage: ./run.sh <scenario> [extra k6 args]
# scenarios: smoke | soak | stress | spike | mixed
set -euo pipefail
cd "$(dirname "$0")"

SCENARIO="${1:-smoke}"
shift || true

if [ ! -f "scenarios/${SCENARIO}.js" ]; then
  echo "unknown scenario: $SCENARIO (smoke|soak|stress|spike|mixed)"
  exit 1
fi

# load .env if present (env vars already set take precedence)
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# target config — override here or via env
: "${BASE_URL:=http://localhost:8787}"
: "${API_KEY:=sk-mock}"
: "${MODELS:=gpt-6-astra,claude-sonnet-5}"

mkdir -p logs
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="logs/${STAMP}-${SCENARIO}.log"

echo "=== k6 ${SCENARIO} -> ${BASE_URL} ($(date)) ===" | tee "$LOG"
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e API_KEY="$API_KEY" \
  -e MODELS="$MODELS" \
  "$@" "scenarios/${SCENARIO}.js" 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "log saved: $LOG"

# 生成 Markdown 报告
if command -v node >/dev/null 2>&1 && [ -f lib/report-generator.js ]; then
  node lib/report-generator.js "$LOG"
fi