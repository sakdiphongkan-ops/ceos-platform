#!/usr/bin/env python3
"""
Normalize an official SET Tick Data file into LUNA's auditable quote schema.
The exact SET file specification is intentionally supplied as a column map.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, zipfile
from pathlib import Path
from typing import Any

REQUIRED = ["ts", "symbol", "bid", "ask", "last", "bid_size", "ask_size"]
NULLS = {"", "null", "none", "nan", "na", "n/a", "-"}

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def read_csv_text(text: str, delimiter: str) -> list[dict[str, str]]:
    return list(csv.DictReader(text.splitlines(), delimiter=delimiter))

def open_source(path: Path, delimiter: str) -> tuple[list[dict[str, str]], str]:
    if not zipfile.is_zipfile(path):
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f, delimiter=delimiter)), path.name
    with zipfile.ZipFile(path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith((".csv", ".txt"))]
        if not candidates:
            raise SystemExit("No CSV/TXT file found in archive")
        selected = candidates[0]
        with zf.open(selected) as raw:
            return read_csv_text(raw.read().decode("utf-8-sig"), delimiter), selected

def val(row: dict[str, str], key: str, mapping: dict[str, str]) -> str | None:
    source = mapping.get(key)
    if not source:
        raise SystemExit(f"Missing explicit mapping for required field: {key}")
    raw = row.get(source)
    if raw is None:
        raise SystemExit(f"Mapped source column not found: {source}")
    x = str(raw).strip()
    return None if x.lower() in NULLS else x

def num(x: str | None, field: str, row_no: int) -> float | None:
    if x is None:
        return None
    try:
        return float(str(x).replace(",", ""))
    except ValueError as exc:
        raise SystemExit(f"Row {row_no}: invalid numeric {field}={x!r}") from exc

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--mapping-json", required=True)
    ap.add_argument("--delimiter", default=",")
    ap.add_argument("--source-label", default="SET_OFFICIAL_TICK")
    ap.add_argument("--data-quality", default="verified")
    ap.add_argument("--market", default="SET")
    args = ap.parse_args()

    source = Path(args.input)
    out = Path(args.output)
    mapping = json.loads(args.mapping_json)
    if not isinstance(mapping, dict):
        raise SystemExit("--mapping-json must be an object")
    missing = [x for x in REQUIRED if x not in mapping]
    if missing:
        raise SystemExit(f"Missing required mappings: {missing}")

    rows, inner_name = open_source(source, args.delimiter)
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for i, row in enumerate(rows, start=2):
        ts = val(row, "ts", mapping)
        symbol = val(row, "symbol", mapping)
        if not ts or not symbol:
            raise SystemExit(f"Row {i}: timestamp and symbol are required")

        bid = num(val(row, "bid", mapping), "bid", i)
        ask = num(val(row, "ask", mapping), "ask", i)
        last = num(val(row, "last", mapping), "last", i)
        bid_size = num(val(row, "bid_size", mapping), "bid_size", i)
        ask_size = num(val(row, "ask_size", mapping), "ask_size", i)

        if last is None or last <= 0:
            raise SystemExit(f"Row {i}: last must be > 0")
        key = (symbol.upper(), ts)
        if key in seen:
            raise SystemExit(f"Duplicate symbol/timestamp: {key}")
        seen.add(key)

        if bid is not None and bid < 0:
            raise SystemExit(f"Row {i}: bid < 0")
        if ask is not None and ask < 0:
            raise SystemExit(f"Row {i}: ask < 0")
        if bid is not None and ask is not None and ask < bid:
            raise SystemExit(f"Row {i}: ask < bid")
        if bid_size is not None and bid_size < 0:
            raise SystemExit(f"Row {i}: bid_size < 0")
        if ask_size is not None and ask_size < 0:
            raise SystemExit(f"Row {i}: ask_size < 0")

        normalized.append({
            "ts": ts,
            "source_ts": ts,
            "symbol": symbol.upper().replace(".BK", ""),
            "market": args.market,
            "bid": bid,
            "ask": ask,
            "last": last,
            "bid_size": int(bid_size) if bid_size is not None and bid_size.is_integer() else bid_size,
            "ask_size": int(ask_size) if ask_size is not None and ask_size.is_integer() else ask_size,
            "source": args.source_label,
            "data_quality": (
                "verified"
                if bid is not None and ask is not None and
                bid_size is not None and ask_size is not None and
                bid > 0 and ask > 0 and bid_size > 0 and ask_size > 0
                else "unverified"
            ),
        })

    normalized.sort(key=lambda x: (x["ts"], x["symbol"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(normalized[0].keys()) if normalized else REQUIRED + ["market","source","data_quality"]
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(normalized)

    manifest = {
        "schema_version": "luna-set-tick-v1",
        "source": args.source_label,
        "input_file": str(source),
        "input_sha256": sha256(source),
        "inner_file": inner_name,
        "output_file": str(out),
        "output_sha256": sha256(out),
        "rows": len(normalized),
        "symbols": len({r["symbol"] for r in normalized}),
        "verified_book_rows": sum(
            r["bid"] is not None and r["ask"] is not None and
            r["bid_size"] is not None and r["ask_size"] is not None and
            r["bid"] > 0 and r["ask"] > 0 and
            r["bid_size"] > 0 and r["ask_size"] > 0 for r in normalized
        ),
        "mapping": mapping,
        "contract": {
            "no_synthetic_depth": True,
            "no_price_only_entry_evidence": True,
            "timestamp_and_symbol_required": True,
            "source_timestamp_preserved": True,
            "duplicate_symbol_timestamp_rejected": True,
        },
    }
    out.with_suffix(out.suffix + ".manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
