import asyncio
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, Optional
from importlib.metadata import PackageNotFoundError, version as package_version
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

try:
    import websockets
except Exception:
    websockets = None

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from broker_timing import extract_broker_native_submitted_at_ms

try:
    from settrade_v2 import Investor
    from settrade_v2.config import config as settrade_config
except Exception:  # pragma: no cover
    Investor = None
    settrade_config = {}

APP_VERSION = "0.7.2"
RELEASE_SOURCE_REVISION = (
    os.getenv("LUNA_DEPLOY_SOURCE_SHA")
    or os.getenv("GITHUB_SHA")
    or os.getenv("RAILWAY_GIT_COMMIT_SHA")
    or "unknown"
)
RAILWAY_REPORTED_REVISION = os.getenv("RAILWAY_GIT_COMMIT_SHA") or "unknown"
EXPECTED_SOURCE_REVISION = os.getenv("LUNA_EXPECTED_SOURCE_SHA", "").strip()
if EXPECTED_SOURCE_REVISION and RELEASE_SOURCE_REVISION != EXPECTED_SOURCE_REVISION:
    raise RuntimeError(
        f"LUNA_SOURCE_REVISION_MISMATCH:expected={EXPECTED_SOURCE_REVISION}:release={RELEASE_SOURCE_REVISION}:railway={RAILWAY_REPORTED_REVISION}"
    )
app = FastAPI(title="LUNA Execution + Market Data Gateway", version=APP_VERSION)
PUBLIC_STREAM_RELEASE = "public_quote_stream_v1"
print(
    f"LUNA_GATEWAY_SOURCE_REVISION revision={RELEASE_SOURCE_REVISION} "
    f"railway_reported={RAILWAY_REPORTED_REVISION} release={PUBLIC_STREAM_RELEASE}",
    flush=True,
)

LIVE_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "")
MARKETDATA_INGEST_KEY = os.getenv("LUNA_MARKETDATA_INGEST_KEY") or GATEWAY_KEY


GATEWAY_ORDER_GATE_ENABLED = os.getenv("LUNA_GATEWAY_ORDER_GATE_ENABLED", "false").lower() == "true"
GATEWAY_KILL_SWITCH = os.getenv("LUNA_GATEWAY_KILL_SWITCH", "true").lower() == "true"
GATEWAY_MAX_ORDER_NOTIONAL = max(1.0, float(os.getenv("LUNA_GATEWAY_MAX_ORDER_NOTIONAL", "50000")))
GATEWAY_MAX_ORDERS_PER_MINUTE = max(1, int(os.getenv("LUNA_GATEWAY_MAX_ORDERS_PER_MINUTE", "2")))
GATEWAY_MAX_QUOTE_AGE_SEC = max(0.1, float(os.getenv("LUNA_GATEWAY_MAX_QUOTE_AGE_SEC", "2")))
GATEWAY_MAX_PRICE_DEVIATION_BPS = max(1.0, float(os.getenv("LUNA_GATEWAY_MAX_PRICE_DEVIATION_BPS", "75")))
GATEWAY_BROKER_FAILURE_TRIP_COUNT = max(1, int(os.getenv("LUNA_GATEWAY_BROKER_FAILURE_TRIP_COUNT", "3")))
GATEWAY_CIRCUIT_RESET_KEY = os.getenv("LUNA_GATEWAY_CIRCUIT_RESET_KEY", "")
LUNA_LIVE_MIN_REALTIME_COVERAGE = min(1.0, max(0.0, float(os.getenv("LUNA_LIVE_MIN_REALTIME_COVERAGE", "0.99"))))

_safety_lock = threading.Lock()
_broker_failure_streak = 0
_broker_circuit_tripped = False
_broker_last_failure: Optional[str] = None
_seen_client_orders: set[str] = set()
_order_attempt_timestamps: list[float] = []

# Market-data providers are selected automatically unless explicitly forced.
# Production policy:
#   1) SETTRADE Open API (primary)
#   2) Official SET Market Data API (authorized backup, only when subscribed/configured)
#   3) TopTrader sources (paper/continuity fallback; never authorizes live by itself)
#   4) TradingView public fallback (paper-only)
PRIMARY_PROVIDER = os.getenv("LUNA_PRIMARY_MARKETDATA_PROVIDER", "SETTRADE").upper()
BACKUP_VENDOR = os.getenv("LUNA_BACKUP_VENDOR", "SET_API").upper()
BACKUP_VENDOR_MODE = os.getenv("LUNA_BACKUP_VENDOR_MODE", "API_KEY").upper()

PROVIDER_MODE = os.getenv("LUNA_MARKETDATA_PROVIDER", PRIMARY_PROVIDER).upper()
SET_API_KEY = (
    os.getenv("SET_MARKETDATA_API_KEY")
    or os.getenv("SET_MARKETPLACE_API_KEY")
    or os.getenv("SET_API_KEY")
    or ""
)
SET_API_BASE = os.getenv(
    "SET_MARKETDATA_API_BASE",
    "https://marketplace.set.or.th/api/public/realtime-data/stock",
)
SET_API_POLL_SEC = max(1.0, float(os.getenv("SET_MARKETDATA_POLL_SEC", "2")))
SET_API_TIMEOUT_SEC = max(2.0, float(os.getenv("SET_MARKETDATA_TIMEOUT_SEC", "8")))
TOPTRADER_ENABLED = os.getenv("LUNA_TOPTRADER_BACKUP_ENABLED", "true").lower() == "true"
TOPTRADER_API_BASE = os.getenv("LUNA_TOPTRADER_API_BASE", "https://api.toptrader.co.th/v1/market/tick")
TOPTRADER_SYMBOLS_BASE = os.getenv("LUNA_TOPTRADER_SYMBOLS_BASE", "https://api.toptrader.co.th/v1/market/symbols")
TOPTRADER_WS_ENABLED = os.getenv("LUNA_TOPTRADER_WS_ENABLED", "true").lower() == "true"
TOPTRADER_WS_BASE = os.getenv("LUNA_TOPTRADER_WS_BASE", "wss://ws.toptrader.co.th/market")
TOPTRADER_WS_CHUNK_SIZE = max(1, min(512, int(os.getenv("LUNA_TOPTRADER_WS_CHUNK_SIZE", "128"))))
TOPTRADER_WS_RECONNECT_SEC = max(1.0, float(os.getenv("LUNA_TOPTRADER_WS_RECONNECT_SEC", "3")))
TOPTRADER_POLL_SEC = max(1.0, float(os.getenv("LUNA_TOPTRADER_POLL_SEC", "2")))
TOPTRADER_TIMEOUT_SEC = max(2.0, float(os.getenv("LUNA_TOPTRADER_TIMEOUT_SEC", "8")))
TOPTRADER_REST_PUMP_ENABLED = os.getenv("LUNA_TOPTRADER_REST_PUMP_ENABLED", "true").lower() == "true"

# Paper-only public fallback. TradingView's public Thailand screener is not
# treated as exchange-certified real-time data; it is used only to keep the
# Paper Trading pipeline alive when licensed providers are unavailable.
TRADINGVIEW_URL = os.getenv("TRADINGVIEW_SCANNER_URL", "https://scanner.tradingview.com/thailand/scan")
TRADINGVIEW_POLL_SEC = max(2.0, float(os.getenv("TRADINGVIEW_POLL_SEC", "5")))
PUBLIC_FALLBACK_ENABLED = (
    os.getenv("LUNA_PUBLIC_MARKETDATA_FALLBACK", "false").lower() == "true"
    and not LIVE_ARMED
)

BROKER_ID = os.getenv("LUNA_SETTRADE_BROKER_ID") or os.getenv("SETTRADE_BROKER_ID", "")
APP_ID = os.getenv("LUNA_SETTRADE_APP_ID") or os.getenv("SETTRADE_APP_ID", "")
APP_SECRET = os.getenv("LUNA_SETTRADE_APP_SECRET") or os.getenv("SETTRADE_APP_SECRET", "")
APP_CODE = os.getenv("LUNA_SETTRADE_APP_CODE") or os.getenv("SETTRADE_APP_CODE", "")
SETTRADE_ENV = (os.getenv("LUNA_SETTRADE_ENV") or os.getenv("SETTRADE_ENV", "prod")).lower()
EXECUTION_LEDGER_URL = os.getenv("LUNA_EXECUTION_LEDGER_URL", "https://wigzicwgcsrhdummrbjx.supabase.co/functions/v1/luna-execution-gateway").rstrip("/")
EXECUTION_LEDGER_KEY = os.getenv("LUNA_AGENT_KEY", "")
EXECUTION_LEDGER_ENABLED = os.getenv("LUNA_EXECUTION_LEDGER_ENABLED", "false").lower() == "true"
ORDER_AUTH_KEY = os.getenv("LUNA_ORDER_AUTH_KEY", "")
try:
    SETTRADE_SDK_VERSION = package_version("settrade-v2")
except PackageNotFoundError:  # pragma: no cover
    SETTRADE_SDK_VERSION = "unavailable"

try:
    if isinstance(settrade_config, dict):
        settrade_config["environment"] = SETTRADE_ENV
except Exception:
    pass

