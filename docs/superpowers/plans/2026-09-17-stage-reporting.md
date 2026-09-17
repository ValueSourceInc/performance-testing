# Stage Reporting Implementation Plan

**Goal:** Make reruns produce auditable load-stage results under guide sections 5 and 9.

**Architecture:** A pure load-plan module supplies k6 options and report windows. Each HTTP call writes start/end JSON events to k6's separate console file, without request IDs as metric tags. A Node analyzer joins events, writes request JSONL, and calculates cohort results and event-time window rates separately. Missing evidence is explicit.

**Tech Stack:** Existing k6, Node >=18, node:test. No production traffic for verification.

**Spec:** /Users/lim/Downloads/AI中转站压测实施指南.md, sections 4.2, 5, 9.

## Tasks

1. Add failing tests for fixed plateaus, warmup boundaries, tail attribution, censored requests, success-only percentiles, missing usage, and legacy reports.
2. Implement `lib/load-plan.js`: parse durations, validate inputs, return k6 scenario options and timestamped stage windows. Stress uses optional short ramps and fixed holds; existing peak settings remain effective.
3. Update scenario modules and `lib/requests.js`: attach bounded stage/model/stream tags; emit redacted start/end events with monotonic offsets, correlation ID, usage and error classification. Keep successful latency separate.
4. Implement `lib/analyze.js`: stream event records, retain starts until finish, export normalized JSONL; derive stage cohorts, chronological throughput and client in-flight area/peak; mark unpaired starts unresolved.
5. Replace report generation with tables matching the guide, explicit missing evidence and no automatic service-capacity verdict. Preserve legacy summary support without inventing absent stage data.
6. Update `run.sh` to save metadata and console events, preserve direct connections and nonzero k6 exits, and generate reports after failures. Document config, interpretation and limits.
7. Run unit tests and a short real-k6/local-HTTP integration covering mixed successes/failures, tail completion, local-only targets and report output. Review diff and leave production runs to the user.
