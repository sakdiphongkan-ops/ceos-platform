# LUNA SETTRADE Local Realtime Bridge

This bridge keeps SETTRADE Open API credentials on the user's own PC. It subscribes to realtime price and best bid/offer through the official Settrade Python SDK v2, then sends normalized market-data snapshots to the LUNA Gateway.

The cloud gateway is already healthy. The local bridge avoids placing broker secrets in the public web app. It only needs outbound network access from the PC.

Setup:
1. Use a broker that currently offers Settrade Open API for equities.
2. Activate Settrade Open API with the broker and obtain SETTRADE_BROKER_ID, SETTRADE_APP_ID, SETTRADE_APP_SECRET and SETTRADE_APP_CODE.
3. Copy .env.example to .env and fill the broker values, LUNA Gateway key, and a small symbol list.
4. Run run_windows.bat.

Start with 5-10 symbols for validation. Expand to the full LUNA universe only after realtime paper testing is stable.

The bridge never enables live trading. LIVE_TRADING_ARMED stays false in Railway.

Official references:
https://www.settrade.com/th/services-and-tools/brokers
https://www.settrade.com/th/services-and-tools/trading-program/advance/main
https://developer.settrade.com/open-api/
