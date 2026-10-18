#!/usr/bin/env python3
"""Isolated PostgreSQL regression test for LUNA verified-ingest stamping."""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/202610170004_luna_verified_ingest_marker.sql"
IDEMPOTENCY_MIGRATION = ROOT / "supabase/migrations/20261018020000_luna_ingest_rejected_batch_idempotency.sql"


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
        cur.execute(
            """
            DROP FUNCTION IF EXISTS public.luna_ingest_verified_market_batch(text,timestamptz,text,boolean,jsonb);
            DROP FUNCTION IF EXISTS public.luna_register_verified_feed_heartbeat(text,timestamptz,integer,boolean,text);
            DROP TABLE IF EXISTS public.luna_market_ticks CASCADE;
            DROP TABLE IF EXISTS public.luna_market_ingest_batches CASCADE;
            DROP TABLE IF EXISTS public.luna_universe CASCADE;
            DROP TABLE IF EXISTS public.luna_sessions CASCADE;
            DROP TABLE IF EXISTS public.luna_verified_market_sources CASCADE;

            CREATE TABLE public.luna_verified_market_sources (
              source_code text PRIMARY KEY,
              configured boolean NOT NULL,
              enabled boolean NOT NULL,
              execution_grade boolean NOT NULL,
              book_grade boolean NOT NULL,
              source_type text NOT NULL,
              authority text NOT NULL,
              max_staleness_seconds integer NOT NULL
            );
            INSERT INTO public.luna_verified_market_sources VALUES
              ('TOPTRADER_REALTIME', true, true, true, true, 'BROKER_REALTIME', 'TOPTRADER', 60);

            CREATE TABLE public.luna_sessions (
              id uuid PRIMARY KEY,
              session_date date NOT NULL,
              started_at timestamptz NOT NULL,
              ended_at timestamptz,
              status text NOT NULL
            );
            INSERT INTO public.luna_sessions VALUES
              ('00000000-0000-0000-0000-000000000001', current_date,
               now() - interval '1 minute', now() + interval '1 hour', 'OPEN');

            CREATE TABLE public.luna_universe (
              symbol text PRIMARY KEY,
              is_active boolean NOT NULL
            );
            INSERT INTO public.luna_universe VALUES ('PTT', true);

            CREATE TABLE public.luna_market_ingest_batches (
              batch_id uuid PRIMARY KEY,
              source text NOT NULL,
              feed_ts timestamptz NOT NULL,
              symbol_count integer NOT NULL,
              tick_count integer NOT NULL,
              book_complete boolean NOT NULL,
              payload_hash text NOT NULL,
              accepted boolean NOT NULL,
              reject_reason text,
              session_id uuid
            );
            CREATE UNIQUE INDEX luna_market_ingest_batches_source_ts_hash_uq
              ON public.luna_market_ingest_batches(source, feed_ts, payload_hash);

            CREATE TABLE public.luna_market_ticks (
              session_id uuid NOT NULL,
              symbol text NOT NULL,
              ts timestamptz NOT NULL,
              bid numeric,
              ask numeric,
              last numeric,
              bid_size bigint,
              ask_size bigint,
              source text NOT NULL,
              raw jsonb NOT NULL,
              created_at timestamptz NOT NULL
            );

            CREATE FUNCTION public.luna_register_verified_feed_heartbeat(
              p_source text, p_feed_ts timestamptz, p_rows integer,
              p_book_complete boolean, p_payload_hash text
            ) RETURNS void LANGUAGE sql AS $$ SELECT; $$;
            """
        )
    conn.commit()


