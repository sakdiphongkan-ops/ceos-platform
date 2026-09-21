import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

try:
    from settrade.openapi import Investor
except Exception:  # pragma: no cover
    Investor = None

app = FastAPI(title="LUNA Execution + Market Data Gateway", version="0.3.0")

LIVE_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "")
BROKER_ID = os.getenv("SETTRADE_BROKER_ID", "")
APP_ID = os.getenv("SETTRADE_APP_ID", "")
APP_SECRET = os.getenv("SETTRADE_APP_SECRET", "")
APP_CODE = os.getenv("SETTRADE_APP_CODE", "")

REALTIME_ENABLED = os.getenv("REALTIME_MARKETDATA_ENABLED", "false").lower() == "true"
REALTIME_BOOK = os.getenv("REALTIME_BID_OFFER_ENABLED", "true").lower() == "true"
SYMBOLS = [s.strip().upper() for s in os.getenv("SETTRADE_REALTIME_SYMBOLS", "").split(",") if s.strip()]

RECONNECT_BASE_SEC = max(1.0, float(os.getenv("LUNA_MARKET_RECONNECT_BASE_SEC", "2")))
RECONNECT_MAX_SEC = max(RECONNECT_BASE_SEC, float(os.getenv("LUNA_MARKET_RECONNECT_MAX_SEC", "60")))
STALE_AFTER_SEC = max(5.0, float(os.getenv("LUNA_MARKET_STALE_AFTER_SEC", "20")))
CREDENTIAL_RETRY_SEC = max(5.0, float(os.getenv("LUNA_MARKET_CREDENTIAL_RETRY_SEC", "15")))

SETTRADE_MARKETDATA_CREDENTIALS = {
    "SETTRADE_BROKER_ID": BROKER_ID,
    "SETTRADE_APP_ID": APP_ID,
    "SETTRADE_APP_SECRET": APP_SECRET,
    "SETTRADE_APP_CODE": APP_CODE,
}

def missing_marketdata_credentials():
    return [k for k, v in SETTRADE_MARKETDATA_CREDENTIALS.items() if not v]

_investor = None
_investor_lock = threading.Lock()
_equity = None

_quote_lock = threading.Lock()
_quotes: Dict[str, Dict[str, Any]] = {}

_feed_lock = threading.Lock()
_collectors_started = False
_collector_error: Optional[str] = None
_feed_threads_started = False
_channel_status: Dict[str, Dict[str, Any]] = {
    "price": {"running": False, "restarts": 0, "last_start": None, "last_error": None},
    "book": {"running": False, "restarts": 0, "last_start": None, "last_error": None},
}

def auth(x_luna_gateway: Optional[str]):
    if not GATEWAY_KEY or x_luna_gateway != GATEWAY_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")

def investor_client():
    global _investor
    if Investor is None:
        raise HTTPException(status_code=503, detail="settrade_sdk_unavailable")
    missing = missing_marketdata_credentials()
    if missing:
        raise HTTPException(
            status_code=503,
            detail={"error": "settrade_marketdata_credentials_missing", "missing": missing},
        )
    with _investor_lock:
        if _investor is None:
            _investor = Investor(
                app_id=APP_ID,
                app_secret=APP_SECRET,
                broker_id=BROKER_ID,
                app_code=APP_CODE,
                is_auto_queue=False,
            )
        return _investor

def live_gate():
    if not LIVE_ARMED:
        raise HTTPException(status_code=423, detail="live_trading_not_armed")
    missing = [
        k for k, v in {
            "SETTRADE_BROKER_ID": BROKER_ID,
            "SETTRADE_APP_ID": APP_ID,
            "SETTRADE_APP_SECRET": APP_SECRET,
            "SETTRADE_APP_CODE": APP_CODE,
            "SETTRADE_ACCOUNT_NO": os.getenv("SETTRADE_ACCOUNT_NO", ""),
            "SETTRADE_PIN": os.getenv("SETTRADE_PIN", ""),
        }.items() if not v
    ]
    if missing:
        raise HTTPException(status_code=503, detail={"missing_credentials": missing})
    if Investor is None:
        raise HTTPException(status_code=503, detail="settrade_sdk_unavailable")

