from __future__ import annotations
from datetime import datetime
from typing import Any

def broker_native_time_ms(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value,(int,float)):
        n=float(value)
        if n > 10_000_000_000_000:
            n /= 1000
        return int(n) if n == n and n > 0 else None
    if isinstance(value,str):
        s=value.strip()
        try:
            n=float(s)
            if n > 10_000_000_000_000:
                n /= 1000
            if n == n and n > 0:
                return int(n)
        except ValueError:
            pass
        try:
            parsed=datetime.fromisoformat(s.replace("Z","+00:00"))
            return int(parsed.timestamp()*1000)
        except ValueError:
            return None
    return None

def extract_broker_native_submitted_at_ms(payload: Any) -> int | None:
    if not isinstance(payload,dict):
        return None
    roots=[]
    data=payload.get("data")
    if isinstance(data,dict):
        roots.append(data)
    roots.append(payload)
    keys=("submitted_at_ms","submittedAtMs","submitted_at","submittedAt","created_at_ms","createdAtMs","created_at","createdAt","timestamp_ms","timestamp")
    for root in roots:
        for key in keys:
            parsed=broker_native_time_ms(root.get(key))
            if parsed is not None:
                return parsed
    return None
