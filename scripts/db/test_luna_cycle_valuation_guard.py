#!/usr/bin/env python3
"""Isolated PostgreSQL behavioral regression matrix for LUNA paper valuation.

This intentionally exercises only the paper-cycle function against a disposable
PostgreSQL schema. It never connects to Supabase production and never creates
broker orders.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/202610170003_luna_cycle_fail_closed_valuation.sql"

EXPERIMENT = "LUNA-PAPER-LIVE-15M-VERIFIED"
STRATEGY = "luna-th1h-v1.4.0-15m-riskgated"
SESSION = "00000000-0000-0000-0000-000000000001"


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "postgres"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
    )


def setup(conn):
    with conn.cursor() as cur:
        cur.execute("DROP FUNCTION IF EXISTS public.luna_run_live_paper_cycle(text,text,numeric,numeric,numeric) CASCADE;")
        for table in (
            "luna_paper_equity_snapshots", "luna_paper_trade_ledger", "luna_paper_live_orders",
            "luna_shadow_15m_decisions", "luna_shadow_15m_bars", "luna_paper_live_positions",
            "luna_paper_live_runtime", "luna_market_ticks", "luna_sessions",
        ):
            cur.execute(f"DROP TABLE IF EXISTS public.{table} CASCADE;")

        cur.execute("""
        CREATE TABLE public.luna_sessions (
          id uuid PRIMARY KEY, session_date date NOT NULL, started_at timestamptz NOT NULL,
          ended_at timestamptz, status text NOT NULL, strategy_version text
        );
        CREATE TABLE public.luna_market_ticks (
          session_id uuid NOT NULL, symbol text NOT NULL, ts timestamptz NOT NULL,
          bid numeric, ask numeric, last numeric, bid_size bigint, ask_size bigint,
          source text NOT NULL, raw jsonb NOT NULL, created_at timestamptz NOT NULL
        );
        CREATE TABLE public.luna_shadow_15m_bars (
          session_id uuid NOT NULL, bar_end timestamptz NOT NULL, verified_book_tick_count integer NOT NULL
        );
        CREATE TABLE public.luna_shadow_15m_decisions (
          session_id uuid NOT NULL, strategy_version text NOT NULL, bar_end timestamptz NOT NULL,
          candidate_action text NOT NULL, feed_verified boolean, verified_book boolean,
          execution_blocked boolean, close numeric, momentum_1 numeric, symbol text NOT NULL
        );
        CREATE TABLE public.luna_paper_live_runtime (
          experiment_code text PRIMARY KEY, strategy_version text, session_id uuid,
          initial_capital numeric, cash numeric, reserved_cash numeric, realized_pnl numeric,
          fees numeric, peak_equity numeric, last_heartbeat timestamptz, status text,
          paper_only boolean, fill_model text, fee_bps numeric, slippage_bps numeric,
          last_signal_bar_end timestamptz, updated_at timestamptz
        );
        CREATE TABLE public.luna_paper_live_positions (
          experiment_code text NOT NULL, symbol text NOT NULL, qty bigint NOT NULL,
          avg_price numeric, cost_basis numeric, realized_pnl numeric, updated_at timestamptz,
          PRIMARY KEY (experiment_code, symbol)
        );
        CREATE TABLE public.luna_paper_live_orders (
          id bigserial PRIMARY KEY, experiment_code text NOT NULL, strategy_version text,
          session_id uuid, signal_bar_end timestamptz, fill_bar_end timestamptz, symbol text,
          side text, qty_requested bigint, qty_filled bigint, status text, reference_price numeric,
          reserved_cash numeric, confidence numeric, decision_hash text, reason text,
          execution_quote_ts timestamptz, fill_price numeric, gross_notional numeric,
          estimated_fee numeric, estimated_slippage numeric, total_cost numeric,
          filled_at timestamptz, updated_at timestamptz
        );
        CREATE TABLE public.luna_paper_trade_ledger (
          id bigserial PRIMARY KEY, experiment_code text, strategy_version text, session_id uuid,
          bar_end timestamptz, symbol text, side text, qty bigint, fill_price numeric,
          gross_notional numeric, estimated_fee numeric, estimated_slippage numeric, total_cost numeric,
          realized_pnl numeric, position_qty_after bigint, cash_after numeric, fill_model text,
          confidence numeric, decision_hash text, execution_quote_ts timestamptz
        );
        CREATE TABLE public.luna_paper_equity_snapshots (
          experiment_code text NOT NULL, strategy_version text NOT NULL, session_id uuid NOT NULL,
          ts timestamptz NOT NULL, cash numeric, market_value numeric, equity numeric,
          realized_pnl numeric, unrealized_pnl numeric, fees numeric, drawdown_thb numeric, drawdown_pct numeric,
          UNIQUE (experiment_code, strategy_version, ts)
        );
        INSERT INTO public.luna_sessions VALUES
          (%s, current_date, now() - interval '10 minutes', now() + interval '1 hour', 'OPEN', %s);
        INSERT INTO public.luna_shadow_15m_bars VALUES
          (%s, now() - interval '1 minute', 1);
        INSERT INTO public.luna_paper_live_runtime VALUES
          (%s, %s, %s, 30000, 10000, 0, 0, 0, 30000, now(), 'RUNNING', true,
           'NEXT_BAR_BID_ASK', 10, 10, NULL, now());
        INSERT INTO public.luna_paper_live_positions VALUES
          (%s, 'PTT', 100, 30, 3000, 0, now());
        """, (SESSION, STRATEGY, SESSION, EXPERIMENT, STRATEGY, SESSION, EXPERIMENT))
    conn.commit()


def install(conn):
    sql = MIGRATION.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def reset_state(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.luna_market_ticks;")
        cur.execute("DELETE FROM public.luna_paper_equity_snapshots;")
        cur.execute("DELETE FROM public.luna_paper_live_orders;")
        cur.execute("DELETE FROM public.luna_paper_trade_ledger;")
        cur.execute("UPDATE public.luna_paper_live_runtime SET cash=10000,reserved_cash=0,realized_pnl=0,fees=0,peak_equity=30000,last_signal_bar_end=NULL,session_id=%s,updated_at=now() WHERE experiment_code=%s;", (SESSION, EXPERIMENT))
        cur.execute("DELETE FROM public.luna_paper_live_positions;")
        cur.execute("INSERT INTO public.luna_paper_live_positions VALUES (%s,'PTT',100,30,3000,0,now());", (EXPERIMENT,))
    conn.commit()


def cycle(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT public.luna_run_live_paper_cycle(%s,%s,30000,10,10);", (EXPERIMENT, STRATEGY))
        result = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM public.luna_paper_equity_snapshots;")
        snapshots = cur.fetchone()[0]
        cur.execute("SELECT peak_equity FROM public.luna_paper_live_runtime WHERE experiment_code=%s;", (EXPERIMENT,))
        peak = cur.fetchone()[0]
    conn.commit()
    return result, snapshots, peak


def insert_tick(conn, *, age_seconds=5, verified=True, bid=34.5, ask=34.75, bid_size=1000, ask_size=1200, ts_offset_seconds=0):
    marker = {"vendor": "fixture"}
    if verified:
        marker.update({"data_quality": "verified", "verified": True, "verification_source": "TOPTRADER_REALTIME"})
    with conn.cursor() as cur:
        cur.execute("""
          INSERT INTO public.luna_market_ticks
          VALUES (%s,'PTT',now() - (%s || ' seconds')::interval + (%s || ' seconds')::interval,
                  %s,%s,34.6,%s,%s,'TOPTRADER_REALTIME',%s,now());
        """, (SESSION, age_seconds, ts_offset_seconds, bid, ask, bid_size, ask_size, json.dumps(marker)))
    conn.commit()


def assert_incomplete(conn, name, **tick):
    reset_state(conn)
    if tick:
        insert_tick(conn, **tick)
    result, snapshots, peak = cycle(conn)
    assert result["status"] == "VALUATION_INCOMPLETE", (name, result)
    assert result["valuation_ready"] is False, (name, result)
    assert result["snapshot_written"] is False, (name, result)
    assert result["peak_equity_updated"] is False, (name, result)
    assert snapshots == 0, (name, snapshots)
    assert float(peak) == 30000.0, (name, peak)
    print(f"PASS {name}: {result['unpriced_symbols']}")


def assert_complete(conn):
    reset_state(conn)
    insert_tick(conn)
    result, snapshots, peak = cycle(conn)
    assert result["status"] == "RUNNING", result
    assert snapshots == 1, snapshots
    assert float(peak) == 30000.0, peak
    assert float(result["current_equity"]) == 13450.0, result
    print("PASS fresh verified quote: snapshot written with liquidation-side bid")


def main():
    conn = connect()
    try:
        setup(conn)
        install(conn)
        assert_complete(conn)
        assert_incomplete(conn, "missing quote")
        assert_incomplete(conn, "stale quote", age_seconds=61)
        assert_incomplete(conn, "unverified quote", verified=False)
        assert_incomplete(conn, "future quote", age_seconds=0, ts_offset_seconds=2)
        assert_incomplete(conn, "zero bid size", bid_size=0)
        assert_incomplete(conn, "zero ask size", ask_size=0)
        assert_incomplete(conn, "ask below bid", bid=35, ask=34.5)
        assert_incomplete(conn, "negative bid", bid=-1, ask=1)
        print("PASS cycle valuation regression matrix: 9 cases")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