REALTIME_ENABLED = os.getenv("REALTIME_MARKETDATA_ENABLED", "false").lower() == "true"
REALTIME_BOOK = os.getenv("REALTIME_BID_OFFER_ENABLED", "true").lower() == "true"
INGEST_ENABLED = bool(MARKETDATA_INGEST_KEY)
EXTERNAL_BRIDGE_MAX_AGE_SEC = max(5.0, float(os.getenv("LUNA_EXTERNAL_BRIDGE_MAX_AGE_SEC", "10")))
_external_bridge_last_ts = 0.0
PUBLIC_STREAM_ENABLED = os.getenv("LUNA_PUBLIC_STREAM_ENABLED", "true").lower() == "true"
PUBLIC_STREAM_MAX_CLIENTS = max(1, int(os.getenv("LUNA_PUBLIC_STREAM_MAX_CLIENTS", "50")))
SYMBOLS = [s.strip().upper() for s in os.getenv("SETTRADE_REALTIME_SYMBOLS", "").split(",") if s.strip()]

RECONNECT_BASE_SEC = max(1.0, float(os.getenv("LUNA_MARKET_RECONNECT_BASE_SEC", "2")))
RECONNECT_MAX_SEC = max(RECONNECT_BASE_SEC, float(os.getenv("LUNA_MARKET_RECONNECT_MAX_SEC", "60")))
STALE_AFTER_SEC = max(5.0, float(os.getenv("LUNA_MARKET_STALE_AFTER_SEC", "20")))
CREDENTIAL_RETRY_SEC = max(5.0, float(os.getenv("LUNA_MARKET_CREDENTIAL_RETRY_SEC", "10")))

SETTRADE_MARKETDATA_CREDENTIALS = {
    "SETTRADE_BROKER_ID": BROKER_ID,
    "SETTRADE_APP_ID": APP_ID,
    "SETTRADE_APP_SECRET": APP_SECRET,
    "SETTRADE_APP_CODE": APP_CODE,
}


class ProviderUnavailable(RuntimeError):
    pass


def missing_settrade_credentials():
    return [k for k, v in SETTRADE_MARKETDATA_CREDENTIALS.items() if not v]


def set_api_configured() -> bool:
    return bool(SET_API_KEY)


def settrade_configured() -> bool:
    return not missing_settrade_credentials() and Investor is not None


_investor = None
_investor_lock = threading.Lock()
_equity = None

_quote_lock = threading.Lock()
_quotes: Dict[str, Dict[str, Any]] = {}
_stream_lock = threading.Lock()
_stream_clients: Dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = {}
_public_stream_lock = threading.Lock()
_public_stream_clients: Dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = {}

_feed_lock = threading.Lock()
_collector_started = False
_collector_error: Optional[str] = None
_supervisor_started = False
_selected_provider: Optional[str] = None
_provider_restarts = 0
_provider_failures: Dict[str, int] = {"SET_API": 0, "SETTRADE": 0, "TOPTRADER_WS": 0, "TOPTRADER_PUBLIC": 0}
_toptrader_ws_lock = threading.Lock()
_toptrader_ws_seen: set[str] = set()
_toptrader_supported_symbols: set[str] = set()
_toptrader_symbols_loaded_at = 0.0

_channel_status: Dict[str, Dict[str, Any]] = {
    "price": {"running": False, "restarts": 0, "last_start": None, "last_error": None},
    "book": {"running": False, "restarts": 0, "last_start": None, "last_error": None},
}


def auth(x_luna_gateway: Optional[str]):
    if not GATEWAY_KEY or x_luna_gateway != GATEWAY_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


def order_auth(x_luna_gateway: Optional[str], x_luna_order: Optional[str]):
    auth(x_luna_gateway)
    if not ORDER_AUTH_KEY or x_luna_order != ORDER_AUTH_KEY:
        raise HTTPException(status_code=401, detail="order_authorization_required")


def execution_ledger_configured() -> bool:
    return EXECUTION_LEDGER_ENABLED and bool(EXECUTION_LEDGER_URL) and bool(EXECUTION_LEDGER_KEY)


