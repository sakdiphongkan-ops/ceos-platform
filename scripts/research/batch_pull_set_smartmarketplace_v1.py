#!/usr/bin/env python3
"""Batch pull documented SET SMART Marketplace endpoints with rate-limit protection."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pull_set_smartmarketplace_v1 import ENDPOINTS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--api-key-env", default="SET_API_KEY")
    ap.add_argument("--interval-seconds", type=float, default=2.1)
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()

    key = os.getenv(args.api_key_env)
    if not key:
        raise SystemExit(f"missing API key environment variable {args.api_key_env}")

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    if not isinstance(plan, list):
        raise SystemExit("plan must be a JSON array")

    outdir = Path(args.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = []

    for i, item in enumerate(plan):
        endpoint = item.get("endpoint")
        if endpoint not in ENDPOINTS:
            raise SystemExit(f"unsupported endpoint in plan: {endpoint}")
        params = {str(k): str(v) for k, v in item.get("params", {}).items()}
        filename = item.get("filename") or f"{i:05d}_{endpoint}.json"
        url = ENDPOINTS[endpoint]
        query = urllib.parse.urlencode(params)
        request_url = url + (("?" + query) if query else "")
        req = urllib.request.Request(
            request_url,
            headers={
                "Accept": "application/json",
                "api-key": key,
                "User-Agent": "LUNA-set-smartmarketplace-batch/1.0",
            },
            method="GET",
        )

        retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat()
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                raw = resp.read()
                status = int(getattr(resp, "status", 200))
        except Exception as exc:
            manifest.append({
                "index": i, "endpoint": endpoint, "params": params,
                "status": "FAILED", "error": str(exc),
            })
            raise SystemExit(f"request {i} failed: {exc}") from exc

        path = outdir / filename
        path.write_bytes(raw)
        manifest.append({
            "index": i,
            "endpoint": endpoint,
            "params": params,
            "retrieved_at": retrieved_at,
            "http_status": status,
            "raw_path": str(path),
        })

        if i + 1 < len(plan):
            time.sleep(max(args.interval_seconds, 2.0))

    summary = {
        "status": "COMPLETED",
        "engine": "luna-set-smartmarketplace-batch-v1",
        "requests": len(manifest),
        "interval_seconds": float(max(args.interval_seconds, 2.0)),
        "rate_limit_guard": "minimum 2 seconds between consecutive requests",
        "retrievals": manifest,
    }
    (outdir / "_batch-manifest.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
