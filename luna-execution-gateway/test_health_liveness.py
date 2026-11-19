"""Regression test for the gateway's liveness endpoint.

This test calls the ASGI application directly; it makes no network requests,
does not start provider collectors, and cannot place orders.
"""
import asyncio
import json
from unittest.mock import patch

import app as gateway_app


async def _request_health():
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/health",
        "raw_path": b"/health",
        "query_string": b"",
        "headers": [],
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 12345),
        "root_path": "",
    }
    await gateway_app.app(scope, receive, send)
    return messages


def test_health_is_liveness_even_when_diagnostics_fail():
    with patch(
        "app._system_status",
        side_effect=RuntimeError("readiness diagnostic deliberately unavailable"),
    ):
        messages = asyncio.run(_request_health())

    response = next(message for message in messages if message["type"] == "http.response.start")
    body = next(message for message in messages if message["type"] == "http.response.body")
    payload = json.loads(body["body"].decode("utf-8"))

    assert response["status"] == 200, f"liveness endpoint returned HTTP {response['status']}"
    assert payload["ok"] is True
    assert payload["status"] == "LOCKED"
    assert payload["live_armed"] is False, "paper-safe default must remain disarmed"


if __name__ == "__main__":
    test_health_is_liveness_even_when_diagnostics_fail()
    print("gateway health liveness regression: PASS")