def _ledger_request(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not execution_ledger_configured():
        raise ProviderUnavailable("execution_ledger_unconfigured")
    body = dict(payload)
    body["action"] = action
    request = Request(
        EXECUTION_LEDGER_URL,
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "x-luna-agent": EXECUTION_LEDGER_KEY,
        },
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    try:
        with urlopen(request, timeout=5.0) as response:
            raw = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ProviderUnavailable(f"execution_ledger_http_{exc.code}:{detail}") from exc
    except URLError as exc:
        raise ProviderUnavailable(f"execution_ledger_network:{exc.reason}") from exc
    except Exception as exc:
        raise ProviderUnavailable(f"execution_ledger_request:{exc}") from exc
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailable("execution_ledger_invalid_json") from exc
    if status >= 400:
        raise ProviderUnavailable(f"execution_ledger_status_{status}:{result}")
    return result


def _ledger_admit(payload: Any) -> Dict[str, Any]:
    result = _ledger_request("admit", {
        "session_id": str(payload.session_id),
        "strategy_version": str(payload.strategy_version),
        "mode": "live",
        "symbol": str(payload.symbol).strip().upper(),
        "side": str(payload.side).upper(),
        "qty": int(payload.volume),
        "limit_price": float(payload.price),
        "client_order_id": str(payload.client_order_id),
        "idempotency_key": str(payload.client_order_id),
    })
    if not result.get("admitted"):
        status = 409 if result.get("decision") == "DUPLICATE" else 423
        code = "persistent_idempotency_replay" if status == 409 else "persistent_execution_admission_denied"
        raise HTTPException(status_code=status, detail={"code": code, "ledger": result})
    if not result.get("request_id"):
        raise ProviderUnavailable("execution_ledger_missing_request_id")
    return result


def _ledger_mark_submitted(request_id: str, broker_order_id: str, broker_result: Dict[str, Any]) -> Dict[str, Any]:
    return _ledger_request("mark_submitted", {
        "request_id": request_id,
        "broker_order_id": broker_order_id,
        "ack_kind": "broker_native" if extract_broker_native_submitted_at_ms(broker_result) is not None else "gateway_response",
        "broker_native_submitted_at_ms": extract_broker_native_submitted_at_ms(broker_result),
    })


def _ledger_mark_denied(request_id: str, reason: str) -> Dict[str, Any]:
    return _ledger_request("mark_denied", {"request_id": request_id, "reason": reason})


def _ledger_lookup_broker_order(broker_order_id: str) -> Dict[str, Any]:
    return _ledger_request("lookup", {"broker_order_id": broker_order_id})


def investor_client():
    global _investor
    if Investor is None:
        raise ProviderUnavailable("settrade_sdk_unavailable")
    missing = missing_settrade_credentials()
    if missing:
        raise ProviderUnavailable(f"settrade_credentials_missing:{','.join(missing)}")
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


def realtime_marketdata_client(inv):
    """Return the realtime market-data connection supported by the installed Settrade SDK."""
    if hasattr(inv, "RealtimeDataConnection"):
        try:
            return inv.RealtimeDataConnection()
        except Exception as exc:
            print(
                f"LUNA_MARKETDATA realtime_connection_fallback error={exc}",
                flush=True,
            )
    if hasattr(inv, "MQTTWebsocket"):
        return inv.MQTTWebsocket()
    raise ProviderUnavailable("settrade_realtime_connection_unavailable")


def historical_marketdata_client(inv):
    """Return Settrade historical market-data client."""
    if not hasattr(inv, "MarketData"):
        raise ProviderUnavailable("settrade_marketdata_client_unavailable")
    try:
        return inv.MarketData()
    except Exception as exc:
        raise ProviderUnavailable(f"settrade_marketdata_client_error:{exc}") from exc


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




def _record_broker_failure(reason: str):
    global _broker_failure_streak, _broker_circuit_tripped, _broker_last_failure
    with _safety_lock:
        _broker_failure_streak += 1
        _broker_last_failure = str(reason)
        if _broker_failure_streak >= GATEWAY_BROKER_FAILURE_TRIP_COUNT:
            _broker_circuit_tripped = True


def _record_broker_success():
    global _broker_failure_streak, _broker_last_failure
    with _safety_lock:
        _broker_failure_streak = 0
        _broker_last_failure = None


def _safety_snapshot():
    with _safety_lock:
        return {
            "order_gate_enabled": GATEWAY_ORDER_GATE_ENABLED,
            "kill_switch": GATEWAY_KILL_SWITCH,
            "broker_failure_streak": _broker_failure_streak,
            "broker_circuit_tripped": _broker_circuit_tripped,
            "broker_last_failure": _broker_last_failure,
            "seen_client_orders": len(_seen_client_orders),
            "order_attempts_last_minute": len(_order_attempt_timestamps),
        }


def _prune_order_attempts(now: float):
    cutoff = now - 60.0
    while _order_attempt_timestamps and _order_attempt_timestamps[0] < cutoff:
        _order_attempt_timestamps.pop(0)


def _quote_matches_selected_provider(quote: Dict[str, Any]) -> bool:
    source = str(quote.get("source") or "").lower()
    if _selected_provider == "SETTRADE":
        return source.startswith("settrade")
    if _selected_provider == "SET_API":
        return source.startswith("set-market-data-api")
    return False


def _quote_coverage_snapshot() -> Dict[str, Any]:
    """Return fresh-quote coverage evidence for the configured realtime universe."""
    now = time.time()
    target_symbols = set(SYMBOLS)
    with _quote_lock:
        target_quotes = {symbol: _quotes.get(symbol) for symbol in target_symbols}
    fresh_symbols = set()
    verified_book_symbols = set()
    for symbol, quote in target_quotes.items():
        if not quote:
            continue
        if not _quote_matches_selected_provider(quote):
            continue
        ts = quote.get("_ingested_ts")
        if ts is None:
            continue
        age = now - float(ts)
        if 0.0 <= age <= GATEWAY_MAX_QUOTE_AGE_SEC:
            fresh_symbols.add(symbol)
            bid = _num(quote.get("bid")); ask = _num(quote.get("ask"))
            bs = _num(quote.get("bid_size")); ass = _num(quote.get("ask_size"))
            if bid and bid > 0 and ask and ask > 0 and ask >= bid and bs and bs > 0 and ass and ass > 0:
                verified_book_symbols.add(symbol)
    target_count = len(target_symbols)
    return {
        "target_count": target_count,
        "quoted_count": sum(1 for q in target_quotes.values() if q),
        "fresh_quote_count": len(fresh_symbols),
        "verified_book_count": len(verified_book_symbols),
        "fresh_coverage_ratio": round(len(fresh_symbols) / target_count, 6) if target_count else 0.0,
        "verified_book_coverage_ratio": round(len(verified_book_symbols) / target_count, 6) if target_count else 0.0,
        "required_live_coverage_ratio": LUNA_LIVE_MIN_REALTIME_COVERAGE,
        "max_quote_age_sec": GATEWAY_MAX_QUOTE_AGE_SEC,
        "latest_quote_age_sec": _latest_quote_age_sec(),
    }


def _connectivity_proof() -> Dict[str, Any]:
    """Machine-readable readiness evidence; no network calls."""
    coverage = _quote_coverage_snapshot()
    checks = {
        "source_revision_known": RELEASE_SOURCE_REVISION != "unknown",
        "source_revision_guarded": not EXPECTED_SOURCE_REVISION or RELEASE_SOURCE_REVISION == EXPECTED_SOURCE_REVISION,
        "settrade_sdk_loaded": Investor is not None,
        "settrade_sdk_v2": SETTRADE_SDK_VERSION.startswith("2."),
        "broker_credentials_configured": settrade_configured(),
        "authorized_marketdata_selected": _selected_provider in {"SETTRADE", "SET_API"},
        "execution_ledger_configured": execution_ledger_configured(),
        "selected_provider_credentials_configured": (
            (_selected_provider == "SETTRADE" and settrade_configured())
            or (_selected_provider == "SET_API" and set_api_configured())
        ),
        "set_api_backup_configured": set_api_configured(),
        "realtime_enabled": REALTIME_ENABLED,
        "symbols_configured": coverage["target_count"] > 0,
        "fresh_coverage_sufficient": coverage["fresh_coverage_ratio"] >= LUNA_LIVE_MIN_REALTIME_COVERAGE,
        "verified_book_coverage_sufficient": coverage["verified_book_coverage_ratio"] >= LUNA_LIVE_MIN_REALTIME_COVERAGE,
    }
    return {
        "live_execution_ready": (
            checks["source_revision_known"]
            and checks["source_revision_guarded"]
            and checks["settrade_sdk_loaded"]
            and checks["settrade_sdk_v2"]
            and checks["broker_credentials_configured"]
            and checks["authorized_marketdata_selected"]
            and checks["selected_provider_credentials_configured"]
            and checks["execution_ledger_configured"]
            and checks["realtime_enabled"]
            and checks["symbols_configured"]
            and checks["fresh_coverage_sufficient"]
            and checks["verified_book_coverage_sufficient"]
        ),
        "checks": checks,
        "selected_provider": _selected_provider,
        "settrade_sdk": "settrade-v2",
        "settrade_sdk_version": SETTRADE_SDK_VERSION,
        "settrade_environment": SETTRADE_ENV,
        "execution_ledger_configured": execution_ledger_configured(),
        "order_auth_configured": bool(ORDER_AUTH_KEY),
        "primary_provider": PRIMARY_PROVIDER,
        "authorized_backup_provider": "SET_API",
        "coverage": coverage,
        "collector_error": _collector_error,
    }


def _system_status() -> str:
    proof = _connectivity_proof()
    if LIVE_ARMED and proof["live_execution_ready"] and not GATEWAY_KILL_SWITCH and GATEWAY_ORDER_GATE_ENABLED:
        return "LIVE_READY"
    if not LIVE_ARMED:
        if proof["checks"]["authorized_marketdata_selected"] and proof["checks"]["fresh_coverage_sufficient"]:
            return "PAPER_READY"
        if proof["checks"]["realtime_enabled"] and proof["coverage"]["quoted_count"] > 0:
            return "PAPER_DEGRADED"
        return "LOCKED"
    if proof["checks"]["realtime_enabled"] and proof["coverage"]["quoted_count"] > 0:
        return "DEGRADED"
    return "LOCKED"


def _hard_order_gate(payload: Any):
    if not GATEWAY_ORDER_GATE_ENABLED:
        raise HTTPException(status_code=423, detail={"code": "hard_order_gate_disabled"})
    if GATEWAY_KILL_SWITCH:
        raise HTTPException(status_code=423, detail={"code": "gateway_kill_switch_active"})
    if not LIVE_ARMED:
        raise HTTPException(status_code=423, detail={"code": "live_trading_not_armed"})

    proof = _connectivity_proof()
    if not proof["live_execution_ready"]:
        raise HTTPException(status_code=503, detail={"code": "live_connectivity_gate", "proof": proof})

    with _safety_lock:
        if _broker_circuit_tripped:
            raise HTTPException(status_code=503, detail={"code": "broker_circuit_breaker_tripped"})
        if str(payload.client_order_id) in _seen_client_orders:
            raise HTTPException(status_code=409, detail={"code": "duplicate_client_order_id"})
        now = time.time()
        _prune_order_attempts(now)
        if len(_order_attempt_timestamps) >= GATEWAY_MAX_ORDERS_PER_MINUTE:
            raise HTTPException(status_code=429, detail={"code": "gateway_order_rate_limit"})
        _order_attempt_timestamps.append(now)

    side = str(payload.side).upper()
    if side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="invalid_side")

    phase = market_phase_now()
    if phase == "CLOSED" or phase == "BREAK":
        raise HTTPException(status_code=423, detail={"code": "market_phase_blocked", "market_phase": phase})
    if side == "BUY" and phase != "ACTIVE":
        raise HTTPException(status_code=423, detail={"code": "buy_locked_by_market_phase", "market_phase": phase})

    notional = float(payload.price) * int(payload.volume)
    if notional <= 0 or notional > GATEWAY_MAX_ORDER_NOTIONAL + 1e-9:
        raise HTTPException(status_code=422, detail={"code": "max_order_notional", "notional": notional})

    with _quote_lock:
        quote = dict(_quotes.get(str(payload.symbol).strip().upper(), {}))
    if not quote:
        raise HTTPException(status_code=503, detail={"code": "verified_quote_unavailable"})
    if not _quote_matches_selected_provider(quote):
        raise HTTPException(
            status_code=503,
            detail={"code": "quote_provider_mismatch", "selected_provider": _selected_provider},
        )
    age = time.time() - float(quote.get("_ingested_ts") or 0.0)
    if age < 0 or age > GATEWAY_MAX_QUOTE_AGE_SEC:
        raise HTTPException(status_code=503, detail={"code": "quote_stale", "age_sec": age})
    bid = _num(quote.get("bid"))
    ask = _num(quote.get("ask"))
    bid_size = _num(quote.get("bid_size"))
    ask_size = _num(quote.get("ask_size"))
    if (
        bid is None or bid <= 0
        or ask is None or ask <= 0
        or ask < bid
        or bid_size is None or bid_size <= 0
        or ask_size is None or ask_size <= 0
    ):
        raise HTTPException(status_code=503, detail={"code": "verified_book_unavailable"})
    executable = ask if side == "BUY" else bid
    deviation_bps = abs(float(payload.price) - executable) / executable * 10000.0
    if deviation_bps > GATEWAY_MAX_PRICE_DEVIATION_BPS:
        raise HTTPException(status_code=423, detail={
            "code": "price_deviation_guard",
            "deviation_bps": deviation_bps,
            "limit_bps": GATEWAY_MAX_PRICE_DEVIATION_BPS,
        })


