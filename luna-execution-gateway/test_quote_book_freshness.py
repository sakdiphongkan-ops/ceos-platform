"""Regression tests for gateway bid/ask freshness tracking; no network or order side effects."""
import app as gateway_app


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
        assert first["book_source_ts"] is not None

        gateway_app._quote_payload(
            symbol=symbol, last=31.80,
            source="settrade-open-api-realtime", source_ts=None,
        )
        second = dict(gateway_app._quotes[symbol])
        assert second["book_received_ts"] == first["book_received_ts"]
        assert second["book_source_ts"] == first["book_source_ts"]
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


if __name__ == "__main__":
    test_price_only_event_does_not_refresh_order_book_age()
    print("gateway book freshness regression: PASS")
