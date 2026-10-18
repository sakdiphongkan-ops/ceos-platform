#!/usr/bin/env python3
"""Isolated PostgreSQL regression matrix for the paper equity snapshot guard."""
from __future__ import annotations

import json
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261018014128_202610170001_luna_paper_snapshot_valuation_guard.sql"
SESSION = "00000000-0000-0000-0000-000000000001"
EXPERIMENT = "LUNA-PAPER-LIVE-15M-VERIFIED"


def connect():
    return psycopg2.connect(host=os.environ.get("PGHOST", "127.0.0.1"), port=int(os.environ.get("PGPORT", "5432")), dbname=os.environ.get("PGDATABASE", "postgres"), user=os.environ.get("PGUSER", "postgres"), password=os.environ.get("PGPASSWORD", "postgres"))


def setup(conn):
    with conn.cursor() as cur:
        cur.execute("DROP FUNCTION IF EXISTS public.luna_guard_paper_equity_snapshot_valuation() CASCADE;")
        for table in ("luna_paper_equity_snapshots", "luna_market_ticks", "luna_paper_live_positions"):
            cur.execute(f"DROP TABLE IF EXISTS public.{table} CASCADE;")
        cur.execute("""
        CREATE TABLE public.luna_paper_live_positions (experiment_code text NOT NULL, symbol text NOT NULL, qty bigint NOT NULL, PRIMARY KEY (experiment_code, symbol));
        CREATE TABLE public.luna_market_ticks (session_id uuid NOT NULL, symbol text NOT NULL, ts timestamptz NOT NULL, bid numeric, ask numeric, bid_size bigint, ask_size bigint, source text NOT NULL, raw jsonb NOT NULL);
        CREATE TABLE public.luna_paper_equity_snapshots (experiment_code text NOT NULL, strategy_version text NOT NULL, session_id uuid NOT NULL, ts timestamptz NOT NULL, equity numeric, UNIQUE (experiment_code, strategy_version, ts));
        INSERT INTO public.luna_paper_live_positions VALUES (%s,'PTT',100),(%s,'CPALL',100);
        """, (EXPERIMENT, EXPERIMENT))
    conn.commit()


def install(conn):
    with conn.cursor() as cur:
        cur.execute(MIGRATION.read_text(encoding="utf-8"))
    conn.commit()