@app.get("/safety")
def safety(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    return {"ok": True, "safety": _safety_snapshot(), "live_armed": LIVE_ARMED}


@app.post("/safety/reset")
def safety_reset(
    x_luna_gateway: Optional[str] = Header(default=None),
    x_luna_reset_key: Optional[str] = Header(default=None),
):
    auth(x_luna_gateway)
    if not GATEWAY_CIRCUIT_RESET_KEY or x_luna_reset_key != GATEWAY_CIRCUIT_RESET_KEY:
        raise HTTPException(status_code=403, detail="circuit_reset_not_authorized")
    global _broker_failure_streak, _broker_circuit_tripped, _broker_last_failure
    with _safety_lock:
        _broker_failure_streak = 0
        _broker_circuit_tripped = False
        _broker_last_failure = None
    return {"ok": True, "safety": _safety_snapshot()}


def market_phase_now() -> str:
    local = datetime.now(ZoneInfo("Asia/Bangkok"))
    if local.weekday() >= 5:
        return "CLOSED"
    minutes = local.hour * 60 + local.minute
    if minutes < 10 * 60:
        return "CLOSED"
    if 12 * 60 + 30 <= minutes < 14 * 60:
        return "CLOSED"
    if minutes >= 16 * 60 + 30:
        return "CLOSED"
    if minutes >= 16 * 60 + 25:
        return "FORCE_CLOSE"
    if minutes >= 16 * 60 + 20:
        return "REDUCE_ONLY"
    return "ACTIVE"


def client():
    global _equity
    live_gate()
    if _equity is None:
        inv = investor_client()
        _equity = inv.Equity(account_no=os.getenv("SETTRADE_ACCOUNT_NO", ""))
    return _equity


def _first_number(mapping: Dict[str, Any], keys):
    for key in keys:
        value = _num(mapping.get(key))
        if value is not None:
            return value
    return None


def _normalize_open_orders(eq):
    try:
        raw = eq.get_orders()
    except AttributeError as exc:
        raise ProviderUnavailable("settrade_get_orders_method_unavailable") from exc
    data = raw.get("data", []) if isinstance(raw, dict) else []
    if not isinstance(data, list):
        raise ProviderUnavailable("settrade_orders_data_invalid")

    terminal = {
        "MATCHED", "FILLED", "CANCELLED", "CANCELED",
        "REJECTED", "EXPIRED", "COMPLETED", "DONE"
    }
    active = []
    for row in data:
        if not isinstance(row, dict):
            continue
        status = str(
            row.get("status")
            or row.get("order_status")
            or row.get("show_order_status")
            or ""
        ).strip().upper()
        if status in terminal:
            continue
        active.append({
            "order_id": str(
                row.get("order_no")
                or row.get("order_id")
                or row.get("orderNo")
                or ""
            ),
            "symbol": str(row.get("symbol") or "").strip().upper(),
            "side": str(row.get("side") or "").strip().upper(),
            "status": status or "UNKNOWN",
            "volume": _num(
                row.get("volume")
                if row.get("volume") is not None
                else row.get("qty")
            ),
            "matched_volume": _num(
                row.get("matched_volume")
                if row.get("matched_volume") is not None
                else row.get("filled_volume")
            ),
        })
    return {
        "ok": True,
        "as_of": _now_iso(),
        "open_orders": active,
    }


def _normalize_account_state(eq):
    account_raw = eq.get_account_info()
    portfolio_raw = eq.get_portfolio()

    account_data = account_raw.get("data", {}) if isinstance(account_raw, dict) else {}
    portfolio_data = portfolio_raw.get("data", []) if isinstance(portfolio_raw, dict) else []

    if not isinstance(account_data, dict):
        raise ProviderUnavailable("settrade_account_info_data_invalid")
    if not isinstance(portfolio_data, list):
        raise ProviderUnavailable("settrade_portfolio_data_invalid")

    cash = _first_number(account_data, (
        "cash_balance",
        "available_cash",
        "available_balance",
        "cash",
        "balance",
    ))
    if cash is None:
        raise ProviderUnavailable("settrade_cash_balance_unavailable")

    positions = []
    unparsed = []
    for row in portfolio_data:
        if not isinstance(row, dict):
            continue
        symbol = str(
            row.get("symbol")
            or row.get("stock_symbol")
            or row.get("symbol_code")
            or ""
        ).strip().upper()
        if not symbol:
            continue

        qty = _first_number(row, (
            "actual_volume",
            "volume",
            "qty",
            "quantity",
            "current_volume",
        ))
        avg_price = _first_number(row, (
            "average_price",
            "avg_price",
            "cost_price",
            "start_price",
            "price",
        ))
        if qty is None:
            unparsed.append(symbol)
            continue
        if qty <= 0:
            continue
        if avg_price is None or avg_price <= 0:
            unparsed.append(symbol)
            continue

        market_price = _first_number(row, (
            "market_price",
            "last_price",
            "close_price",
        ))
        market_value = _first_number(row, (
            "market_value",
            "total_market_value",
        ))
        if market_value is None and market_price is not None:
            market_value = market_price * qty
        if market_value is None:
            unparsed.append(symbol)
            continue

        positions.append({
            "symbol": symbol,
            "qty": qty,
            "avg_price": avg_price,
            "market_price": market_price,
            "market_value": market_value,
            "unrealized_pnl": _first_number(row, (
                "profit",
                "unrealized_profit",
            )),
            "realized_pnl": _first_number(row, (
                "realize_profit",
                "realized_profit",
            )),
        })

    equity_value = cash + sum(float(x["market_value"]) for x in positions)

    return {
        "ok": True,
        "as_of": _now_iso(),
        "cash": cash,
        "equity_value": equity_value,
        "positions": positions,
        "unparsed_symbols": sorted(set(unparsed)),
    }


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
            float(q["_ingested_ts"])
            for q in _quotes.values()
            if q.get("_ingested_ts") is not None
        ]
    if not timestamps:
        return None
    return max(0.0, time.time() - max(timestamps))


def _channel_snapshot():
    with _feed_lock:
        return {k: dict(v) for k, v in _channel_status.items()}


def _enqueue_stream(client_id: str, payload: Dict[str, Any]):
    with _stream_lock:
        client = _stream_clients.get(client_id)
    if client is None:
        return
    _, queue = client
    try:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(payload)
    except Exception:
        pass


def _publish_stream_quote(quote: Dict[str, Any]):
    payload = {k: v for k, v in quote.items() if k not in ("raw", "_ingested_ts")}
    with _stream_lock:
        clients = list(_stream_clients.items())
    for client_id, (loop, _) in clients:
        try:
            loop.call_soon_threadsafe(_enqueue_stream, client_id, payload)
        except Exception:
            pass
    with _public_stream_lock:
        public_clients = list(_public_stream_clients.items())
    for client_id, (loop, _) in public_clients:
        try:
            loop.call_soon_threadsafe(_enqueue_public_stream, client_id, payload)
        except Exception:
            pass


def _enqueue_public_stream(client_id: str, payload: Dict[str, Any]):
    with _public_stream_lock:
        client = _public_stream_clients.get(client_id)
    if client is None:
        return
    _, queue = client
    try:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(payload)
    except Exception:
        pass


def _quote_payload(
    symbol: str,
    last: Any = None,
    bid: Any = None,
    ask: Any = None,
    bid_size: Any = None,    ask_size: Any = None,
    source: str = "",
    source_ts: Any = None,
    raw: Any = None,
    total_volume: Any = None,
):
    now = _now_iso()
    with _quote_lock:
        prior = dict(_quotes.get(symbol, {}))
        effective_source = source or prior.get("source")
        same_source = bool(prior) and effective_source == prior.get("source")
        quote = {
            "symbol": symbol,
            "ts": now,
            "source_ts": source_ts,
            "bid": _num(bid) if bid is not None else (prior.get("bid") if same_source else None),
            "ask": _num(ask) if ask is not None else (prior.get("ask") if same_source else None),
            "last": _num(last) if last is not None else (prior.get("last") if same_source else None),
            "bid_size": _num(bid_size) if bid_size is not None else (prior.get("bid_size") if same_source else None),
            "ask_size": _num(ask_size) if ask_size is not None else (prior.get("ask_size") if same_source else None),
            "total_volume": _num(total_volume) if total_volume is not None else (prior.get("total_volume") if same_source else None),
            "source": effective_source,
            "raw": raw,
            "_ingested_ts": time.time(),
        }
        prior_public = {k: v for k, v in prior.items() if k not in ("raw", "_ingested_ts")}
        current_public = {k: v for k, v in quote.items() if k not in ("raw", "_ingested_ts")}
        was_new = symbol not in _quotes
        changed = was_new or prior_public != current_public
        _quotes[symbol] = quote
    if changed:
        _publish_stream_quote(quote)
    return was_new


def _update_settrade_quote(symbol: str, data: Dict[str, Any], channel: str):
    global _collector_error
    if channel == "price":
        was_new = _quote_payload(
            symbol=symbol,
            last=data.get("last"),
            source="settrade-open-api-realtime",
            raw=data,
        )
    else:
        was_new = _quote_payload(
            symbol=symbol,
            bid=data.get("bid_price1"),
            ask=data.get("ask_price1"),
            bid_size=data.get("bid_volume1"),
            ask_size=data.get("ask_volume1"),
            source="settrade-open-api-realtime",
            raw=data,
        )
    _collector_error = None
    if was_new:
        print(f"LUNA_MARKETDATA first_quote provider=SETTRADE symbol={symbol}", flush=True)


def _extract_rows(payload: Any):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "result", "results", "items", "answer"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        # Some APIs return one object for one symbol.
        if payload.get("symbol"):
            return [payload]
    return []


def _extract_book_level(value):
    if not isinstance(value, list):
        return None, None
    best = None
    for item in value:
        if not isinstance(item, dict):
            continue
        rank = item.get("rank")
        if rank == 1:
            best = item
            break
        if best is None:
            best = item
    if not best:
        return None, None
    return best.get("price"), best.get("volume")


def _epoch_to_iso(value: Any) -> Optional[str]:
    try:
        ts = float(value)
        if ts > 1_000_000_000_000:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except Exception:
        return None


def _toptrader_ws_message(message: str):
    try:
        msg = json.loads(message)
    except Exception:
        return
    if not isinstance(msg, dict):
        return
    data = msg.get("data") if isinstance(msg.get("data"), dict) else msg
    stream = str(msg.get("stream") or "")
    event_type = str(msg.get("type") or "").lower()
    symbol = str(msg.get("symbol") or data.get("symbol") or "").upper()
    if not symbol and "@" in stream:
        symbol = stream.split("@", 1)[0].upper()
    if symbol not in SYMBOLS:
        return
    if event_type == "tick" or stream.endswith("@tick"):
        _quote_payload(symbol=symbol, last=data.get("last"), bid=data.get("bid"), ask=data.get("ask"), source="toptrader-public-ws", source_ts=_epoch_to_iso(data.get("datetime")), total_volume=data.get("volume"), raw=data)
    elif event_type == "book" or stream.endswith("@book"):
        book = data.get("book") if isinstance(data.get("book"), list) else []
        bid = ask = bid_size = ask_size = None
        for level in book:
            if not isinstance(level, dict):
                continue
            side = str(level.get("type") or "").lower()
            if side == "buy" and bid is None:
                bid, bid_size = level.get("price"), level.get("volume")
            elif side == "sell" and ask is None:
                ask, ask_size = level.get("price"), level.get("volume")
        _quote_payload(symbol=symbol, bid=bid, ask=ask, bid_size=bid_size, ask_size=ask_size, source="toptrader-public-ws", source_ts=_epoch_to_iso(data.get("datetime")), raw=data)
    with _toptrader_ws_lock:
        _toptrader_ws_seen.add(symbol)


