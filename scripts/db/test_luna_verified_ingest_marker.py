#!/usr/bin/env python3
"""Isolated PostgreSQL regression test for LUNA verified-ingest stamping.

The test intentionally exercises the contract against a tiny schema, not the
production database. In baseline mode it installs the pre-fix behavior and
expects the verification assertion to fail. In migration mode it applies the
new SQL migration and expects the assertion to pass.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/202610170004_luna_verified_ingest_marker.sql"


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
            DROP SCHEMA IF EXISTS luna_test CASCADE;
            CREATE SCHEMA luna_test;
            SET search_path TO luna_test, public;

            CREATE TABLE luna_verified_market_sources (
              source_code text PRIMARY KEY,
              configured boolean NOT NULL,
              enabled boolean NOT NULL,
              execution_grade boolean NOT NULL,
              book_grade boolean NOT NULL,
              source_type text NOT NULL,
              authority text NOT NULL,
              max_staleness_seconds integer NOT NULL
            );
            INSERT INTO luna_verified_market_sources VALUES
              ('TOPTRADER_REALTIME', true, true, true, true, 'BROKER_REALTIME', 'TOPTRADER', 60);

            CREATE TABLE luna_sessions (
              id uuid PRIMARY KEY,
              session_date date NOT NULL,
              started_at timestamptz NOT NULL,
              ended_at timestamptz,
              status text NOT NULL
            );
            INSERT INTO luna_sessions VALUES
              ('00000000-0000-0000-0000-000000000001', current_date,
               now() - interval '1 minute', now() + interval '1 hour', 'OPEN');

            CREATE TABLE luna_universe (
              symbol text PRIMARY KEY,
              is_active boolean NOT NULL
            );
            INSERT INTO luna_universe VALUES ('PTT', true);

            CREATE TABLE luna_market_ingest_batches (
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

            CREATE TABLE luna_market_ticks (
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

            CREATE FUNCTION luna_register_verified_feed_heartbeat(
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
            CREATE FUNCTION luna_ingest_verified_market_batch(
              p_source text, p_feed_ts timestamptz, p_payload_hash text,
              p_book_complete boolean, p_rows jsonb
            ) RETURNS jsonb LANGUAGE plpgsql AS $fn$
            DECLARE v_session uuid := '00000000-0000-0000-0000-000000000001';
            BEGIN
              INSERT INTO luna_market_ticks
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
        cur.execute("SET search_path TO luna_test, public;")
        cur.execute(sql)
    conn.commit()


def run_contract(conn, expect_verified: bool):
    with conn.cursor() as cur:
        cur.execute("SET search_path TO luna_test, public;")
        cur.execute(
            """
            SELECT luna_ingest_verified_market_batch(
              'TOPTRADER_REALTIME', now(), 'sha-test-001', true,
              '[{"symbol":"PTT","ts":null,"bid":34.50,"ask":34.75,"last":34.60,"bid_size":1000,"ask_size":1200,"raw":{"vendor":"fixture"}}]'::jsonb
            );
            """
        )
        # The fixture timestamp is intentionally patched immediately below so
        # the database function receives a fresh timestamp without embedding a
        # client-side wall-clock value in the JSON literal.
        cur.execute("DELETE FROM luna_market_ticks;")
        cur.execute(
            """
            SELECT luna_ingest_verified_market_batch(
              'TOPTRADER_REALTIME', now(), 'sha-test-002', true,
              jsonb_build_array(jsonb_build_object(
                'symbol','PTT','ts',now(),'bid',34.50,'ask',34.75,'last',34.60,
                'bid_size',1000,'ask_size',1200,'raw',jsonb_build_object('vendor','fixture')
              ))
            );
            """
        )
        result = cur.fetchone()[0]
        cur.execute("SELECT raw FROM luna_market_ticks LIMIT 1;")
        raw = cur.fetchone()[0]
    conn.commit()

    verified = raw.get("data_quality") == "verified" and raw.get("verified") is True
    if verified != expect_verified:
        raise AssertionError(
            f"verification marker contract mismatch: expected={expect_verified}, "
            f"actual={verified}, result={json.dumps(result)}, raw={json.dumps(raw)}"
        )
    return result, raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("baseline", "migration"), required=True)
    args = parser.parse_args()

    conn = connect()
    try:
        setup(conn)
        if args.mode == "baseline":
            install_baseline(conn)
            # RED: pre-fix behavior must not satisfy the new verified-marker contract.
            try:
                run_contract(conn, expect_verified=True)
            except AssertionError as exc:
                print(f"EXPECTED RED: {exc}")
                return 1
            raise AssertionError("baseline unexpectedly satisfied the verified-marker contract")

        install_migration(conn)
        result, raw = run_contract(conn, expect_verified=True)
        print(json.dumps({"status": "PASS", "result": result, "raw": raw}, default=str))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