def install_baseline(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE FUNCTION public.luna_ingest_verified_market_batch(
              p_source text, p_feed_ts timestamptz, p_payload_hash text,
              p_book_complete boolean, p_rows jsonb
            ) RETURNS jsonb LANGUAGE plpgsql AS $fn$
            DECLARE v_session uuid := '00000000-0000-0000-0000-000000000001';
            BEGIN
              INSERT INTO public.luna_market_ticks
              SELECT v_session, upper(x.symbol), x.ts, x.bid, x.ask, x.last,
                     x.bid_size, x.ask_size, p_source, coalesce(x.raw, '{}'::jsonb), now()
              FROM jsonb_to_recordset(p_rows) x(
                symbol text, ts timestamptz, bid numeric, ask numeric, last numeric,
                bid_size bigint, ask_size bigint, raw jsonb
              );
              RETURN jsonb_build_object('ok', true, 'accepted', true);
            END;
            $fn$;
            """
        )
    conn.commit()


def install_migration(conn):
    sql = MIGRATION.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def install_idempotency_fix(conn):
    sql = IDEMPOTENCY_MIGRATION.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def run_contract(conn, expect_verified: bool):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT public.luna_ingest_verified_market_batch(
              'TOPTRADER_REALTIME', now(), 'sha-test-001', true,
              jsonb_build_array(jsonb_build_object(
                'symbol','PTT','ts',now(),'bid',34.50,'ask',34.75,'last',34.60,
                'bid_size',1000,'ask_size',1200,'raw',jsonb_build_object('vendor','fixture')
              ))
            );
            """
        )
        result = cur.fetchone()[0]
        cur.execute("SELECT raw FROM public.luna_market_ticks LIMIT 1;")
        raw = cur.fetchone()[0]
    conn.commit()

    verified = raw.get("data_quality") == "verified" and raw.get("verified") is True
    if verified != expect_verified:
        raise AssertionError(
            f"verification marker contract mismatch: expected={expect_verified}, "
            f"actual={verified}, result={json.dumps(result)}, raw={json.dumps(raw)}"
        )
    return result, raw



def run_rejected_batch_retry_contract(conn):
    feed_ts = datetime.now(timezone.utc)
    rows = [{
        "symbol": "PTT", "ts": feed_ts.isoformat(),
        "bid": 34.50, "ask": 34.75, "last": 34.60,
        "bid_size": 1000, "ask_size": 1200, "raw": {"vendor": "fixture"},
    }]
    payload_hash = "sha-retry-same-payload"
    results = []
    with conn.cursor() as cur:
        for book_complete in (False, True, True):
            cur.execute(
                """
                SELECT public.luna_ingest_verified_market_batch(
                  %s, %s, %s, %s, %s::jsonb
                );
                """,
                ("TOPTRADER_REALTIME", feed_ts, payload_hash, book_complete, json.dumps(rows)),
            )
            results.append(cur.fetchone()[0])
        conn.commit()

        first, retried, duplicate = results
        assert first["accepted"] is False, first
        assert retried["accepted"] is True and retried.get("idempotent") is False, retried
        assert duplicate["accepted"] is True and duplicate.get("idempotent") is True, duplicate
        batch_id = retried["batch_id"]
        cur.execute(
            "SELECT accepted, reject_reason FROM public.luna_market_ingest_batches WHERE batch_id=%s;",
            (batch_id,),
        )
        batch = cur.fetchone()
        cur.execute(
            "SELECT count(*) FROM public.luna_market_ticks WHERE raw->>'verification_batch_id'=%s;",
            (batch_id,),
        )
        inserted_ticks = cur.fetchone()[0]
    assert batch == (True, None), batch
    assert inserted_ticks == 1, (batch_id, inserted_ticks)
    return {"first_reject": first, "retry_accepted": retried, "accepted_duplicate": duplicate,
            "ticks_for_batch": inserted_ticks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("baseline", "migration", "fixed"), required=True)
    args = parser.parse_args()

    conn = connect()
    try:
        setup(conn)
        if args.mode == "baseline":
            install_baseline(conn)
            try:
                run_contract(conn, expect_verified=True)
            except AssertionError as exc:
                print(f"EXPECTED RED: {exc}")
                return 1
            raise AssertionError("baseline unexpectedly satisfied the verified-marker contract")

        install_migration(conn)
        result, raw = run_contract(conn, expect_verified=True)

        if args.mode == "migration":
            try:
                run_rejected_batch_retry_contract(conn)
            except AssertionError as exc:
                print(f"EXPECTED IDEMPOTENCY RED: {exc}")
                return 1
            raise AssertionError("pre-fix ingestion unexpectedly passed rejected-batch retry contract")

        install_idempotency_fix(conn)
        retry = run_rejected_batch_retry_contract(conn)
        print(json.dumps({"status": "PASS", "result": result, "raw": raw, "retry_contract": retry}, default=str))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
