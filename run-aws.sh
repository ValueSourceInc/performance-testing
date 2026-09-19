#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! node --input-type=module -e 'await import("eventsource-parser"); await import("markdown-it"); await import("systeminformation")' >/dev/null 2>&1; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
export AWS_METRICS=1 STREAM_METER=1 UPSTREAM_MODE=mock
exec bash ./run.sh "$@"
