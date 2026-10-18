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
const rowCountCheck=sql.indexOf("select count(*) into v_existing_tick_rows");
const retainedSuccessGuard=sql.indexOf("if v_existing_expected > 0 and v_existing_tick_rows = v_existing_expected then");
const idempotentSuccess=sql.indexOf("'ok',true,'accepted',true,'idempotent',true");
const retainedFailure=sql.indexOf("reject_reason='IDEMPOTENCY_TICKS_NOT_RETAINED'");
const nextSnapshotGate=sql.indexOf("'retry_requires_new_snapshot',true");

assert.ok(rowCountCheck>=0,"migration must count persisted tick rows");
assert.ok(retainedSuccessGuard>rowCountCheck,"accepted idempotency requires persisted-row parity");
assert.ok(idempotentSuccess>retainedSuccessGuard,"early accepted return must occur only after persisted-row parity");
assert.ok(retainedFailure>rowCountCheck,"missing/partial rows must invalidate accepted metadata");
assert.ok(nextSnapshotGate>retainedFailure,"expired identical snapshots must fail closed and request a new snapshot");

console.log("LUNA ingest-retention migration contract: PASS");
console.log("PASS accepted idempotency checks exact retained tick count");
console.log("PASS expired/partial batches cannot return accepted=true");
console.log("PASS expired snapshots fail closed until a new observation/hash");
console.log("NOTE static source-contract test only; migration not applied to production");
