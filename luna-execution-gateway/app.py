import hashlib
import os
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

try:
    from settrade.openapi import Investor
except Exception:  # pragma: no cover
    Investor = None

app = FastAPI(title="LUNA Execution Gateway", version="0.1.0")

LIVE_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "")
BROKER_ID = os.getenv("SETTRADE_BROKER_ID", "")
APP_ID = os.getenv("SETTRADE_APP_ID", "")
APP_SECRET = os.getenv("SETTRADE_APP_SECRET", "")
APP_CODE = os.getenv("SETTRADE_APP_CODE", "")
ACCOUNT_NO = os.getenv("SETTRADE_ACCOUNT_NO", "")
PIN = os.getenv("SETTRADE_PIN", "")

_investor = None
_equity = None

def auth(x_luna_gateway: Optional[str]):
    if not GATEWAY_KEY or x_luna_gateway != GATEWAY_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")

def live_gate():
    if not LIVE_ARMED:
        raise HTTPException(status_code=423, detail="live_trading_not_armed")
    missing = [k for k,v in {
        "SETTRADE_BROKER_ID": BROKER_ID,
        "SETTRADE_APP_ID": APP_ID,
        "SETTRADE_APP_SECRET": APP_SECRET,
        "SETTRADE_APP_CODE": APP_CODE,
        "SETTRADE_ACCOUNT_NO": ACCOUNT_NO,
        "SETTRADE_PIN": PIN,
    }.items() if not v]
    if missing:
        raise HTTPException(status_code=503, detail={"missing_credentials": missing})
    if Investor is None:
        raise HTTPException(status_code=503, detail="settrade_sdk_unavailable")

def client():
    global _investor, _equity
    live_gate()
    if _equity is None:
        _investor = Investor(
            app_id=APP_ID,
            app_secret=APP_SECRET,
            broker_id=BROKER_ID,
            app_code=APP_CODE,
            is_auto_queue=False,
        )
        _equity = _investor.Equity(account_no=ACCOUNT_NO)
    return _equity

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
    return {
        "ok": True,
        "live_armed": LIVE_ARMED,
        "provider": "settrade-open-api",
        "timestamp": int(time.time()),
    }

@app.get("/portfolio")
def portfolio(x_luna_gateway: str | None = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    return {"ok": True, "data": eq.get_portfolio()}

@app.post("/place")
def place(payload: PlaceOrder, x_luna_gateway: str | None = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    if payload.side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="invalid_side")

    if payload.volume <= 0:
        raise HTTPException(status_code=400, detail="invalid_volume")

    broker_result = eq.place_order(
        symbol=payload.symbol,
        price=payload.price,
        volume=payload.volume,
        side=payload.side,
        pin=PIN,
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
def cancel(payload: CancelOrder, x_luna_gateway: str | None = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    if not hasattr(eq, "cancel_order"):
        raise HTTPException(status_code=501, detail="cancel_order_method_unavailable_in_sdk")
    result = eq.cancel_order(order_id=payload.broker_order_id, pin=PIN)
    return {
        "ok": True,
        "client_order_id": payload.client_order_id,
        "broker_order_id": payload.broker_order_id,
        "raw": result,
    }

@app.get("/diagnostics")
def diagnostics(x_luna_gateway: str | None = Header(default=None)):
    auth(x_luna_gateway)
    return {
        "ok": True,
        "live_armed": LIVE_ARMED,
        "provider": "settrade-open-api",
        "credentials_present": all([BROKER_ID, APP_ID, APP_SECRET, APP_CODE, ACCOUNT_NO, PIN]),
        "python_sdk_loaded": Investor is not None,
    }
