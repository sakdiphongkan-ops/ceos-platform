from __future__ import annotations

import logging
import os
import queue
import threading
import time
from datetime import datetime, timezone
from typing import Any

import requests
from dotenv import load_dotenv
from settrade_v2 import Investor
from settrade_v2.config import config as settrade_config

load_dotenv()

LOG = logging.getLogger("luna-settrade-bridge")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

APP_ID = os.getenv("SETTRADE_APP_ID", "").strip()
APP_SECRET = os.getenv("SETTRADE_APP_SECRET", "").strip()
APP_CODE = os.getenv("SETTRADE_APP_CODE", "").strip()
BROKER_ID = os.getenv("SETTRADE_BROKER_ID", "").strip()
SETTRADE_ENV = os.getenv("SETTRADE_ENV", "prod").strip()
GATEWAY_URL = os.getenv(
    "LUNA_GATEWAY_URL",
    "https://luna-execution-gateway-production.up.railway.app",
).rstrip("/")
GATEWAY_KEY = os.getenv("LUNA_GATEWAY_KEY", "").strip()
SYMBOLS = [s.strip().upper() for s in os.getenv("LUNA_SYMBOLS", "").split(",") if s.strip()]

BATCH_SIZE = max(1, int(os.getenv("LUNA_BATCH_SIZE", "100")))
FLUSH_MS = max(10, int(os.getenv("LUNA_FLUSH_MS", "100")))
REQUEST_TIMEOUT = max(2, float(os.getenv("LUNA_REQUEST_TIMEOUT_SEC", "10")))
RECONNECT_SEC = max(2, float(os.getenv("LUNA_RECONNECT_SEC", "5")))

REQUIRED = {
    "SETTRADE_APP_ID": APP_ID,
    "SETTRADE_APP_SECRET": APP_SECRET,
    "SETTRADE_APP_CODE": APP_CODE,
    "SETTRADE_BROKER_ID": BROKER_ID,
    "LUNA_GATEWAY_KEY": GATEWAY_KEY,
    "LUNA_SYMBOLS": ",".join(SYMBOLS),
}

OUTBOX: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=20000)
STOP = threading.Event()
STATE_LOCK = threading.Lock()
LATEST: dict[str, dict[str, Any]] = {}
STATS = {
    "events": 0,
    "enqueued": 0,
    "sent": 0,
    "rejected": 0,
    "errors": 0,
    "last_event": None,
    "last_send": None,
    "last_error": None,
}