def _fetch_toptrader_symbol_catalog() -> set[str]:
    global _toptrader_supported_symbols, _toptrader_symbols_loaded_at
    now = time.time()
    if _toptrader_supported_symbols and now - _toptrader_symbols_loaded_at < 300:
        return set(_toptrader_supported_symbols)
    req = Request(TOPTRADER_SYMBOLS_BASE, headers={"Accept": "application/json", "User-Agent": "LUNA-TH1H/0.7.2"}, method="GET")
    try:
        with urlopen(req, timeout=TOPTRADER_TIMEOUT_SEC) as response:
            body = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except HTTPError as exc:
        raise ProviderUnavailable("toptrader_symbols_http_" + str(exc.code)) from exc
    except URLError as exc:
        raise ProviderUnavailable("toptrader_symbols_network:" + str(exc.reason)) from exc
    except Exception as exc:
        raise ProviderUnavailable("toptrader_symbols_request:" + str(exc)) from exc
    if status >= 400:
        raise ProviderUnavailable("toptrader_symbols_http_" + str(status))
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailable("toptrader_symbols_invalid_json") from exc
    rows = _extract_rows(payload)
    supported = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").strip().upper()
        category = str(row.get("category") or "").strip().upper()
        if symbol and (not category or category == "SET"):
            supported.add(symbol)
    if not supported:
        raise ProviderUnavailable("toptrader_symbols_catalog_empty")
    _toptrader_supported_symbols = supported
    _toptrader_symbols_loaded_at = now
    print("LUNA_MARKETDATA toptrader_catalog symbols=" + str(len(supported)), flush=True)
    return set(supported)

async def _toptrader_ws_consume(chunk: list[str], index: int):
    if websockets is None:
        raise ProviderUnavailable("toptrader_websockets_dependency_unavailable")
    query = urlencode({"symbols": ",".join(chunk)})
    uri = TOPTRADER_WS_BASE + "?" + query
    print("LUNA_MARKETDATA toptrader_ws_connect chunk=" + str(index) + " symbols=" + str(len(chunk)), flush=True)
    async with websockets.connect(uri, ping_interval=20, ping_timeout=20, close_timeout=5, max_size=2_000_000) as ws:
        async for message in ws:
            _toptrader_ws_message(message)


def _toptrader_ws_worker(chunk: list[str], index: int):
    retry = TOPTRADER_WS_RECONNECT_SEC
    while True:
        try:
            asyncio.run(_toptrader_ws_consume(chunk, index))
        except Exception as exc:
            _provider_failures["TOPTRADER_WS"] += 1
            print("LUNA_MARKETDATA toptrader_ws_error chunk=" + str(index) + " error=" + str(exc), flush=True)
            time.sleep(retry)
            retry = min(RECONNECT_MAX_SEC, retry * 2)
        else:
            retry = TOPTRADER_WS_RECONNECT_SEC


def _run_toptrader_ws():
    global _collector_error, _selected_provider, _provider_restarts
    if not TOPTRADER_ENABLED or not TOPTRADER_WS_ENABLED:
        raise ProviderUnavailable("toptrader_ws_backup_disabled")
    if websockets is None:
        raise ProviderUnavailable("toptrader_websockets_dependency_unavailable")
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")
    _selected_provider = "TOPTRADER_WS"
    _provider_restarts += 1
    catalog = _fetch_toptrader_symbol_catalog()
    catalog_overlap = len([s for s in SYMBOLS if s in catalog])
    ws_symbols = list(SYMBOLS)
    chunks = [ws_symbols[i:i + TOPTRADER_WS_CHUNK_SIZE] for i in range(0, len(ws_symbols), TOPTRADER_WS_CHUNK_SIZE)]
    with _toptrader_ws_lock:
        _toptrader_ws_seen.clear()
    print("LUNA_MARKETDATA provider_start provider=TOPTRADER_WS target=" + str(len(SYMBOLS)) + " catalog_overlap=" + str(catalog_overlap) + " connections=" + str(len(chunks)) + " bid_offer=" + str(REALTIME_BOOK), flush=True)
    for index, chunk in enumerate(chunks, start=1):
        threading.Thread(target=_toptrader_ws_worker, args=(chunk, index), daemon=True).start()
    rest_stop = threading.Event()
    if TOPTRADER_REST_PUMP_ENABLED:
        threading.Thread(target=_toptrader_rest_pump, args=(rest_stop,), daemon=True).start()
        print("LUNA_MARKETDATA toptrader_rest_pump started", flush=True)
    started = time.monotonic()
    while True:
        time.sleep(2)
        with _toptrader_ws_lock:
            seen = len(_toptrader_ws_seen)
        age = _latest_quote_age_sec()
        target_count = len(SYMBOLS)
        coverage = (seen / target_count) if target_count else 0.0
        quote_count = len(_quotes)
        quote_coverage = (quote_count / target_count) if target_count else 0.0
        print("LUNA_MARKETDATA toptrader_ws_snapshot ws_seen=" + str(seen) + " quote_count=" + str(quote_count) + " target=" + str(target_count) + " ws_coverage=" + f"{coverage:.3f}" + " quote_coverage=" + f"{quote_coverage:.3f}" + " latest_age=" + str(age), flush=True)
        if seen > 0 and age is not None and age <= STALE_AFTER_SEC:
            _collector_error = None
        elif time.monotonic() - started >= 30:
            rest_stop.set()
            raise ProviderUnavailable("toptrader_ws_no_fresh_quotes")


def _fetch_toptrader_public():
    if not TOPTRADER_ENABLED:
        raise ProviderUnavailable("toptrader_backup_disabled")
    query = urlencode({"symbol": "SET\\*,!BBL"})
    req = Request(TOPTRADER_API_BASE + "?" + query, headers={"Accept": "application/json", "User-Agent": "LUNA-TH1H/0.6.0"}, method="GET")
    try:
        with urlopen(req, timeout=TOPTRADER_TIMEOUT_SEC) as response:
            body = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except HTTPError as exc:
        raise ProviderUnavailable("toptrader_http_" + str(exc.code)) from exc
    except URLError as exc:
        raise ProviderUnavailable("toptrader_network:" + str(exc.reason)) from exc
    except Exception as exc:
        raise ProviderUnavailable("toptrader_request:" + str(exc)) from exc
    if status >= 400:
        raise ProviderUnavailable("toptrader_http_" + str(status))
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailable("toptrader_invalid_json") from exc


def _apply_toptrader_rest_payload(payload: Any) -> int:
    rows = _extract_rows(payload)
    found = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").upper()
        if symbol not in SYMBOLS:
            continue
        _quote_payload(symbol=symbol, last=row.get("last"), bid=row.get("bid") if REALTIME_BOOK else None, ask=row.get("ask") if REALTIME_BOOK else None, source="toptrader-public-rest", source_ts=_epoch_to_iso(row.get("datetime")), total_volume=row.get("volume"), raw=row)
        found += 1
    return found


def _toptrader_rest_pump(stop_event: threading.Event):
    while not stop_event.is_set():
        try:
            found = _apply_toptrader_rest_payload(_fetch_toptrader_public())
            if found == 0:
                print("LUNA_MARKETDATA toptrader_rest_pump no_matching_symbols", flush=True)
        except Exception as exc:
            print("LUNA_MARKETDATA toptrader_rest_pump_error error=" + str(exc), flush=True)
        stop_event.wait(TOPTRADER_POLL_SEC)


def _run_toptrader_public():
    global _collector_error, _selected_provider, _provider_restarts
    if not TOPTRADER_ENABLED:
        raise ProviderUnavailable("toptrader_backup_disabled")
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")
    _selected_provider = "TOPTRADER_PUBLIC"
    _provider_restarts += 1
    print("LUNA_MARKETDATA provider_start provider=TOPTRADER_PUBLIC symbols=" + str(len(SYMBOLS)) + " bid_offer=" + str(REALTIME_BOOK), flush=True)
    while True:
        payload = _fetch_toptrader_public()
        found = _apply_toptrader_rest_payload(payload)
        if found == 0:
            _provider_failures["TOPTRADER_PUBLIC"] += 1
            raise ProviderUnavailable("toptrader_no_matching_symbols")
        _collector_error = None
        print("LUNA_MARKETDATA toptrader_snapshot found=" + str(found) + " quote_count=" + str(len(_quotes)) + " latest_age=" + str(_latest_quote_age_sec()), flush=True)
        time.sleep(TOPTRADER_POLL_SEC)