def client():
    global _equity
    live_gate()
    if _equity is None:
        inv = investor_client()
        _equity = inv.Equity(account_no=os.getenv("SETTRADE_ACCOUNT_NO", ""))
    return _equity

def _num(value):
    try:
        if value is None or value == "":
            return None
        n = float(value)
        return n if n == n and n not in (float("inf"), float("-inf")) else None
    except Exception:
        return None

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

def _latest_quote_age_sec() -> Optional[float]:
    with _quote_lock:
        timestamps = [
            datetime.fromisoformat(str(q["ts"])).timestamp()
            for q in _quotes.values()
            if q.get("ts")
        ]
    if not timestamps:
        return None
    return max(0.0, time.time() - max(timestamps))

def _channel_snapshot():
    with _feed_lock:
        return {k: dict(v) for k, v in _channel_status.items()}

def _update_quote(symbol: str, data: Dict[str, Any], channel: str):
    global _collector_error
    with _quote_lock:
        quote = dict(_quotes.get(symbol, {
            "symbol": symbol,
            "ts": _now_iso(),
            "bid": None,
            "ask": None,
            "last": None,
            "bid_size": None,
            "ask_size": None,
            "source": "settrade-open-api-realtime",
        }))
        quote["ts"] = _now_iso()
        quote["source"] = "settrade-open-api-realtime"

        if channel == "price":
            quote["last"] = _num(data.get("last"))
        else:
            quote["bid"] = _num(data.get("bid_price1"))
            quote["ask"] = _num(data.get("ask_price1"))
            quote["bid_size"] = _num(data.get("bid_volume1"))
            quote["ask_size"] = _num(data.get("ask_volume1"))

        quote["raw"] = data
        was_new = symbol not in _quotes
        _quotes[symbol] = quote

    _collector_error = None
    if was_new:
        print(f"LUNA_MARKETDATA first_quote symbol={symbol}", flush=True)

def _run_channel(channel: str):
    global _collector_error
    backoff = RECONNECT_BASE_SEC

    while True:
        missing = missing_marketdata_credentials()
        if missing:
            with _feed_lock:
                _channel_status[channel].update(
                    running=False,
                    last_error=f"credentials_missing:{','.join(missing)}",
                )
            _collector_error = f"credentials_missing:{','.join(missing)}"
            time.sleep(CREDENTIAL_RETRY_SEC)
            continue

        if not SYMBOLS:
            with _feed_lock:
                _channel_status[channel].update(
                    running=False,
                    last_error="SETTRADE_REALTIME_SYMBOLS is empty",
                )
            _collector_error = "SETTRADE_REALTIME_SYMBOLS is empty"
            time.sleep(CREDENTIAL_RETRY_SEC)
            continue

        subscriptions = []
        threads = []
        try:
            inv = investor_client()
            mqtt = inv.MQTTWebsocket()

            with _feed_lock:
                state = _channel_status[channel]
                state["running"] = True
                state["restarts"] += 1
                state["last_start"] = _now_iso()
                state["last_error"] = None

            print(
                f"LUNA_MARKETDATA channel_start channel={channel} symbols={len(SYMBOLS)}",
                flush=True,
            )

            for symbol in SYMBOLS:
                try:
                    if channel == "price":
                        sub = mqtt.subscribe_price_info(
                            symbol,
                            on_message=lambda result, subscriber, sym=symbol: _update_quote(
                                sym,
                                result.get("data", result) if isinstance(result, dict) else {},
                                "price",
                            ),
                        )
                    else:
                        sub = mqtt.subscribe_bid_offer(
                            symbol,
                            on_message=lambda result, subscriber, sym=symbol: _update_quote(
                                sym,
                                result.get("data", result) if isinstance(result, dict) else {},
                                "book",
                            ),
                        )
                    subscriptions.append(sub)
                except Exception as exc:
                    with _feed_lock:
                        _channel_status[channel]["last_error"] = f"{symbol}:{exc}"
                    print(
                        f"LUNA_MARKETDATA subscribe_error channel={channel} symbol={symbol} error={exc}",
                        flush=True,
                    )

            for sub in subscriptions:
                thread = threading.Thread(target=sub.start, daemon=True)
                thread.start()
                threads.append(thread)

            if not subscriptions:
                raise RuntimeError(f"{channel}_no_subscriptions_created")

            _collector_error = None

            # Give the first connection time to establish; afterwards a stale
            # feed or fully-dead subscription set forces a reconnect cycle.
            grace_until = time.monotonic() + 30.0
            while True:
                time.sleep(5)
                alive = sum(1 for t in threads if t.is_alive())
                age = _latest_quote_age_sec()

                if alive == 0:
                    raise RuntimeError(f"{channel}_subscriptions_stopped")

                if time.monotonic() >= grace_until:
                    if age is None:
                        raise RuntimeError(f"{channel}_no_quotes_after_start")
                    if age > STALE_AFTER_SEC:
                        raise RuntimeError(f"{channel}_quotes_stale_{age:.1f}s")

        except Exception as exc:
            with _feed_lock:
                _channel_status[channel].update(
                    running=False,
                    last_error=str(exc),
                )
            _collector_error = str(exc)
            print(
                f"LUNA_MARKETDATA reconnect channel={channel} error={exc}",
                flush=True,
            )
            time.sleep(backoff)
            backoff = min(RECONNECT_MAX_SEC, backoff * 2)
        else:
            with _feed_lock:
                _channel_status[channel]["running"] = False
            backoff = RECONNECT_BASE_SEC
            time.sleep(1)

