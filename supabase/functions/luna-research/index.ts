import { candidateQuerySpec, isUuid, parseResearchPagination, researchCandidateStatus } from "./research_get_helpers.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const SERVICE_KEY = SECRET_KEYS["default"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY);

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://luna.floot.app",
  "Access-Control-Allow-Headers": "content-type, x-luna-agent",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const token = req.headers.get("x-luna-agent");
  if(!token)return false;
  const hash=await sha256(token);
  const {data,error}=await db.from("luna_agent_credentials").select("credential_id").eq("sha256_hash",hash).eq("enabled",true).limit(1);
  return !error && !!data?.length;
}

function asNumber(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const url = new URL(req.url);

    if (!(await authorized(req))) return json({ ok: false, error: "unauthorized" }, 401);
    const rate = await db.rpc("luna_security_rate_limit", {
      p_bucket_key: "research:" + await sha256(req.headers.get("x-luna-agent") ?? ""),
      p_limit: 30,
      p_window_seconds: 60
    });
    if (rate.error) return json({ ok: false, error: "SECURITY_RATE_LIMIT_UNAVAILABLE" }, 503);
    if (rate.data?.allowed === false) return json({ ok: false, error: "SECURITY_RATE_LIMITED" }, 429);

    if (req.method === "GET") {
      const requestedRunId = url.searchParams.get("run_id");
      if (requestedRunId && !isUuid(requestedRunId)) {
        return json({ ok: false, error: "INVALID_RESEARCH_RUN_ID" }, 400);
      }

      const pagination = parseResearchPagination(url);
      const [runs, datasets] = await Promise.all([
        db.from("luna_research_runs")
          .select("id,name,dataset_id,strategy_family,strategy_version,status,total_candidates,completed_candidates,next_candidate,config,started_at,ended_at,error,created_at")
          .order("created_at", { ascending: false })
          .limit(20),
        db.from("luna_datasets")
          .select("id,name,source,granularity,start_ts,end_ts,symbol_count,row_count,checksum_sha256,status,created_at")
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      let selectedRun = runs.data?.[0] ?? null;
      if (requestedRunId) {
        const exactRun = await db.from("luna_research_runs")
          .select("id,name,dataset_id,strategy_family,strategy_version,status,total_candidates,completed_candidates,next_candidate,config,started_at,ended_at,error,created_at")
          .eq("id", requestedRunId)
          .maybeSingle();

        if (exactRun.error) {
          return json({ ok: false, error: "RESEARCH_RUN_LOOKUP_FAILED" }, 500);
        }
        if (!exactRun.data) {
          return json({ ok: false, error: "RESEARCH_RUN_NOT_FOUND" }, 404);
        }
        selectedRun = exactRun.data;
      }

      let candidateRows: unknown[] = [];
      let candidateCount = 0;
      let candidateQueryError: { message?: string; code?: string } | null = null;
      if (selectedRun) {
        const querySpec = candidateQuerySpec(selectedRun.id, pagination);
        const candidateResult = await db.from("luna_research_candidates")
          .select("run_id,candidate_no,strategy_id,status,train_return,validation_return,test_return,train_max_dd,validation_max_dd,test_max_dd,train_sharpe,validation_sharpe,test_sharpe,trade_count,win_rate,robustness_score,passed_oos,passed_costs,passed_robustness", { count: "exact" })
          .eq("run_id", querySpec.runId)
          .order(querySpec.orderBy, { ascending: querySpec.ascending })
          .range(querySpec.from, querySpec.to);
        candidateRows = candidateResult.data ?? [];
        candidateCount = candidateResult.count ?? 0;
        candidateQueryError = candidateResult.error;
      }

      const errors = [runs.error, datasets.error, candidateQueryError]
        .filter(Boolean)
        .map(e => ({ message: e?.message, code: e?.code }));
      const candidateState = candidateQueryError
        ? "QUERY_FAILED"
        : researchCandidateStatus(selectedRun?.id ?? null, candidateCount);

      return json({
        ok: errors.length === 0,
        runs: runs.data ?? [],
        selected_run_id: selectedRun?.id ?? null,
        candidate_status: candidateState,
        candidate_pagination: {
          page: pagination.page,
          page_size: pagination.pageSize,
          total: candidateCount,
          has_more: pagination.to + 1 < candidateCount,
        },
        candidates: candidateRows,
        datasets: datasets.data ?? [],
        errors,
      });
    }

    if (!req.headers.get("content-type")?.includes("application/json")) {
      return json({ ok: false, error: "content-type must be application/json" }, 415);
    }

    const body = await req.json();
    const action = body?.action;

    if (action === "create_run") {
      const r = body.run ?? {};
      if (!r.name || !r.strategy_family || !r.strategy_version) {
        return json({ ok: false, error: "invalid research run request" }, 400);
      }

      const { data: run, error } = await db.from("luna_research_runs").insert({
        name: r.name,
        dataset_id: r.dataset_id ?? null,
        strategy_family: r.strategy_family,
        strategy_version: r.strategy_version,
        universe_size: asNumber(r.universe_size),
        train_start: r.train_start ?? null,
        train_end: r.train_end ?? null,
        validation_start: r.validation_start ?? null,
        validation_end: r.validation_end ?? null,
        test_start: r.test_start ?? null,
        test_end: r.test_end ?? null,
        total_candidates: asNumber(r.total_candidates),
        initial_capital: asNumber(r.initial_capital, 1000000),
        status: "QUEUED",
        config: r.config ?? {},
      }).select("id,name,status,total_candidates,next_candidate,created_at").single();

      if (error) throw error;
      return json({ ok: true, run });
    }

    if (action === "seed_candidates") {
      const runId = body.run_id;
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      if (!runId || candidates.length === 0) {
        return json({ ok: false, error: "run_id and candidates[] are required" }, 400);
      }

      const rows = candidates.map((c: any, i: number) => ({
        run_id: runId,
        candidate_no: asNumber(c.candidate_no, i),
        strategy_id: String(c.strategy_id ?? `candidate_${i}`),
        parameters: c.parameters ?? {},
      }));

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("luna_research_candidates")
          .upsert(rows.slice(i, i + 500), { onConflict: "run_id,candidate_no" });
        if (error) throw error;
      }

      return json({ ok: true, inserted: rows.length });
    }

    if (action === "claim_chunk") {
      const runId = body.run_id;
      const chunkSize = Math.min(Math.max(asNumber(body.chunk_size, 10), 1), 25);
      if (!runId) return json({ ok: false, error: "run_id required" }, 400);

      const { data: run, error: runError } = await db.from("luna_research_runs")
        .select("id,status,next_candidate,total_candidates")
        .eq("id", runId)
        .single();
      if (runError) throw runError;

      if (run.status === "QUEUED") {
        await db.from("luna_research_runs").update({
          status: "RUNNING",
          started_at: new Date().toISOString(),
        }).eq("id", runId);
      }

      const start = asNumber(run.next_candidate);
      const end = Math.min(start + chunkSize, asNumber(run.total_candidates));

      const { data: chunk, error: chunkError } = await db.from("luna_research_candidates")
        .select("id,run_id,candidate_no,strategy_id,parameters,status")
        .eq("run_id", runId)
        .gte("candidate_no", start)
        .lt("candidate_no", end)
        .eq("status", "QUEUED")
        .order("candidate_no", { ascending: true });

      if (chunkError) throw chunkError;

      const ids = (chunk ?? []).map((x: any) => x.id);
      if (ids.length) {
        const { error } = await db.from("luna_research_candidates")
          .update({ status: "RUNNING", started_at: new Date().toISOString() })
          .in("id", ids);
        if (error) throw error;
      }

      await db.from("luna_research_runs").update({ next_candidate: end }).eq("id", runId);

      return json({
        ok: true,
        run_id: runId,
        claimed_from: start,
        claimed_to: end,
        candidates: chunk ?? [],
      });
    }

    if (action === "complete_candidate") {
      const c = body.candidate ?? {};
      if (!c.id) return json({ ok: false, error: "candidate.id required" }, 400);

      const patch = {
        status: c.status ?? "COMPLETED",
        train_return: c.train_return ?? null,
        validation_return: c.validation_return ?? null,
        test_return: c.test_return ?? null,
        train_max_dd: c.train_max_dd ?? null,
        validation_max_dd: c.validation_max_dd ?? null,
        test_max_dd: c.test_max_dd ?? null,
        train_sharpe: c.train_sharpe ?? null,
        validation_sharpe: c.validation_sharpe ?? null,
        test_sharpe: c.test_sharpe ?? null,
        trade_count: asNumber(c.trade_count),
        win_rate: c.win_rate ?? null,
        total_fees: c.total_fees ?? null,
        total_slippage: c.total_slippage ?? null,
        robustness_score: c.robustness_score ?? null,
        passed_oos: c.passed_oos ?? false,
        passed_costs: c.passed_costs ?? false,
        passed_robustness: c.passed_robustness ?? false,
        result: c.result ?? {},
        ended_at: new Date().toISOString(),
        error: c.error ?? null,
      };

      const { data, error } = await db.from("luna_research_candidates")
        .update(patch).eq("id", c.id)
        .select("id,run_id,candidate_no,status,passed_oos,passed_costs,passed_robustness,test_return,robustness_score")
        .single();
      if (error) throw error;

      const { count } = await db.from("luna_research_candidates")
        .select("id", { count: "exact", head: true })
        .eq("run_id", data.run_id)
        .eq("status", "COMPLETED");

      const runUpdate: Record<string, unknown> = {
        completed_candidates: count ?? 0,
      };

      const { data: run } = await db.from("luna_research_runs")
        .select("total_candidates")
        .eq("id", data.run_id)
        .single();

      if (run && (count ?? 0) >= asNumber(run.total_candidates)) {
        runUpdate.status = "COMPLETED";
        runUpdate.ended_at = new Date().toISOString();
      }

      await db.from("luna_research_runs").update(runUpdate).eq("id", data.run_id);

      return json({ ok: true, candidate: data, completed: count ?? 0 });
    }

    if (action === "fail_candidate") {
      const c = body.candidate ?? {};
      if (!c.id) return json({ ok: false, error: "candidate.id required" }, 400);
      const { data, error } = await db.from("luna_research_candidates")
        .update({
          status: "FAILED",
          error: String(c.error ?? "unknown"),
          ended_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .select("id,run_id,candidate_no,status,error")
        .single();
      if (error) throw error;
      return json({ ok: true, candidate: data });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});