def _fetch_set_api():
    if not SET_API_KEY:
        raise ProviderUnavailable("set_api_key_missing")
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")

    query = urlencode({
        "stockSymbol": ",".join(SYMBOLS),
        "oddLotFlag": "false",
    })
    url = f"{SET_API_BASE}?{query}"
    req = Request(
        url,
        headers={
            "api-key": SET_API_KEY,
            "Accept": "application/json",
            "User-Agent": "LUNA-TH1H/0.4.0",
        },
        method="GET",
    )
    try:
        with urlopen(req, timeout=SET_API_TIMEOUT_SEC) as response:
            body = response.read().decode("utf-8")
            status = getattr(response, "status", 200)
    except HTTPError as exc:
        raise ProviderUnavailable(f"set_api_http_{exc.code}") from exc
    except URLError as exc:
        raise ProviderUnavailable(f"set_api_network:{exc.reason}") from exc
    except Exception as exc:
        raise ProviderUnavailable(f"set_api_request:{exc}") from exc

    if status >= 400:
        raise ProviderUnavailable(f"set_api_http_{status}")
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailable("set_api_invalid_json") from exc


def _run_set_api():
    global _collector_error, _selected_provider, _provider_restarts
    if not REALTIME_ENABLED:
        return

    if not SET_API_KEY:
        raise ProviderUnavailable("set_api_key_missing")
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")

    _selected_provider = "SET_API"
    _provider_restarts += 1
    with _feed_lock:
        for channel in ("price", "book"):
            _channel_status[channel].update(
                running=True,
                restarts=_channel_status[channel]["restarts"] + 1,
                last_start=_now_iso(),
                last_error=None,
            )

    print(
        f"LUNA_MARKETDATA provider_start provider=SET_API symbols={len(SYMBOLS)} "
        f"bid_offer={REALTIME_BOOK}",
        flush=True,
    )

    failures = 0
    while True:
        try:
            payload = _fetch_set_api()
            rows = _extract_rows(payload)
            found = 0

            for row in rows:
                symbol = str(row.get("symbol") or "").upper()
                if not symbol or symbol not in SYMBOLS:
                    continue

                bid_price, bid_volume = _extract_book_level(row.get("bid"))
                ask_price, ask_volume = _extract_book_level(row.get("offer"))

                was_new = _quote_payload(
                    symbol=symbol,
                    last=row.get("last"),
                    bid=bid_price if REALTIME_BOOK else None,
                    ask=ask_price if REALTIME_BOOK else None,
                    bid_size=bid_volume if REALTIME_BOOK else None,
                    ask_size=ask_volume if REALTIME_BOOK else None,
                    source="set-market-data-api-realtime",
                    source_ts=row.get("time"),
                    total_volume=row.get("totalVolume"),
                    raw=row,
                )
                found += 1
                if was_new:
                    print(f"LUNA_MARKETDATA first_quote provider=SET_API symbol={symbol}", flush=True)

            if found == 0:
                failures += 1
                if failures >= 5:
                    raise ProviderUnavailable("set_api_no_matching_symbols")
            else:
                failures = 0
                _collector_error = None

            time.sleep(SET_API_POLL_SEC)
        except ProviderUnavailable:
            raise
        except Exception as exc:
            raise ProviderUnavailable(f"set_api_runtime:{exc}") from exc



def _run_tradingview_session():
    global _collector_error, _selected_provider, _provider_restarts

    if not PUBLIC_FALLBACK_ENABLED:
        raise ProviderUnavailable("public_fallback_disabled")
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")

    payload = {
        "columns": ["name", "close", "change", "change_abs", "volume"],
        "ignore_unknown_fields": False,
        "options": {"lang": "th"},
        "range": [0, 1000],
        "sort": {"sortBy": "name", "sortOrder": "asc", "nullsFirst": False},
        "preset": "all_stocks",
    }
    body = json.dumps(payload).encode("utf-8")

    _selected_provider = "TRADINGVIEW_PUBLIC"
    _provider_restarts += 1
    with _feed_lock:
        _channel_status["price"].update(
            running=True,
            restarts=_channel_status["price"]["restarts"] + 1,
            last_start=_now_iso(),
            last_error=None,
        )
        _channel_status["book"].update(running=False)

    print(
        f"LUNA_MARKETDATA provider_start provider=TRADINGVIEW_PUBLIC "
        f"symbols={len(SYMBOLS)} quality=public_screener_unverified_latency",
        flush=True,
    )

    while True:
        req = Request(
            TRADINGVIEW_URL,
            data=body,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": "https://www.tradingview.com",
                "Referer": "https://www.tradingview.com/",
                "User-Agent": "LUNA-TH1H/0.4.0",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=SET_API_TIMEOUT_SEC) as response:
                raw_text = response.read().decode("utf-8")
                status = getattr(response, "status", 200)
            if status >= 400:
                raise ProviderUnavailable(f"tradingview_http_{status}")
            payload_out = json.loads(raw_text)
            rows = payload_out.get("data", []) if isinstance(payload_out, dict) else []
            wanted = set(SYMBOLS)
            found = 0

            for row in rows:
                if not isinstance(row, dict):
                    continue
                ticker = str(row.get("s") or "").upper()
                d = row.get("d") or []
                if ":" in ticker:
                    symbol = ticker.split(":", 1)[1]
                else:
                    symbol = ticker
                if symbol not in wanted or len(d) < 5:
                    continue

                last = _num(d[1])
                if last is None:
                    continue

                # TradingView public scanner does not reliably expose a source
                # exchange timestamp in this response. ts therefore means
                # ingestion time, while source identifies the unverified feed.
                now = _now_iso()
                with _quote_lock:
                    prior = dict(_quotes.get(symbol, {}))
                    was_new = symbol not in _quotes
                    _quotes[symbol] = {
                        "symbol": symbol,
                        "ts": now,
                        "source_ts": None,
                        "bid": prior.get("bid"),
                        "ask": prior.get("ask"),
                        "last": last,
                        "bid_size": prior.get("bid_size"),
                        "ask_size": prior.get("ask_size"),
                        "total_volume": _num(d[4]),
                        "source": "tradingview-public-screener",
                        "data_quality": "public_screener_unverified_latency",
                        "_ingested_ts": time.time(),
                    }
                found += 1
                if was_new:
                    print(
                        f"LUNA_MARKETDATA first_quote provider=TRADINGVIEW_PUBLIC symbol={symbol}",
                        flush=True,
                    )

            if found == 0:
                raise ProviderUnavailable("tradingview_no_matching_symbols")

            _collector_error = None
            time.sleep(TRADINGVIEW_POLL_SEC)

        except ProviderUnavailable:
            raise
        except HTTPError as exc:
            raise ProviderUnavailable(f"tradingview_http_{exc.code}") from exc
        except URLError as exc:
            raise ProviderUnavailable(f"tradingview_network:{exc.reason}") from exc
        except Exception as exc:
            raise ProviderUnavailable(f"tradingview_runtime:{exc}") from exc

def _run_settrade_session():
    global _collector_error, _selected_provider, _provider_restarts

    if not settrade_configured():
        missing = missing_settrade_credentials()
        raise ProviderUnavailable(
            "settrade_unavailable:" + ",".join(missing or ["sdk"])
        )
    if not SYMBOLS:
        raise ProviderUnavailable("SETTRADE_REALTIME_SYMBOLS is empty")

    _selected_provider = "SETTRADE"
    _provider_restarts += 1
    inv = investor_client()
    mqtt = realtime_marketdata_client(inv)
    subscriptions = []
    threads = []

    with _feed_lock:
        for channel in ("price", "book"):
            enabled = channel == "price" or REALTIME_BOOK
            _channel_status[channel].update(
                running=enabled,
                restarts=_channel_status[channel]["restarts"] + 1 if enabled else _channel_status[channel]["restarts"],
                last_start=_now_iso() if enabled else _channel_status[channel]["last_start"],
                last_error=None,
            )

    print(
        f"LUNA_MARKETDATA provider_start provider=SETTRADE symbols={len(SYMBOLS)} "
        f"bid_offer={REALTIME_BOOK}",
        flush=True,
    )

    for symbol in SYMBOLS:
        try:
            price_sub = mqtt.subscribe_price_info(
                symbol,
                on_message=lambda result, subscriber, sym=symbol: _update_settrade_quote(
                    sym,
                    result.get("data", result) if isinstance(result, dict) else {},
                    "price",
                ),
            )
            subscriptions.append(("price", price_sub))

            if REALTIME_BOOK:
                book_sub = mqtt.subscribe_bid_offer(
                    symbol,
                    on_message=lambda result, subscriber, sym=symbol: _update_settrade_quote(
                        sym,
                        result.get("data", result) if isinstance(result, dict) else {},
                        "book",
                    ),
                )
                subscriptions.append(("book", book_sub))
        except Exception as exc:
            print(
                f"LUNA_MARKETDATA subscribe_error provider=SETTRADE symbol={symbol} error={exc}",
                flush=True,
            )

    for _, sub in subscriptions:
        thread = threading.Thread(target=sub.start, daemon=True)
        thread.start()
        threads.append(thread)

    if not threads:
        raise ProviderUnavailable("settrade_no_subscriptions_created")

    grace_until = time.monotonic() + 30.0
    try:
        while True:
            time.sleep(5)
            alive = sum(1 for t in threads if t.is_alive())
            age = _latest_quote_age_sec()

            if alive == 0:
                raise ProviderUnavailable("settrade_subscriptions_stopped")

            if time.monotonic() >= grace_until:
                if age is None:
                    raise ProviderUnavailable("settrade_no_quotes_after_start")
                if age > STALE_AFTER_SEC:
                    raise ProviderUnavailable(f"settrade_quotes_stale_{age:.1f}s")
    finally:
        with _feed_lock:
            _channel_status["price"]["running"] = False
            if REALTIME_BOOK:
                _channel_status["book"]["running"] = False


