import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

try:
    from settrade.openapi import Investor
except Exception:  # pragma: no cover
    Investor = None

APP_VERSION = "0.5.0"
app = FastAPI(title="LUNA Execution + Market Data Gateway", version=APP_VERSION)

LIVE_ARMED = os.getenv("LIVE_TRADING_ARMED", "false").lower() == "true"
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "")

# Market-data providers are selected automatically unless explicitly forced.
# Priority in AUTO mode:
#   1) official SET Market Data API (api-key)
#   2) Settrade Open API (broker/app credentials)
PROVIDER_MODE = os.getenv("LUNA_MARKETDATA_PROVIDER", "AUTO").upper()
SET_API_KEY = os.getenv("SET_MARKETDATA_API_KEY", "")
SET_API_BASE = os.getenv(
    "SET_MARKETDATA_API_BASE",
    "https://marketplace.set.or.th/api/public/realtime-data/stock",
)
SET_API_POLL_SEC = max(1.0, float(os.getenv("SET_MARKETDATA_POLL_SEC", "2")))
SET_API_TIMEOUT_SEC = max(2.0, float(os.getenv("SET_MARKETDATA_TIMEOUT_SEC", "8")))

# Paper-only public fallback. TradingView's public Thailand screener is not
# treated as exchange-certified real-time data; it is used only to keep the
# Paper Trading pipeline alive when licensed providers are unavailable.
TRADINGVIEW_URL = os.getenv("TRADINGVIEW_SCANNER_URL", "https://scanner.tradingview.com/thailand/scan")
TRADINGVIEW_POLL_SEC = max(2.0, float(os.getenv("TRADINGVIEW_POLL_SEC", "5")))
PUBLIC_FALLBACK_ENABLED = (
    os.getenv("LUNA_PUBLIC_MARKETDATA_FALLBACK", "true").lower() == "true"
    and not LIVE_ARMED
)

BROKER_ID = os.getenv("LUNA_SETTRADE_BROKER_ID") or os.getenv("SETTRADE_BROKER_ID", "")
APP_ID = os.getenv("LUNA_SETTRADE_APP_ID") or os.getenv("SETTRADE_APP_ID", "")
APP_SECRET = os.getenv("LUNA_SETTRADE_APP_SECRET") or os.getenv("SETTRADE_APP_SECRET", "")
APP_CODE = os.getenv("LUNA_SETTRADE_APP_CODE") or os.getenv("SETTRADE_APP_CODE", "")

REALTIME_ENABLED = os.getenv("REALTIME_MARKETDATA_ENABLED", "false").lower() == "true"
REALTIME_BOOK = os.getenv("REALTIME_BID_OFFER_ENABLED", "true").lower() == "true"
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

_feed_lock = threading.Lock()
_collector_started = False
_collector_error: Optional[str] = None
_supervisor_started = False
_selected_provider: Optional[str] = None
_provider_restarts = 0
_provider_failures: Dict[str, int] = {"SET_API": 0, "SETTRADE": 0}

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


def _first_number(mapping: Dict[str, Any], keys):
    for key in keys:
        value = _num(mapping.get(key))
        if value is not None:
            return value
    return None


def _normalize_open_orders(eq):
    getter = getattr(eq, "get_orders", None)
    if not callable(getter):
        raise ProviderUnavailable("settrade_get_orders_method_unavailable")

    raw = getter()
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

        positions.append({
            "symbol": symbol,
            "qty": qty,
            "avg_price": avg_price,
            "market_price": _first_number(row, (
                "market_price",
                "last_price",
                "close_price",
            )),
            "market_value": _first_number(row, (
                "market_value",
                "amount",
                "total_market_value",
            )),
            "unrealized_pnl": _first_number(row, (
                "profit",
                "unrealized_profit",
            )),
            "realized_pnl": _first_number(row, (
                "realize_profit",
                "realized_profit",
            )),
        })

    return {
        "ok": True,
        "as_of": _now_iso(),
        "cash": cash,
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


def _quote_payload(
    symbol: str,
    last: Any = None,
    bid: Any = None,
    ask: Any = None,
    bid_size: Any = None,
    ask_size: Any = None,
    source: str = "",
    source_ts: Any = None,
    raw: Any = None,
    total_volume: Any = None,
):
    now = _now_iso()
    with _quote_lock:
        prior = dict(_quotes.get(symbol, {}))
        quote = {
            "symbol": symbol,
            "ts": now,
            "source_ts": source_ts,
            "bid": _num(bid) if bid is not None else prior.get("bid"),
            "ask": _num(ask) if ask is not None else prior.get("ask"),
            "last": _num(last) if last is not None else prior.get("last"),
            "bid_size": _num(bid_size) if bid_size is not None else prior.get("bid_size"),
            "ask_size": _num(ask_size) if ask_size is not None else prior.get("ask_size"),
            "total_volume": _num(total_volume) if total_volume is not None else prior.get("total_volume"),
            "source": source or prior.get("source"),
            "raw": raw,
            "_ingested_ts": time.time(),
        }
        was_new = symbol not in _quotes
        _quotes[symbol] = quote
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
        for key in ("data", "result", "results", "items"):
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
    mqtt = inv.MQTTWebsocket()
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
    if PROVIDER_MODE == "SET_API":
        return ["SET_API"]
    if PROVIDER_MODE == "SETTRADE":
        return ["SETTRADE"]
    # AUTO: licensed sources first; public scanner is paper-only last resort.
    order = ["SET_API", "SETTRADE"]
    if PUBLIC_FALLBACK_ENABLED:
        order.append("TRADINGVIEW_PUBLIC")
    return order


def _provider_available(name: str):
    if name == "SET_API":
        return set_api_configured()
    if name == "SETTRADE":
        return settrade_configured()
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
        "version": APP_VERSION,
        "live_armed": LIVE_ARMED,
        "provider_mode": PROVIDER_MODE,
        "selected_provider": _selected_provider,
        "provider_candidates": _provider_order(),
        "set_api_configured": set_api_configured(),
        "settrade_configured": settrade_configured(),
        "public_fallback_enabled": PUBLIC_FALLBACK_ENABLED,
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
        "timestamp": int(time.time()),
    }


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
        "version": APP_VERSION,
        "live_armed": LIVE_ARMED,
        "provider_mode": PROVIDER_MODE,
        "selected_provider": _selected_provider,
        "provider_candidates": _provider_order(),
        "set_api_configured": set_api_configured(),
        "settrade_configured": settrade_configured(),
        "public_fallback_enabled": PUBLIC_FALLBACK_ENABLED,
        "settrade_missing_credentials": missing_settrade_credentials(),
        "python_sdk_loaded": Investor is not None,
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
    }