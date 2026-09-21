#!/usr/bin/env python3
"""Pull an official SET SMART Marketplace JSON endpoint with immutable raw capture.

This tool never derives point-in-time availability from an accounting as-of date.
It records retrieval metadata and source payload first. A separate normalization
step must assign/validate available_at before the research panel can consume it.

Supported built-in endpoints are limited to URLs confirmed by SET documentation:
- security_profile
- financial_statement_all
- financial_statement_last_update
Use --url for other documented endpoints.

SET documents a 30 requests/minute rate limit and a minimum 2-second interval between
consecutive requests for Company Fundamental Data; batch orchestration must enforce it.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlencode, urlparse

import urllib.request

ENDPOINTS = {
    "security_profile": "https://marketplace.set.or.th/api/public/reference-data/security-profile",
    "financial_statement_all": "https://marketplace.set.or.th/api/public/financial-statement/all",
    "financial_statement_last_update": "https://marketplace.set.or.th/api/public/financial-statement/last-update-date",
    "fundamental_eod_by_symbol": "https://www.setsmart.com/api/listed-company-api/eod-price-by-symbol",
    "fundamental_eod_all_symbols": "https://www.setsmart.com/api/listed-company-api/eod-price-by-security-type",
    "financial_data_by_symbol": "https://www.setsmart.com/api/listed-company-api/financial-data-and-ratio-by-symbol",
    "financial_data_all_symbols": "https://www.setsmart.com/api/listed-company-api/financial-data-and-ratio",
}


def parse_params(raw: str | None) -> dict:
    if not raw:
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise SystemExit("--params-json must contain a JSON object")
    return {str(k): str(v) for k, v in data.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", choices=sorted(ENDPOINTS), required=False)
    ap.add_argument("--url", required=False)
    ap.add_argument("--params-json", default="{}")
    ap.add_argument("--api-key-env", default="SET_API_KEY")
    ap.add_argument("--output", required=True)
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()

    if bool(args.endpoint) == bool(args.url):
        raise SystemExit("provide exactly one of --endpoint or --url")

    url = ENDPOINTS[args.endpoint] if args.endpoint else args.url
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise SystemExit("SET ingestion requires an HTTPS endpoint")

    api_key = os.getenv(args.api_key_env)
    if not api_key:
        raise SystemExit(
            f"missing API key environment variable {args.api_key_env}; "
            "obtain it through the official SET SMART Marketplace developer flow"
        )

    params = parse_params(args.params_json)
    query = urlencode(params)
    request_url = url + (("&" if "?" in url else "?") + query if query else "")

    retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat()
    req = urllib.request.Request(
        request_url,
        headers={
            "Accept": "application/json",
            "api-key": api_key,
            "User-Agent": "LUNA-set-smartmarketplace-puller/1.0",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            raw = resp.read()
            status = getattr(resp, "status", 200)
            content_type = resp.headers.get("Content-Type", "")
    except Exception as exc:
        raise SystemExit(f"SET API request failed: {exc}") from exc

    if status < 200 or status >= 300:
        raise SystemExit(f"SET API returned HTTP {status}")

    digest = hashlib.sha256(raw).hexdigest()
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw_path = out
    raw_path.write_bytes(raw)

    manifest = {
        "status": "COMPLETED",
        "engine": "luna-set-smartmarketplace-puller-v1",
        "endpoint_name": args.endpoint,
        "source_url": url,
        "query_params": params,
        "http_status": int(status),
        "content_type": content_type,
        "retrieved_at": retrieved_at,
        "raw_sha256": digest,
        "raw_path": str(raw_path),
        "pit_guard": (
            "retrieved_at is audit metadata only. It is NOT substituted for "
            "source availability time. Downstream normalization must preserve "
            "available_at explicitly."
        ),
    }
    manifest_path = raw_path.with_suffix(raw_path.suffix + ".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