def _provider_order():
    if PROVIDER_MODE == "SETTRADE":
        order = ["SETTRADE", "SET_API", "TOPTRADER_WS", "TOPTRADER_PUBLIC"]
    elif PROVIDER_MODE == "SET_API":
        order = ["SET_API", "SETTRADE", "TOPTRADER_WS", "TOPTRADER_PUBLIC"]
    elif PROVIDER_MODE == "TOPTRADER_WS":
        order = ["TOPTRADER_WS", "TOPTRADER_PUBLIC", "SETTRADE", "SET_API"]
    elif PROVIDER_MODE == "TOPTRADER_PUBLIC":
        order = ["TOPTRADER_PUBLIC", "TOPTRADER_WS", "SETTRADE", "SET_API"]
    else:
        order = ["SETTRADE", "SET_API", "TOPTRADER_WS", "TOPTRADER_PUBLIC"]
    if PUBLIC_FALLBACK_ENABLED:
        order.append("TRADINGVIEW_PUBLIC")
    return order


def _provider_available(name: str):
    if name == "SET_API":
        return set_api_configured()
    if name == "SETTRADE":
        return settrade_configured()
    if name == "TOPTRADER_WS":
        return TOPTRADER_ENABLED and TOPTRADER_WS_ENABLED and websockets is not None
    if name == "TOPTRADER_PUBLIC":
        return TOPTRADER_ENABLED
    if name == "TRADINGVIEW_PUBLIC":
        return PUBLIC_FALLBACK_ENABLED
    return False


def _run_supervisor():
    global _collector_started, _collector_error, _selected_provider
    backoff = RECONNECT_BASE_SEC

    with _feed_lock:
        _collector_started = True

    while True:
        if not REALTIME_ENABLED:
            _selected_provider = None
            time.sleep(CREDENTIAL_RETRY_SEC)
            continue
        if not SYMBOLS:
            _selected_provider = None
            _collector_error = "SETTRADE_REALTIME_SYMBOLS is empty"
            time.sleep(CREDENTIAL_RETRY_SEC)
            continue

        attempted = []
        ran = False

        for provider in _provider_order():
            if not _provider_available(provider):
                continue

            attempted.append(provider)
            try:
                if provider == "SET_API":
                    _run_set_api()
                elif provider == "SETTRADE":
                    _run_settrade_session()
                elif provider == "TOPTRADER_WS":
                    _run_toptrader_ws()
                elif provider == "TOPTRADER_PUBLIC":
                    _run_toptrader_public()
                elif provider == "TRADINGVIEW_PUBLIC":
                    _run_tradingview_session()
                else:
                    raise ProviderUnavailable(f"unknown_provider:{provider}")
                ran = True
                backoff = RECONNECT_BASE_SEC
                break
            except ProviderUnavailable as exc:
                _provider_failures[provider] = _provider_failures.get(provider, 0) + 1
                _collector_error = str(exc)
                print(
                    f"LUNA_MARKETDATA provider_failed provider={provider} "
                    f"error={exc} fallback_next=True",
                    flush=True,
                )
                with _feed_lock:
                    for channel in ("price", "book"):
                        _channel_status[channel]["last_error"] = str(exc)
                        _channel_status[channel]["running"] = False

        if not attempted:
            _selected_provider = None
            available_note = {
                "SET_API": "api-key" if SET_API_KEY else "missing",
                "SETTRADE": "credentials" if missing_settrade_credentials() == [] else "missing",
            }
            _collector_error = f"no_marketdata_provider_available:{available_note}"
        elif not ran:
            _selected_provider = None

        time.sleep(1 if ran else backoff)
        if not ran:
            backoff = min(RECONNECT_MAX_SEC, backoff * 2)


def _start_marketdata():
    global _supervisor_started
    if not REALTIME_ENABLED:
        print("LUNA_MARKETDATA disabled", flush=True)
        return
    if not SYMBOLS:
        print("LUNA_MARKETDATA blocked: SETTRADE_REALTIME_SYMBOLS is empty", flush=True)
        return

    with _feed_lock:
        if _supervisor_started:
            return
        _supervisor_started = True

    print(
        f"LUNA_MARKETDATA starting provider_mode={PROVIDER_MODE} "
        f"symbols={len(SYMBOLS)} bid_offer={REALTIME_BOOK} "
        f"set_api_configured={set_api_configured()} "
        f"settrade_configured={settrade_configured()} "
        f"settrade_missing={missing_settrade_credentials()}",
        flush=True,
    )
    threading.Thread(target=_run_supervisor, daemon=True).start()


@app.on_event("startup")
def startup():
    if REALTIME_ENABLED:
        _start_marketdata()


class PlaceOrder(BaseModel):
    client_order_id: str = Field(min_length=8, max_length=200)
    session_id: str = Field(min_length=8, max_length=200)
    strategy_version: str = Field(min_length=1, max_length=200)
    symbol: str = Field(min_length=1, max_length=32)
    side: str
    price: float = Field(gt=0)
    volume: int = Field(gt=0)
    reason: str = ""


class CancelOrder(BaseModel):
    client_order_id: str = Field(min_length=8, max_length=200)
    broker_order_id: str = Field(min_length=1, max_length=200)

class MarketQuote(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    last: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_size: Optional[float] = None
    ask_size: Optional[float] = None
    source_ts: Optional[Any] = None
    total_volume: Optional[float] = None
    source: str = Field(default="settrade-local-bridge", max_length=128)
    raw: Optional[Dict[str, Any]] = None


class MarketQuoteBatch(BaseModel):
    quotes: list[MarketQuote] = Field(min_length=1, max_length=500)



@app.get("/historical-candles/{symbol}")
def historical_candles(
    symbol: str,
    interval: str = "15m",
    limit: int = 500,
    start: Optional[str] = None,
    end: Optional[str] = None,
    normalized: bool = True,
    x_luna_gateway: Optional[str] = Header(default=None),
):
    """
    Fetch historical OHLCV candles from Settrade Open API.

    This endpoint is research-only: it never uses adjusted prices or
    point-in-time fundamentals implicitly. Corporate actions and PIT
    fundamental data remain separate data products.
    """
    auth(x_luna_gateway)

    symbol = symbol.strip().upper()
    allowed_intervals = {
        "1m", "3m", "5m", "10m", "15m", "30m",
        "60m", "120m", "240m", "1d", "1w", "1M",
    }
    if not symbol:
        raise HTTPException(status_code=400, detail="invalid_symbol")
    if interval not in allowed_intervals:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_interval", "allowed": sorted(allowed_intervals)},
        )
    try:
        limit = int(limit)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid_limit")
    if limit < 1 or limit > 5000:
        raise HTTPException(status_code=400, detail="limit_out_of_range")

    try:
        inv = investor_client()
        marketdata = historical_marketdata_client(inv)
        payload = marketdata.get_candlestick(
            symbol=symbol,
            interval=interval,
            limit=limit,
            start=start,
            end=end,
            normalized=normalized or None,
        )
    except ProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "settrade_historical_failed", "error": str(exc)},
        ) from exc

    return {
        "ok": True,
        "source": "settrade-open-api-historical",
        "symbol": symbol,
        "interval": interval,
        "limit": limit,
        "start": start,
        "end": end,
        "normalized": normalized,
        "fetched_at": _now_iso(),
        "data": payload,
    }


@app.get("/connectivity/proof")
def connectivity_proof(
    symbol: str,
    interval: str = "15m",
    x_luna_gateway: Optional[str] = Header(default=None),
):
    """Authenticated end-to-end historical Settrade connectivity probe."""
    auth(x_luna_gateway)
    symbol = symbol.strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="invalid_symbol")
    try:
        inv = investor_client()
        marketdata = historical_marketdata_client(inv)
        payload = marketdata.get_candlestick(symbol=symbol, interval=interval, limit=1, start=None, end=None, normalized=True)
    except ProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail={"code": str(exc), "proof": _connectivity_proof()}) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"code": "settrade_historical_probe_failed", "error": str(exc), "proof": _connectivity_proof()}) from exc
    data_nonempty = payload is not None and payload != [] and payload != {}
    proof = _connectivity_proof()
    proof["checks"]["historical_probe_nonempty"] = data_nonempty
    proof["historical_probe"] = {"symbol": symbol, "interval": interval, "nonempty": data_nonempty}
    proof["historical_end_to_end_verified"] = data_nonempty
    return {"ok": data_nonempty, **proof}


@app.get("/health")
def health():
    return {
        "ok": True,
        "status": _system_status(),
        "live_armed": LIVE_ARMED,
        "timestamp": int(time.time()),
    }


@app.websocket("/quotes/stream")
async def quotes_stream(websocket: WebSocket):
    await websocket.accept()
    client_id = uuid.uuid4().hex
    try:
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        auth_payload = json.loads(raw_auth)
        if (
            auth_payload.get("type") != "auth"
            or not GATEWAY_KEY
            or auth_payload.get("key") != GATEWAY_KEY
        ):
            await websocket.close(code=4401)
            return

        queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        loop = asyncio.get_running_loop()
        with _stream_lock:
            _stream_clients[client_id] = (loop, queue)

        with _quote_lock:
            snapshot = [
                {k: v for k, v in q.items() if k not in ("raw", "_ingested_ts")}
                for q in _quotes.values()
            ]
        await websocket.send_json({
            "type": "snapshot",
            "generated_at": _now_iso(),
            "count": len(snapshot),
            "quotes": snapshot,
        })

        while True:
            payload = await queue.get()
            await websocket.send_json({"type": "quote", "quote": payload})
    except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
        pass
    finally:
        with _stream_lock:
            _stream_clients.pop(client_id, None)