def _start_marketdata():
    global _collectors_started, _feed_threads_started, _collector_error

    if not REALTIME_ENABLED:
        print("LUNA_MARKETDATA disabled", flush=True)
        return

    print(
        f"LUNA_MARKETDATA starting symbols={len(SYMBOLS)} bid_offer={REALTIME_BOOK}",
        flush=True,
    )

    missing = missing_marketdata_credentials()
    if missing:
        _collector_error = f"credentials_missing:{','.join(missing)}"
        print(
            f"LUNA_MARKETDATA credentials_missing names={','.join(missing)}",
            flush=True,
        )
        return

    if not SYMBOLS:
        _collector_error = "SETTRADE_REALTIME_SYMBOLS is empty"
        return

    with _feed_lock:
        if _feed_threads_started:
            return
        _feed_threads_started = True
        _collectors_started = True

    threading.Thread(target=_run_channel, args=("price",), daemon=True).start()
    if REALTIME_BOOK:
        threading.Thread(target=_run_channel, args=("book",), daemon=True).start()

    print(
        f"LUNA_MARKETDATA supervisors_started price=True book={REALTIME_BOOK} target={len(SYMBOLS)}",
        flush=True,
    )

def _credential_watchdog():
    global _collector_error
    while True:
        try:
            if REALTIME_ENABLED and not missing_marketdata_credentials() and SYMBOLS:
                _start_marketdata()
            elif REALTIME_ENABLED:
                missing = missing_marketdata_credentials()
                _collector_error = (
                    f"credentials_missing:{','.join(missing)}"
                    if missing else
                    ("SETTRADE_REALTIME_SYMBOLS is empty" if not SYMBOLS else _collector_error)
                )
            time.sleep(CREDENTIAL_RETRY_SEC)
        except Exception as exc:
            _collector_error = str(exc)
            time.sleep(CREDENTIAL_RETRY_SEC)

@app.on_event("startup")
def startup():
    if REALTIME_ENABLED:
        _start_marketdata()
        threading.Thread(target=_credential_watchdog, daemon=True).start()

class PlaceOrder(BaseModel):
    client_order_id: str = Field(min_length=8, max_length=200)
    symbol: str = Field(min_length=1, max_length=32)
    side: str
    price: float = Field(gt=0)
    volume: int = Field(gt=0)
    reason: str = ""

