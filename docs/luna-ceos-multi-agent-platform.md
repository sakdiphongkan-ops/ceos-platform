# LUNA / CEOS Multi-Agent Platform

## Registered positions

The migration registers 15 specialist roles in `public.luna_erp_agents`:

- CEO / Orchestrator
- Chief of Staff / PMO
- Product Manager
- CTO / Software Architect
- Software Engineer
- Data Engineer
- Quantitative Research Scientist
- Market Data Verification Analyst
- QA / Independent Validator
- Risk & Compliance Officer
- DevOps / SRE
- CFO / Financial Analyst
- Business Strategy & Research Analyst
- UX / Product Designer
- Security / Privacy Engineer
- Documentation & Reporting Analyst

Each role has a system prompt, department, capabilities, allowed-action labels, concurrency limit and approval policy. These metadata fields document the role's intended scope; they do not grant an external connector or tool permission by themselves.

## Runtime requirements

The Edge Function is `supabase/functions/luna-ceo-agent`.

Configure these Supabase Edge Function secrets before invoking it:

- `OPENAI_API_KEY`: server-side API credential. Never put this value in browser code or source control.
- `LUNA_AGENT_MODEL`: a model name enabled for the project's API account.
- `LUNA_AGENT_RESPONSES_URL` (optional): only use when the configured provider implements the OpenAI Responses API contract; default is `https://api.openai.com/v1/responses`.

The caller must send an enabled `x-luna-agent` credential accepted by `luna_verify_agent`. Never expose that credential or the Supabase service key in browser code.

After migrations and Edge Function code are deployed, run `POST /functions/v1/luna-ceo-agent` with `{"action":"verify_runtime"}`. It performs a live, low-token model connectivity check. Only after that check succeeds does it mark enabled roles as `HEALTHY`. `GET /functions/v1/luna-ceo-agent` returns role readiness and blockers.

## API workflow

### Dispatch a CEO task

```http
POST /functions/v1/luna-ceo-agent
Content-Type: application/json
x-luna-agent: <server-side-agent-credential>

{
  "action": "dispatch_task",
  "idempotency_key": "caller-generated-stable-key",
  "requested_by": "human_user",
  "task": "Describe the objective and expected result",
  "context": "Optional supporting context without secrets"
}
```

The CEO builds a strict-schema plan using only enabled, healthy specialist roles. It stores one parent work order, child work orders, dependency IDs, acceptance criteria, trace IDs and approval requests. Up to five eligible child work orders may be run during the same request. Remaining eligible work can be continued using `run_batch` with the returned parent ID.

### Continue a task batch

```json
{
  "action": "run_batch",
  "parent_work_order_id": "<returned-parent-uuid>",
  "max_tasks": 3
}
```

The SQL claim function atomically leases one queued work order for a healthy registered agent. It will not claim work that is paper-only=false, requires human approval, or has an unfinished dependency. Agent drafts are stored with status `VALIDATION`, not `COMPLETED`; a parent summary also remains in `VALIDATION` until an independent review workflow accepts it.

## Safety invariants

- Work orders must remain paper-only. The database constraint requires `paper_only = true`.
- No agent can approve its own human gate.
- High/consequential changes need an explicit gate type; tasks with pending gates remain blocked.
- An agent run only produces a draft deliverable. The current execution environment has no browser, shell, GitHub write, deployment, secret-management or trading tool adapters. The runtime instructions prohibit claiming those external actions were performed.
- Live-money trading remains disabled. No endpoint in this module places an order or changes a broker connection.
- Outputs are not proof of source verification or deployment. Use QA, evidence links and the real target platform before marking a task complete.
- The agent-run trace table is service-role-only. Model credentials are never written to it.

## Deployment gate

This branch must pass CI and receive independent review before merge. Apply the migration and deploy the new function only after the model secrets and server-side caller credential are provisioned. Test the authenticated runtime end-to-end before enabling production task dispatch. Staging is not available in the current Supabase project plan, so do not treat unit tests as an authenticated integration test.