@app.websocket("/quotes/public-stream")
async def public_quotes_stream(websocket: WebSocket):
    if not PUBLIC_STREAM_ENABLED:
        await websocket.close(code=4403)
        return

    with _public_stream_lock:
        if len(_public_stream_clients) >= PUBLIC_STREAM_MAX_CLIENTS:
            await websocket.accept()
            await websocket.close(code=4429)
            return

    await websocket.accept()
    client_id = uuid.uuid4().hex
    queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    loop = asyncio.get_running_loop()
    with _public_stream_lock:
        _public_stream_clients[client_id] = (loop, queue)

    try:
        with _quote_lock:
            snapshot = [
                {k: v for k, v in q.items() if k not in ("raw", "_ingested_ts")}
                for q in _quotes.values()
            ]
        await websocket.send_json({
            "type": "snapshot",
            "generated_at": _now_iso(),
            "count": len(snapshot),
            "quotes": snapshot,
            "public": True,
        })

        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                await websocket.send_json({"type": "quote", "quote": payload, "public": True})
            except asyncio.TimeoutError:
                await websocket.send_json({
                    "type": "heartbeat",
                    "ts": _now_iso(),
                    "quote_count": len(_quotes),
                    "public": True,
                })
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        with _public_stream_lock:
            _public_stream_clients.pop(client_id, None)


@app.get("/quotes")
def quotes(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    with _quote_lock:
        data = [
            {k: v for k, v in q.items() if k != "_ingested_ts"}
            for q in _quotes.values()
        ]
        quote_ages = {
            q["symbol"]: max(0.0, time.time() - float(q["_ingested_ts"]))
            for q in _quotes.values()
            if q.get("_ingested_ts") is not None
        }
    return {
        "ok": True,
        "generated_at": _now_iso(),
        "count": len(data),
        "target": len(SYMBOLS),
        "coverage": _quote_coverage_snapshot(),
        "provider_mode": PROVIDER_MODE,
        "selected_provider": _selected_provider,
        "collector_started": _collector_started,
        "collector_error": _collector_error,
        "set_api_configured": set_api_configured(),
        "settrade_configured": settrade_configured(),
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
    return {
        "ok": True,
        "quote": {k: v for k, v in data.items() if k != "_ingested_ts"},
    }


@app.get("/account-state")
def account_state(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    try:
        state = _normalize_account_state(eq)
    except ProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return state


@app.get("/open-orders")
def open_orders(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    try:
        state = _normalize_open_orders(eq)
    except ProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return state


@app.get("/portfolio")
def portfolio(x_luna_gateway: Optional[str] = Header(default=None)):
    auth(x_luna_gateway)
    eq = client()
    return {"ok": True, "data": eq.get_portfolio()}


@app.post("/marketdata/ingest")
def marketdata_ingest(payload: MarketQuoteBatch, x_luna_gateway: Optional[str] = Header(default=None)):
    if not MARKETDATA_INGEST_KEY or x_luna_gateway != MARKETDATA_INGEST_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")
    accepted = 0
    for quote in payload.quotes:
        symbol = quote.symbol.strip().upper()
        if not symbol or symbol not in SYMBOLS:
            continue
        if all(v is None for v in (quote.last, quote.bid, quote.ask)):
            continue
        _quote_payload(
            symbol=symbol,
            last=quote.last,
            bid=quote.bid,
            ask=quote.ask,
            bid_size=quote.bid_size,
            ask_size=quote.ask_size,
            source=quote.source,
            source_ts=quote.source_ts,
            total_volume=quote.total_volume,
            raw=quote.raw,
        )
        accepted += 1
    global _collector_error, _external_bridge_last_ts, _selected_provider
    if accepted:
        _collector_error = None
        _external_bridge_last_ts = time.time()
        _selected_provider = "SETTRADE_LOCAL_BRIDGE"
    return {"ok": True, "accepted": accepted, "received": len(payload.quotes), "source": "luna-local-bridge"}


@app.post("/place")
def place(
    payload: PlaceOrder,
    x_luna_gateway: Optional[str] = Header(default=None),
    x_luna_order: Optional[str] = Header(default=None),
):
    order_auth(x_luna_gateway, x_luna_order)
    _hard_order_gate(payload)
    if not execution_ledger_configured():
        raise HTTPException(status_code=503, detail={"code": "persistent_execution_ledger_required"})
    eq = client()
    try:
        ledger_admission = _ledger_admit(payload)
    except HTTPException:
        raise
    except ProviderUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "execution_ledger_unavailable"},
        ) from exc

    try:
        broker_result = eq.place_order(
            symbol=payload.symbol,
            price=payload.price,
            volume=payload.volume,
            side=payload.side,
            pin=os.getenv("SETTRADE_PIN", ""),
        )
    except Exception as exc:
        _record_broker_failure(str(exc))
        raise HTTPException(status_code=503, detail={"code": "broker_place_failed"}) from exc

    broker_data = (broker_result or {}).get("data", {}) if isinstance(broker_result, dict) else {}
    if isinstance(broker_result, dict) and broker_result.get("success") is False:
        _record_broker_failure("BROKER_REJECTED")
        try:
            _ledger_mark_denied(str(ledger_admission["request_id"]), "BROKER_REJECTED")
        except ProviderUnavailable:
            with _safety_lock:
                _broker_circuit_tripped = True
        raise HTTPException(status_code=502, detail={"code": "broker_rejected"})
    broker_id = str(
        broker_data.get("order_id")
        or (broker_result or {}).get("orderId")
        or (broker_result or {}).get("order_no")
        or ""
    ).strip()
    if not broker_id:
        _record_broker_failure("BROKER_ACK_MISSING_ORDER_ID")
        raise HTTPException(status_code=502, detail={"code": "broker_ack_missing_order_id"})
    try:
        _ledger_mark_submitted(
            str(ledger_admission["request_id"]),
            broker_id,
            broker_result if isinstance(broker_result, dict) else {},
        )
    except ProviderUnavailable as exc:
        with _safety_lock:
            _broker_circuit_tripped = True
            _broker_last_failure = f"EXECUTION_LEDGER_COMMIT_FAILED:{exc}"
        raise HTTPException(status_code=503, detail={"code": "execution_ledger_commit_failed"}) from exc

    _record_broker_success()
    with _safety_lock:
        _seen_client_orders.add(str(payload.client_order_id))
        if len(_seen_client_orders) > 5000:
            _seen_client_orders.pop()

    gateway_received_ms=int(time.time() * 1000)
    broker_native_submitted_at_ms=extract_broker_native_submitted_at_ms(broker_result)

    return {
        "ok": True,
        "client_order_id": payload.client_order_id,
        "broker_order_id": broker_id,
        "submitted_at_ms": gateway_received_ms,
        "broker_native_submitted_at_ms": broker_native_submitted_at_ms,
        "ack_kind": "broker_native" if broker_native_submitted_at_ms is not None else "gateway_response",
        "raw": broker_result,
    }


@app.post("/cancel")
def cancel(
    payload: CancelOrder,
    x_luna_gateway: Optional[str] = Header(default=None),
    x_luna_order: Optional[str] = Header(default=None),
):
    order_auth(x_luna_gateway, x_luna_order)
    eq = client()
    try:
        ledger = _ledger_lookup_broker_order(payload.broker_order_id)
    except ProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail={"code": "execution_ledger_lookup_failed"}) from exc
    request = ledger.get("request") if isinstance(ledger, dict) else None
    if (
        not request
        or not request.get("executed")
        or str(request.get("broker_order_id")) != payload.broker_order_id
    ):
        raise HTTPException(status_code=409, detail={"code": "cancel_order_not_bound_to_persisted_execution"})

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
    bridge_age = (time.time() - _external_bridge_last_ts) if _external_bridge_last_ts else None
    effective_provider = "SETTRADE_LOCAL_BRIDGE" if bridge_age is not None and bridge_age <= EXTERNAL_BRIDGE_MAX_AGE_SEC else _selected_provider
    return {
        "ok": True,
        "version": APP_VERSION,
        "live_armed": LIVE_ARMED,
        "provider_mode": PROVIDER_MODE,
        "selected_provider": effective_provider,
        "provider_candidates": _provider_order(),
        "set_api_configured": set_api_configured(),
        "settrade_configured": settrade_configured(),
        "public_fallback_enabled": PUBLIC_FALLBACK_ENABLED,
        "settrade_missing_credentials": missing_settrade_credentials(),
        "python_sdk_loaded": Investor is not None,
        "settrade_sdk": "settrade-v2",
        "settrade_sdk_version": SETTRADE_SDK_VERSION,
        "settrade_environment": SETTRADE_ENV,
        "realtime_marketdata_enabled": REALTIME_ENABLED,
        "realtime_bid_offer_enabled": REALTIME_BOOK,
        "realtime_symbol_target": len(SYMBOLS),
        "realtime_quote_count": quote_count,
        "latest_quote_age_sec": _latest_quote_age_sec(),
        "stale_after_sec": STALE_AFTER_SEC,
        "collector_started": _collector_started,
        "collector_error": _collector_error,
        "provider_failures": dict(_provider_failures),
        "channel_status": _channel_snapshot(),
        "system_status": _system_status(),
        "connectivity_proof": _connectivity_proof(),
    }
# LUNA production release marker: public quote stream