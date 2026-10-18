/**
 * Static contract guard for the staged Supabase migration.
 * This proves the migration source retains the safety checks; it is not a
 * substitute for applying/testing the migration on a disposable Postgres DB.
 * It has no database, network, provider, or order side effects.
 */
import {strict as assert} from "node:assert";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const migrationPath=resolve(
  process.cwd(),
  "../supabase/migrations/20261018093000_luna_verified_ingest_retention_idempotency.sql"
);
const sql=readFileSync(migrationPath,"utf8");
const hashGuard=sql.indexOf("if nullif(trim(coalesce(p_payload_hash,'')),'') is null then");
const requiredArgGuards=sql.indexOf("if p_feed_ts is null then");
const sourceConfigLookup=sql.indexOf("from public.luna_verified_market_sources");
const earlyIdempotency=sql.indexOf("if v_existing is not null and v_existing_accepted is true then");
const freshnessGuard=sql.indexOf("p_feed_ts < now() - make_interval");
const rowCountCheck=sql.indexOf("into v_existing_tick_rows,v_existing_fresh_tick_rows");
const retainedSuccessGuard=sql.indexOf("and v_existing_fresh_tick_rows = v_existing_expected then");
const idempotentSuccess=sql.indexOf("'ok',true,'accepted',true,'idempotent',true");
const retainedFailure=sql.indexOf("when v_existing_tick_rows <> v_existing_expected then 'IDEMPOTENCY_TICKS_NOT_RETAINED'");
const staleFailure=sql.indexOf("when v_existing_fresh_tick_rows <> v_existing_expected then 'STALE_FEED_TIMESTAMP'");
const sessionGate=sql.indexOf("if v_session is null then");
const nonFiniteGuards=sql.indexOf("lower(x.bid::text) not in ('nan','infinity','-infinity')");

assert.ok(hashGuard>=0,"missing payload hash must reject cleanly before a NOT NULL insert");
assert.ok(requiredArgGuards>=0 && requiredArgGuards<earlyIdempotency,"null feed timestamp must be rejected before idempotent checks");
assert.ok(sourceConfigLookup>=0 && sourceConfigLookup<earlyIdempotency,"current source config must be checked before idempotent success");
assert.ok(sql.includes("if exists (\n    select 1\n    from jsonb_array_elements(p_rows) as item(value)"),"non-object JSON rows must be rejected before recordset casting");
assert.ok(sql.includes("when invalid_text_representation"),"malformed typed fields must return a structured rejection");
assert.ok(freshnessGuard>=0 && freshnessGuard<earlyIdempotency,"feed freshness must be checked before idempotent success");
assert.ok(rowCountCheck>=0,"migration must count retained and fresh persisted tick rows");
assert.ok(retainedSuccessGuard>rowCountCheck,"idempotent success requires exact retained and fresh tick count");
assert.ok(idempotentSuccess>retainedSuccessGuard,"accepted idempotency return must follow retained/fresh tick checks");
assert.ok(retainedFailure>rowCountCheck,"missing rows must invalidate accepted metadata");
assert.ok(staleFailure>retainedFailure,"stale retained rows must invalidate accepted metadata");
assert.ok(sessionGate>=0 && sessionGate<earlyIdempotency,"market session gate must precede idempotent success");
assert.ok(nonFiniteGuards>=0,"NaN/Infinity quote prices must fail closed");
assert.ok(sql.includes("SET search_path TO 'pg_catalog', 'public', 'pg_temp'"),"SECURITY DEFINER ingest RPC must pin a safe search_path");
assert.ok(sql.includes("REVOKE ALL ON FUNCTION public.luna_ingest_verified_market_batch("),"service-only ingest RPC must revoke default PUBLIC EXECUTE");
assert.ok(sql.includes("TO service_role"),"ingest RPC must remain executable by the trusted service role");

console.log("LUNA ingest-retention migration contract: PASS");
console.log("PASS missing payload hash fails cleanly");
console.log("PASS current source configuration and timestamp gates precede idempotency");
console.log("PASS idempotent success requires exact retained AND fresh tick count");
console.log("PASS expired/stale batch metadata cannot return accepted=true");