class CancelOrder(BaseModel):
    client_order_id: str = Field(min_length=8, max_length=200)
    broker_order_id: str = Field(min_length=1, max_length=200)

@app.get("/health")
def health():
    with _quote_lock:
        quote_count = len(_quotes)
    return {
        "ok": True,
        "live_armed": LIVE_ARMED,
        "provider": "settrade-open-api",
        "realtime_marketdata_enabled": REALTIME_ENABLED,
        "realtime_bid_offer_enabled": REALTIME_BOOK,
        "realtime_symbol_target": len(SYMBOLS),
        "realtime_quote_count": quote_count,
        "latest_quote_age_sec": _latest_quote_age_sec(),
        "stale_after_sec": STALE_AFTER_SEC,
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
        "marketdata_missing_credentials": missing_marketdata_credentials(),
        "channel_status": _channel_snapshot(),
        "timestamp": int(time.time()),
    }

@app.get("/quotes")
def quotes(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    with _quote_lock:
        data = list(_quotes.values())
        quote_ages = {
            q["symbol"]: max(
                0.0,
                time.time() - datetime.fromisoformat(str(q["ts"])).timestamp(),
            )
            for q in data
            if q.get("ts")
        }
    return {
        "ok": True,
        "generated_at": _now_iso(),
        "count": len(data),
        "target": len(SYMBOLS),
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
        "marketdata_missing_credentials": missing_marketdata_credentials(),
        "latest_quote_age_sec": _latest_quote_age_sec(),
        "stale_after_sec": STALE_AFTER_SEC,
        "channel_status": _channel_snapshot(),
        "quote_ages_sec": quote_ages,
        "quotes": data,
    }

@app.get("/quote/{symbol}")
def quote(symbol: str, x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    with _quote_lock:
        data = _quotes.get(symbol.upper())
    if data is None:
        raise HTTPException(status_code=404, detail="quote_not_found")
    return {"ok": True, "quote": data}

@app.get("/portfolio")
def portfolio(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    return {"ok": True, "data": eq.get_portfolio()}

@app.post("/place")
def place(payload: PlaceOrder, x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    if payload.side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="invalid_side")

    broker_result = eq.place_order(
        symbol=payload.symbol,
        price=payload.price,
        volume=payload.volume,
        side=payload.side,
        pin=os.getenv("SETTRADE_PIN", ""),
    )

    broker_id = str(
        (broker_result or {}).get("data", {}).get("order_id")
        or (broker_result or {}).get("orderId")
        or (broker_result or {}).get("order_no")
        or uuid.uuid4()
    )

    return {
        "ok": True,
        "client_order_id": payload.client_order_id,
        "broker_order_id": broker_id,
        "submitted_at_ms": int(time.time() * 1000),
        "raw": broker_result,
    }

@app.post("/cancel")
def cancel(payload: CancelOrder, x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    if not hasattr(eq, "cancel_order"):
        raise HTTPException(status_code=501, detail="cancel_order_method_unavailable_in_sdk")
    result = eq.cancel_order(
        order_id=payload.broker_order_id,
        pin=os.getenv("SETTRADE_PIN", ""),
    )
    return {
        "ok": True,
        "client_order_id": payload.client_order_id,
        "broker_order_id": payload.broker_order_id,
        "raw": result,
    }

@app.get("/diagnostics")
def diagnostics(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    with _quote_lock:
        quote_count = len(_quotes)
    return {
        "ok": True,
        "live_armed": LIVE_ARMED,
        "provider": "settrade-open-api",
        "credentials_present": not missing_marketdata_credentials(),
        "missing_credentials": missing_marketdata_credentials(),
        "python_sdk_loaded": Investor is not None,
        "realtime_marketdata_enabled": REALTIME_ENABLED,
        "realtime_bid_offer_enabled": REALTIME_BOOK,
        "realtime_symbol_target": len(SYMBOLS),
        "realtime_quote_count": quote_count,
        "latest_quote_age_sec": _latest_quote_age_sec(),
        "stale_after_sec": STALE_AFTER_SEC,
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
        "channel_status": _channel_snapshot(),
    }
