#!/usr/bin/env python3
"""SSE 流式探针 — 测真实首字时间(TTFT)+ 协议完整性,补 k6 无法逐段读流的缺口。

k6 的 http 模块会缓冲整个响应体,只能拿到 TTFB;本脚本用 httpx 逐段读 SSE,
记录:首非空内容到达、结束标记、错误事件、取消路径。

用法:
  python3 tools/sse_probe.py --base-url http://localhost:8787 --model mock-gpt-4o -n 20 -c 4
  python3 tools/sse_probe.py --cancel-after 2.0 ...          # 收到 2 秒内容后主动断开(测中转站取消)
  python3 tools/sse_probe.py --fault disconnect ...           # 强制 mock 注入指定故障

输出:JSONL 明细(probe-detail-<stamp>.jsonl)+ stdout 汇总(p50/p95、错误分类)。
"""
import argparse
import asyncio
import json
import math
import os
import time

import httpx

END_MARKERS = ("[DONE]", '"message_stop"')
ERROR_EVENT = '"error"'


async def stream_once(client, args, rec, body):
    """one SSE request; fills rec[status/result/error_type/ttft/chars]."""
    async with client.stream("POST", f"{args.base_url}/v1/chat/completions",
                             json=body, timeout=httpx.Timeout(
                                 connect=args.connect_timeout,
                                 read=args.read_idle_timeout,
                                 write=args.write_timeout,
                                 pool=args.pool_timeout,
                             )) as resp:
        rec["status"] = resp.status_code
        if resp.status_code != 200:
            await resp.aread()
            rec["result"], rec["error_type"] = "fail", f"http_{resp.status_code}"
            return
        done = False
        err = False
        cancelled = False
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]" or '"message_stop"' in payload:
                done = True
                break
            if ERROR_EVENT in payload:
                err = True
                break
            if '"content":"' in payload or '"text_delta"' in payload:
                if rec["ttft"] is None:
                    rec["ttft"] = time.monotonic() - rec["start"]
                rec["chars"] += len(payload)
            if args.cancel_after and rec["ttft"] and \
                    time.monotonic() - rec["start"] - rec["ttft"] > args.cancel_after:
                cancelled = True
                break
        if cancelled:
            rec["result"], rec["error_type"] = "cancelled", "client_cancel"
        elif err:
            rec["result"], rec["error_type"] = "fail", "error_event"
        elif not done:
            rec["result"], rec["error_type"] = "fail", "no_end_marker"
        elif rec["ttft"] is None:
            rec["result"], rec["error_type"] = "fail", "no_content"
        else:
            rec["result"] = "ok"
        rec["total"] = time.monotonic() - rec["start"]


async def one_request(client, args, sem, out, idx):
    body = {
        "model": args.model,
        "stream": True,
        "messages": [{"role": "user", "content": "你好,请介绍一下你自己"}],
        "mock_max_tokens": args.max_tokens,
        "mock_ttft_ms": args.mock_ttft_ms,
        "mock_interval_ms": args.mock_interval_ms,
    }
    if args.fault:
        body["mock_fault"] = args.fault

    queued = time.monotonic()
    rec = {"id": idx, "start": None, "sched_wait": None, "ttft": None, "total": None,
           "status": None, "result": None, "error_type": None, "chars": 0}
    try:
        async with sem:
            # clock starts AFTER winning the concurrency slot; the queue wait is
            # recorded separately as sched_wait, never inside TTFT/total
            rec["start"] = time.monotonic()
            rec["sched_wait"] = rec["start"] - queued
            # total request deadline — REQUIRED: heartbeats keep the read-idle timer fed forever
            await asyncio.wait_for(stream_once(client, args, rec, body), timeout=args.total_timeout)
    except asyncio.TimeoutError:
        rec["result"], rec["error_type"] = "fail", "total_timeout"
        rec["total"] = time.monotonic() - (rec["start"] or queued)
    except httpx.TimeoutException as e:
        rec["result"], rec["error_type"] = "fail", f"timeout:{type(e).__name__}"
        rec["total"] = time.monotonic() - (rec["start"] or queued)
    except (httpx.TransportError, httpx.HTTPError) as e:
        rec["result"], rec["error_type"] = "fail", f"transport:{type(e).__name__}"
        rec["total"] = time.monotonic() - (rec["start"] or queued)
    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, math.floor(len(s) * p / 100))]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8787")
    ap.add_argument("--key", default="sk-mock")
    ap.add_argument("--model", default="mock-gpt-4o")
    ap.add_argument("-n", type=int, default=10)
    ap.add_argument("-c", "--concurrency", type=int, default=1)
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--mock-ttft-ms", type=int, default=500)
    ap.add_argument("--mock-interval-ms", type=int, default=20)
    ap.add_argument("--fault", default=None,
                    help="force mock fault: 429/500/timeout/disconnect/pause/heartbeat/error_event")
    ap.add_argument("--cancel-after", type=float, default=None,
                    help="seconds after first content, then abort (client-cancel test)")
    # separate timeouts: connect / write / read-idle (next chunk) / pool — NOT a total limit
    ap.add_argument("--connect-timeout", type=float, default=10)
    ap.add_argument("--write-timeout", type=float, default=10)
    ap.add_argument("--read-idle-timeout", type=float, default=30)
    ap.add_argument("--pool-timeout", type=float, default=10)
    # total request deadline — REQUIRED: heartbeats keep the read-alive timer fed forever
    ap.add_argument("--total-timeout", type=float, default=120)
    ap.add_argument("--detail", default=None, help="JSONL detail output path")
    ap.add_argument("--use-env-proxy", action="store_true",
                    help="honor http_proxy/all_proxy env vars (default off: load tests target localhost)")
    args = ap.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs("logs", exist_ok=True)
    detail_path = args.detail or f"logs/probe-detail-{stamp}.jsonl"
    limits = httpx.Limits(max_connections=args.concurrency * 2,
                          max_keepalive_connections=args.concurrency)

    recs = []
    # trust_env=False unless explicitly asked: env proxies (often SOCKS) break localhost tests
    client = httpx.AsyncClient(
        base_url=args.base_url,
        headers={"Authorization": f"Bearer {args.key}"},
        limits=limits,
        trust_env=args.use_env_proxy,
    )
    try:
        with open(detail_path, "w") as out:
            sem = asyncio.Semaphore(args.concurrency)
            recs = await asyncio.gather(*[
                one_request(client, args, sem, out, i) for i in range(args.n)
            ])
    finally:
        await client.aclose()

    ok = [r for r in recs if r["result"] == "ok"]
    fail = [r for r in recs if r["result"] == "fail"]
    cancel = [r for r in recs if r["result"] == "cancelled"]
    err_types = {}
    for r in fail:
        err_types[r["error_type"]] = err_types.get(r["error_type"], 0) + 1

    summary = {
        "issued": len(recs), "ok": len(ok), "failed": len(fail), "cancelled": len(cancel),
        "success_rate": round(len(ok) / len(recs), 4) if recs else None,
        "error_types": err_types,
        "ttft_s": {"p50": pct([r["ttft"] for r in ok], 50), "p95": pct([r["ttft"] for r in ok], 95)},
        "total_s": {"p50": pct([r["total"] for r in ok], 50), "p95": pct([r["total"] for r in ok], 95)},
        "detail_file": detail_path,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
