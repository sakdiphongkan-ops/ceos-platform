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

app = FastAPI(title="LUNA Execution + Market Data Gateway", version="0.2.0")

LIVE_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "")
BROKER_ID = os.getenv("SETTRADE_BROKER_ID", "")
APP_ID = os.getenv("SETTRADE_APP_ID", "")
APP_SECRET = os.getenv("SETTRADE_APP_SECRET", "")
APP_CODE = os.getenv("SETTRADE_APP_CODE", "")

REALTIME_ENABLED = os.getenv("REALTIME_MARKETDATA_ENABLED", "false").lower() == "true"
REALTIME_BOOK = os.getenv("REALTIME_BID_OFFER_ENABLED", "true").lower() == "true"
SYMBOLS = [s.strip().upper() for s in os.getenv("SETTRADE_REALTIME_SYMBOLS", "").split(",") if s.strip()]

_investor = None
_equity = None
_quote_lock = threading.Lock()
_quotes: Dict[str, Dict[str, Any]] = {}
_collectors_started = False
_collector_error: Optional[str] = None
_subscribers = []


def auth(x_luna_gateway: Optional[str]):
    if not GATEWAY_KEY or x_luna_gateway != GATEWAY_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


def investor_client():
    global _investor
    if Investor is None:
        raise HTTPException(status_code=503, detail="settrade_sdk_unavailable")
    if _investor is None:
        if not all([BROKER_ID, APP_ID, APP_SECRET, APP_CODE]):
            raise HTTPException(status_code=503, detail="settrade_marketdata_credentials_missing")
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
    missing = [k for k,v in {
        "SETTRADE_BROKER_ID": BROKER_ID,
        "SETTRADE_APP_ID": APP_ID,
        "SETTRADE_APP_SECRET": APP_SECRET,
        "SETTRADE_APP_CODE": APP_CODE,
        "SETTRADE_ACCOUNT_NO": os.getenv("SETTRADE_ACCOUNT_NO", ""),
        "SETTRADE_PIN": os.getenv("SETTRADE_PIN", ""),
    }.items() if not v]
    if missing:
        raise HTTPException(status_code=503, detail={"missing_credentials": missing})
    if Investor is None:
        raise HTTPException(status_code=503, detail="settrade_sdk_unavailable")


def client():
    global _equity
    live_gate()
    if _equity is None:
        _investor = investor_client()
        _equity = _investor.Equity(account_no=os.getenv("SETTRADE_ACCOUNT_NO", ""))
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


def _update_quote(symbol: str, data: Dict[str, Any], channel: str):
    quote = _quotes.get(symbol, {
        "symbol": symbol,
        "ts": _now_iso(),
        "bid": None,
        "ask": None,
        "last": None,
        "bid_size": None,
        "ask_size": None,
        "source": "settrade-open-api-realtime",
    })
    quote["ts"] = _now_iso()
    quote["source"] = "settrade-open-api-realtime"

    if channel == "price":
        quote["last"] = _num(data.get("last"))
    elif channel == "book":
        quote["bid"] = _num(data.get("bid_price1"))
        quote["ask"] = _num(data.get("ask_price1"))
        quote["bid_size"] = _num(data.get("bid_volume1"))
        quote["ask_size"] = _num(data.get("ask_volume1"))

    quote["raw"] = data
    with _quote_lock:
        _quotes[symbol] = quote


def _start_marketdata():
    global _collectors_started, _collector_error
    if not REALTIME_ENABLED:
        return
    if _collectors_started:
        return
    if not SYMBOLS:
        _collector_error = "SETTRADE_REALTIME_SYMBOLS is empty"
        return
    try:
        inv = investor_client()
        price_mqtt = inv.MQTTWebsocket()
        _subscribers.append(price_mqtt)

        for symbol in SYMBOLS:
            try:
                sub = price_mqtt.subscribe_price_info(
                    symbol,
                    on_message=lambda result, subscriber, sym=symbol: _update_quote(
                        sym, result.get("data", result) if isinstance(result, dict) else {}, "price"
                    ),
                )
                _subscribers.append(sub)
                threading.Thread(target=sub.start, daemon=True).start()
            except Exception as exc:
                _collector_error = f"price:{symbol}:{exc}"

        if REALTIME_BOOK:
            book_mqtt = inv.MQTTWebsocket()
            _subscribers.append(book_mqtt)
            for symbol in SYMBOLS:
                try:
                    sub = book_mqtt.subscribe_bid_offer(
                        symbol,
                        on_message=lambda result, subscriber, sym=symbol: _update_quote(
                            sym, result.get("data", result) if isinstance(result, dict) else {}, "book"
                        ),
                    )
                    _subscribers.append(sub)
                    threading.Thread(target=sub.start, daemon=True).start()
                except Exception as exc:
                    _collector_error = f"book:{symbol}:{exc}"

        _collectors_started = True
    except Exception as exc:
        _collector_error = str(exc)


@app.on_event("startup")
def startup():
    if REALTIME_ENABLED:
        threading.Thread(target=_start_marketdata, daemon=True).start()


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
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
        "timestamp": int(time.time()),
    }


@app.get("/quotes")
def quotes(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    with _quote_lock:
        data = list(_quotes.values())
    return {
        "ok": True,
        "generated_at": _now_iso(),
        "count": len(data),
        "target": len(SYMBOLS),
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
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

    broker_id = str((broker_result or {}).get("data", {}).get("order_id")
                    or (broker_result or {}).get("orderId")
                    or (broker_result or {}).get("order_no")
                    or uuid.uuid4())

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
    result = eq.cancel_order(order_id=payload.broker_order_id, pin=os.getenv("SETTRADE_PIN", ""))
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
        "credentials_present": all([BROKER_ID, APP_ID, APP_SECRET, APP_CODE]),
        "python_sdk_loaded": Investor is not None,
        "realtime_marketdata_enabled": REALTIME_ENABLED,
        "realtime_bid_offer_enabled": REALTIME_BOOK,
        "realtime_symbol_target": len(SYMBOLS),
        "realtime_quote_count": quote_count,
        "collector_started": _collectors_started,
        "collector_error": _collector_error,
    }
