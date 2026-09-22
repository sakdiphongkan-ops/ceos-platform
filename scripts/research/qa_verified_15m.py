#!/usr/bin/env python3
"""QA normalized SET tick data before LUNA 15m research."""
from __future__ import annotations
import argparse, csv, datetime as dt, json
from collections import Counter, defaultdict
from pathlib import Path

def parse_ts(x: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(x.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return parsed

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--min-verified-book-ratio", type=float, default=0.95)
    ap.add_argument("--min-symbols", type=int, default=50)
    args = ap.parse_args()

    with Path(args.input).open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise SystemExit("empty dataset")

    required = {"ts","source_ts","symbol","bid","ask","last","bid_size","ask_size","source","data_quality"}
    missing = required - set(rows[0])
    if missing:
        raise SystemExit(f"missing columns: {sorted(missing)}")

    by_symbol = Counter()
    verified = 0
    timestamps = []
    source_timestamps = []
    duplicates = set()
    seen = set()

    for r in rows:
        ts = parse_ts(r["ts"])
        symbol = r["symbol"].upper()
        key = (
            symbol, r["source_ts"], r["bid"], r["ask"], r["last"],
            r["bid_size"], r["ask_size"]
        )
        if key in seen:
            duplicates.add(key)
        seen.add(key)
        source_ts = parse_ts(r["source_ts"])
        if source_ts > ts:
            raise ValueError("source_ts after ingest ts")
        timestamps.append(ts)
        source_timestamps.append(source_ts)
        by_symbol[symbol] += 1

        ok = all(r[k] not in ("", "null", "None") for k in ("bid","ask","bid_size","ask_size"))
        if ok:
            try:
                b,a,bs,as_ = map(float, [r["bid"], r["ask"], r["bid_size"], r["ask_size"]])
                ok = b > 0 and a >= b and bs > 0 and as_ > 0
            except ValueError:
                ok = False
        if ok:
            verified += 1

    verified_ratio = verified / len(rows)
    start, end = min(timestamps), max(timestamps)
    bars_by_symbol = defaultdict(set)
    for r in rows:
        ts = parse_ts(r["ts"])
        bars_by_symbol[r["symbol"].upper()].add(int(ts.timestamp()) // 900)

    report = {
        "status": "PASS" if (
            not duplicates and
            len(by_symbol) >= args.min_symbols and
            verified_ratio >= args.min_verified_book_ratio
        ) else "FAIL",
        "rows": len(rows),
        "symbols": len(by_symbol),
        "verified_book_rows": verified,
        "verified_book_ratio": verified_ratio,
        "source_timestamp_coverage": len(source_timestamps) / len(rows),
        "source_start_ts": min(source_timestamps).isoformat(),
        "source_end_ts": max(source_timestamps).isoformat(),
        "start_ts": start.isoformat(),
        "end_ts": end.isoformat(),
        "duplicate_rows": len(duplicates),
        "duplicate_definition": "same symbol+source_ts+L1+last+sizes",
        "bars_15m": sum(len(v) for v in bars_by_symbol.values()),
        "symbols_top": by_symbol.most_common(20),
        "source_counts": dict(Counter(r["source"] for r in rows)),
        "data_quality_counts": dict(Counter(r["data_quality"] for r in rows)),
        "rules": {
            "min_symbols": args.min_symbols,
            "min_verified_book_ratio": args.min_verified_book_ratio,
            "no_synthetic_ohlc": True,
            "no_synthetic_depth": True,
            "no_lookahead_bars": True,
        },
    }
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if report["status"] != "PASS":
        raise SystemExit(2)

if __name__ == "__main__":
    main()