def reset_ticks(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.luna_market_ticks;")
        cur.execute("DELETE FROM public.luna_paper_equity_snapshots;")
    conn.commit()


def add_tick(conn, symbol="PTT", age=5, verified=True, session=SESSION, bid=34.5, ask=34.75, bid_size=1000, ask_size=1200, future_seconds=0, source="TOPTRADER_REALTIME"):
    raw = {"vendor": "fixture"}
    if verified:
        raw.update({"data_quality": "verified", "verified": True})
    with conn.cursor() as cur:
        cur.execute("INSERT INTO public.luna_market_ticks VALUES (%s,%s,now()-(%s || ' seconds')::interval+(%s || ' seconds')::interval,%s,%s,%s,%s,%s,%s);", (session, symbol, age, future_seconds, bid, ask, bid_size, ask_size, source, json.dumps(raw)))
    conn.commit()


def snapshot(conn):
    with conn.cursor() as cur:
        cur.execute("INSERT INTO public.luna_paper_equity_snapshots VALUES (%s,'test',%s,now(),10000);", (EXPERIMENT, SESSION))
    conn.commit()


def expect_block(conn, name):
    try:
        snapshot(conn)
    except psycopg2.Error as exc:
        conn.rollback()
        assert exc.pgcode == "23514", (name, exc.pgcode, exc)
        assert "LUNA_VALUATION_INCOMPLETE" in str(exc), (name, exc)
        print(f"PASS {name}: blocked fail-closed")
        return
    raise AssertionError(f"{name}: snapshot unexpectedly accepted")


def expect_allow(conn, name):
    snapshot(conn)
    print(f"PASS {name}: snapshot accepted")



def expect_update_block(conn, name):
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM public.luna_paper_equity_snapshots WHERE experiment_code=%s;", (EXPERIMENT,))
            snapshot_count = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM public.luna_paper_live_positions WHERE experiment_code=%s AND qty>0;", (EXPERIMENT,))
            open_positions = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM public.luna_market_ticks WHERE symbol='CPALL';")
            cpall_ticks = cur.fetchone()[0]
            assert snapshot_count == 1, (name, "snapshot row count", snapshot_count)
            assert open_positions == 2, (name, "open position count", open_positions)
            assert cpall_ticks == 0, (name, "CPALL tick rows after deletion", cpall_ticks)
            cur.execute("UPDATE public.luna_paper_equity_snapshots SET equity=equity+1 WHERE experiment_code=%s RETURNING experiment_code;", (EXPERIMENT,))
            updated_rows = cur.fetchall()
            assert len(updated_rows) == 1, (name, "updated row count", len(updated_rows))
        conn.commit()
    except psycopg2.Error as exc:
        conn.rollback()
        assert exc.pgcode == "23514", (name, exc.pgcode, exc)
        assert "LUNA_VALUATION_INCOMPLETE" in str(exc), (name, exc)
        print(f"PASS {name}: update rejected fail-closed")
        return
    raise AssertionError(f"{name}: invalid snapshot update unexpectedly accepted")


def assert_cash_only_allowed(conn):
    reset_ticks(conn)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.luna_paper_live_positions WHERE experiment_code=%s;", (EXPERIMENT,))
    conn.commit()
    expect_allow(conn, "cash-only account with no open positions")


def assert_update_guard(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.luna_paper_live_positions WHERE experiment_code=%s;", (EXPERIMENT,))
        cur.execute("INSERT INTO public.luna_paper_live_positions VALUES (%s,'PTT',100),(%s,'CPALL',100);", (EXPERIMENT, EXPERIMENT))
    conn.commit()
    reset_ticks(conn)
    add_tick(conn, "PTT")
    add_tick(conn, "CPALL")
    expect_allow(conn, "prepare snapshot before invalid update")
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.luna_market_ticks WHERE symbol='CPALL';")
    conn.commit()
    expect_update_block(conn, "update after one held symbol loses quote")


def main():
    conn = connect()
    try:
        setup(conn)
        install(conn)
        reset_ticks(conn)
        add_tick(conn, "PTT")
        add_tick(conn, "CPALL")
        expect_allow(conn, "fresh verified books for every held symbol")

        reset_ticks(conn)
        add_tick(conn, "PTT")
        expect_block(conn, "held symbol missing quote")

        reset_ticks(conn)
        add_tick(conn, "PTT", age=61)
        add_tick(conn, "CPALL")
        expect_block(conn, "stale quote")

        reset_ticks(conn)
        add_tick(conn, "PTT", verified=False)
        add_tick(conn, "CPALL")
        expect_block(conn, "unverified raw marker")

        reset_ticks(conn)
        add_tick(conn, "PTT", bid_size=0)
        add_tick(conn, "CPALL")
        expect_block(conn, "zero bid size")

        reset_ticks(conn)
        add_tick(conn, "PTT", ask_size=0)
        add_tick(conn, "CPALL")
        expect_block(conn, "zero ask size")

        reset_ticks(conn)
        add_tick(conn, "PTT", bid=35, ask=34.5)
        add_tick(conn, "CPALL")
        expect_block(conn, "ask below bid")

        reset_ticks(conn)
        add_tick(conn, "PTT", session="00000000-0000-0000-0000-000000000002")
        add_tick(conn, "CPALL")
        expect_block(conn, "session mismatch")

        reset_ticks(conn)
        add_tick(conn, "PTT", source="UNVERIFIED_VENDOR")
        add_tick(conn, "CPALL")
        expect_block(conn, "wrong source")

        reset_ticks(conn)
        add_tick(conn, "PTT", future_seconds=30)
        add_tick(conn, "CPALL")
        expect_block(conn, "future quote beyond allowed skew")

        reset_ticks(conn)
        add_tick(conn, "PTT", bid=None)
        add_tick(conn, "CPALL")
        expect_block(conn, "null bid")

        reset_ticks(conn)
        add_tick(conn, "PTT", ask=None)
        add_tick(conn, "CPALL")
        expect_block(conn, "null ask")

        reset_ticks(conn)
        add_tick(conn, "PTT", bid_size=-1)
        add_tick(conn, "CPALL")
        expect_block(conn, "negative bid size")

        reset_ticks(conn)
        add_tick(conn, "PTT", ask_size=-1)
        add_tick(conn, "CPALL")
        expect_block(conn, "negative ask size")

        assert_cash_only_allowed(conn)
        assert_update_guard(conn)
        print("PASS snapshot guard regression matrix: expanded insert/update cases")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
