"""Regression tests for gateway bid/ask freshness tracking; no network or order side effects."""
import app as gateway_app
from datetime import datetime, timedelta, timezone


def test_price_only_event_does_not_refresh_order_book_age():
    symbol = "LUNA_BOOK_FRESHNESS_TEST"
    gateway_app._quotes.pop(symbol, None)
    try:
        gateway_app._quote_payload(
            symbol=symbol, bid=31.75, ask=31.80, bid_size=100, ask_size=200,
            source="settrade-open-api-realtime", source_ts=None,
            book_snapshot=True,
        )
        first = dict(gateway_app._quotes[symbol])
        assert first["book_received_ts"] is not None
        # Source time must not be fabricated from local receive time.
        assert first["book_source_ts"] is None

        gateway_app._quote_payload(
            symbol=symbol, last=31.80,
            source="settrade-open-api-realtime", source_ts=None,
        )
        second = dict(gateway_app._quotes[symbol])
        assert second["book_received_ts"] == first["book_received_ts"]
        assert second["book_source_ts"] is None
        assert second["bid"] == 31.75 and second["ask"] == 31.80

        gateway_app._quote_payload(
            symbol=symbol, bid=31.76, ask=None, bid_size=100, ask_size=None,
            source="settrade-open-api-realtime", source_ts=None,
            book_snapshot=True,
        )
        partial = dict(gateway_app._quotes[symbol])
        assert partial["bid"] is None and partial["ask"] is None
        assert partial["bid_size"] is None and partial["ask_size"] is None
        assert partial["book_received_ts"] is None
        assert partial["book_source_ts"] is None
    finally:
        gateway_app._quotes.pop(symbol, None)


def test_stale_provider_timestamp_cannot_count_as_fresh_quote():
    symbol = "LUNA_SOURCE_FRESHNESS_TEST"
    old_symbols = gateway_app.SYMBOLS
    old_provider = gateway_app._selected_provider
    old_quotes = dict(gateway_app._quotes)
    try:
        gateway_app.SYMBOLS = [symbol]
        gateway_app._selected_provider = "SET_API"
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()

        stale_source_ts = (
            datetime.now(timezone.utc) - timedelta(seconds=120)
        ).isoformat()
        gateway_app._quote_payload(
            symbol=symbol,
            last=31.80,
            source="set-market-data-api-realtime",
            source_ts=stale_source_ts,
        )
        stale = gateway_app._quote_coverage_snapshot()
        assert stale["fresh_quote_count"] == 0

        fresh_source_ts = datetime.now(timezone.utc).isoformat()
        gateway_app._quote_payload(
            symbol=symbol,
            last=31.81,
            source="set-market-data-api-realtime",
            source_ts=fresh_source_ts,
        )
        fresh = gateway_app._quote_coverage_snapshot()
        assert fresh["fresh_quote_count"] == 1

        gateway_app._quote_payload(
            symbol=symbol,
            last=31.82,
            source="set-market-data-api-realtime-spoof",
            source_ts=datetime.now(timezone.utc).isoformat(),
        )
        spoof = gateway_app._quote_coverage_snapshot()
        assert spoof["fresh_quote_count"] == 0
    finally:
        with gateway_app._quote_lock:
            gateway_app._quotes.clear()
            gateway_app._quotes.update(old_quotes)
        gateway_app.SYMBOLS = old_symbols
        gateway_app._selected_provider = old_provider


if __name__ == "__main__":
    test_price_only_event_does_not_refresh_order_book_age()
    test_stale_provider_timestamp_cannot_count_as_fresh_quote()
    print("gateway book freshness regression: PASS")