SESSION = requests.Session()
SESSION.headers.update(
    {
        "Content-Type": "application/json",
        "X-Luna-Gateway": GATEWAY_KEY,
        "User-Agent": "LUNA-SETTRADE-LOCAL-BRIDGE/1.0",
    }
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_config() -> None:
    missing = [key for key, value in REQUIRED.items() if not value]
    if missing:
        raise SystemExit("Missing configuration: " + ", ".join(missing))


def set_stats(**changes: Any) -> None:
    with STATE_LOCK:
        STATS.update(changes)


def current_stat(name: str) -> int:
    with STATE_LOCK:
        return int(STATS[name])


def merge_quote(symbol: str, channel: str, data: dict[str, Any]) -> None:
    symbol = symbol.upper()
    with STATE_LOCK:
        quote = LATEST.setdefault(symbol, {"symbol": symbol})
        if channel == "price":
            if data.get("last") is not None:
                quote["last"] = data.get("last")
            if data.get("total_volume") is not None:
                quote["total_volume"] = data.get("total_volume")
        else:
            for key in ("bid", "ask", "bid_size", "ask_size"):
                if data.get(key) is not None:
                    quote[key] = data.get(key)
        quote["source_ts"] = (
            data.get("time")
            or data.get("timestamp")
            or data.get("update_time")
            or quote.get("source_ts")
        )
        quote["source"] = "settrade-open-api-local"
        quote["raw"] = data
        snapshot = dict(quote)

    try:
        OUTBOX.put_nowait(snapshot)
        set_stats(enqueued=current_stat("enqueued") + 1)
    except queue.Full:
        LOG.warning("ingest queue full; dropping quote for %s", symbol)
        set_stats(errors=current_stat("errors") + 1, last_error="queue_full")


def handle_result(symbol: str, channel: str, result: dict[str, Any]) -> None:
    set_stats(events=current_stat("events") + 1, last_event=now_iso())
    if not result.get("is_success"):
        message = result.get("message") or result.get("data") or "unknown realtime error"
        LOG.warning("%s error %s: %s", channel, symbol, message)
        set_stats(errors=current_stat("errors") + 1, last_error=str(message))
        return

    data = dict(result.get("data") or {})
    data["symbol"] = str(data.get("symbol") or symbol).upper()

    normalized: dict[str, Any] = {"time": data.get("time") or data.get("timestamp"), "raw": data}
    if channel == "price":
        normalized["last"] = data.get("last")
        normalized["total_volume"] = data.get("total_volume") or data.get("totalVolume")
    else:
        normalized["bid"] = data.get("bid_price1")
        normalized["ask"] = data.get("ask_price1")
        normalized["bid_size"] = data.get("bid_volume1")
        normalized["ask_size"] = data.get("ask_volume1")

    merge_quote(symbol, channel, normalized)


def on_bid_offer(result: dict[str, Any], symbol: str) -> None:
    handle_result(symbol, "book", result)


def on_price_info(result: dict[str, Any], symbol: str) -> None:
    handle_result(symbol, "price", result)


def sender_loop() -> None:
    endpoint = f"{GATEWAY_URL}/marketdata/ingest"
    LOG.info("Gateway target: %s", endpoint)

    while not STOP.is_set():
        batch = []
        try:
            batch.append(OUTBOX.get(timeout=0.5))
        except queue.Empty:
            continue

        deadline = time.monotonic() + FLUSH_MS / 1000.0
        while len(batch) < BATCH_SIZE and time.monotonic() < deadline:
            try:
                batch.append(OUTBOX.get_nowait())
            except queue.Empty:
                time.sleep(0.005)

        try:
            response = SESSION.post(
                endpoint,
                json={"quotes": batch[:BATCH_SIZE]},
                timeout=REQUEST_TIMEOUT,
            )
            if response.status_code == 200:
                body = response.json()
                accepted = int(body.get("accepted", 0))
                set_stats(
                    sent=current_stat("sent") + accepted,
                    last_send=now_iso(),
                    last_error=None,
                )
            else:
                set_stats(
                    rejected=current_stat("rejected") + len(batch),
                    errors=current_stat("errors") + 1,
                    last_error=f"gateway_http_{response.status_code}:{response.text[:200]}",
                )
                LOG.error("Gateway rejected batch: HTTP %s %s", response.status_code, response.text[:300])
        except Exception as exc:
            set_stats(errors=current_stat("errors") + 1, last_error=str(exc))
            LOG.error("Gateway ingest failed: %s", exc)


def collector_loop() -> None:
    retry = RECONNECT_SEC

    while not STOP.is_set():
        subscribers = []
        realtime = None

        try:
            settrade_config["environment"] = SETTRADE_ENV
            investor = Investor(
                app_id=APP_ID,
                app_secret=APP_SECRET,
                app_code=APP_CODE,
                broker_id=BROKER_ID,
                is_auto_queue=True,
            )
            realtime = investor.RealtimeDataConnection()

            for symbol in SYMBOLS:
                subscribers.append(
                    realtime.subscribe_bid_offer(
                        symbol,
                        on_message=on_bid_offer,
                        args=(symbol,),
                    )
                )
                subscribers.append(
                    realtime.subscribe_price_info(
                        symbol,
                        on_message=on_price_info,
                        args=(symbol,),
                    )
                )

            for subscriber in subscribers:
                subscriber.start()

            LOG.info(
                "SETTRADE realtime connected: broker=%s env=%s symbols=%d",
                BROKER_ID,
                SETTRADE_ENV,
                len(SYMBOLS),
            )
            retry = RECONNECT_SEC

            while not STOP.wait(1.0):
                pass

        except Exception as exc:
            set_stats(errors=current_stat("errors") + 1, last_error=str(exc))
            LOG.exception("SETTRADE realtime connection failed")
            if STOP.wait(retry):
                break
            retry = min(60, retry * 2)

        finally:
            for subscriber in subscribers:
                try:
                    subscriber.stop()
                except Exception:
                    pass
            if realtime is not None:
                try:
                    realtime._stop()
                except Exception:
                    pass


def main() -> None:
    validate_config()

    sender = threading.Thread(target=sender_loop, name="luna-gateway-sender", daemon=True)
    collector = threading.Thread(target=collector_loop, name="settrade-realtime", daemon=True)
    sender.start()
    collector.start()

    LOG.info("LUNA bridge started. Symbols=%d gateway=%s", len(SYMBOLS), GATEWAY_URL)

    try:
        while True:
            time.sleep(10)
            with STATE_LOCK:
                LOG.info(
                    "bridge stats events=%d enqueued=%d sent=%d rejected=%d errors=%d last_event=%s last_send=%s",
                    STATS["events"],
                    STATS["enqueued"],
                    STATS["sent"],
                    STATS["rejected"],
                    STATS["errors"],
                    STATS["last_event"],
                    STATS["last_send"],
                )
    except KeyboardInterrupt:
        LOG.info("Stopping LUNA bridge")
    finally:
        STOP.set()
        sender.join(timeout=3)
        collector.join(timeout=5)


if __name__ == "__main__":
    main()
