# LUNA / CEOS Multi-Agent Platform

## Registered roles

The migration seeds **16 roles: CEO / Orchestrator plus 15 specialist roles** in `public.luna_erp_agents`.

| Role | Primary responsibility |
|---|---|
| CEO / Orchestrator | Decompose user goals, route tasks, manage dependencies, synthesize evidence |
| Chief of Staff / PMO | Milestones, prioritization, dependencies and operating reports |
| Product Manager | Requirements, scope, user stories and acceptance criteria |
| CTO / Software Architect | Architecture, interface contracts, technical decisions and rollback design |
| Software Engineer | Code-level analysis, proposed fixes, implementation notes and tests |
| Data Engineer | Ingestion, data quality, lineage, freshness and schema review |
| Quantitative Research Scientist | Factor hypotheses, walk-forward tests, cost stress and bias/leakage audits |
| Market Data Verification Analyst | Quote provenance, freshness, market session and execution-grade data checks |
| QA / Independent Validator | Independent acceptance review, defect discovery and test evidence |
| Risk & Compliance Officer | Risk assessment, safety policy and release gates |
| DevOps / SRE | CI/CD, observability, incident response and rollback readiness |
| CFO / Financial Analyst | Costs, budgets, valuation arithmetic and scenario analysis |
| Business Strategy & Research Analyst | Source-backed research and comparison of business options |
| UX / Product Designer | Information architecture, user flows, accessibility and design requirements |
| Security / Privacy Engineer | Authentication, authorization, secret boundaries and secure APIs |
| Documentation & Reporting Analyst | Runbooks, decision records, handovers and evidence registers |

Every role contains a specific system prompt, capabilities, an intended action scope and a human-gate policy. These registry fields document intended scope; they do not grant external tools or permissions by themselves.

## Runtime requirements

The Edge Function is `supabase/functions/luna-ceo-agent`. Before deploying it, configure these Supabase Edge Function secrets:

- `OPENAI_API_KEY`: server-side API credential. Never place it in browser code or source control.
- `LUNA_AGENT_MODEL`: a model name enabled for the API account.
- `LUNA_AGENT_RESPONSES_URL` (optional): use only for a provider implementing the OpenAI Responses API contract; default is `https://api.openai.com/v1/responses`.

Machine callers must use an enabled server-side `x-luna-agent` credential with scope `general`, validated by `luna_verify_agent_scope`. Do not expose that credential or the Supabase service-role key to a browser. The deployment must keep the Edge Function's built-in credential/JWT checks aligned with your gateway policy; if platform-level JWT verification is disabled, the in-function checks are mandatory on every route.

Run `POST /functions/v1/luna-ceo-agent` with `{"action":"verify_runtime"}` after configuration. This performs a live, low-token model connectivity check; only after it succeeds are enabled roles marked `HEALTHY`. `GET /functions/v1/luna-ceo-agent` returns current role readiness and blockers.

## API workflow

### Dispatch a CEO task

```http
POST /functions/v1/luna-ceo-agent
Content-Type: application/json
x-luna-agent: <server-side-general-scope-credential>

{
  "action": "dispatch_task",
  "idempotency_key": "caller-generated-stable-key",
  "requested_by": "human_user",
  "task": "Describe the objective and expected result",
  "context": "Optional supporting context without secrets"
}
```

The CEO proposes a strict-schema plan with up to eight work items, selects only enabled and healthy specialists, records parent/child work orders, links dependencies, defines acceptance criteria, and writes traceable model-run records. Up to five eligible specialist tasks can be attempted during one request.

### Continue a task batch

```json
{
  "action": "run_batch",
  "parent_work_order_id": "<returned-parent-uuid>",
  "max_tasks": 3
}
```

Each draft starts in `VALIDATION`. The independent QA workflow checks every recorded acceptance criterion with evidence; incomplete or unsupported criteria cannot pass. QA can queue one bounded specialist retry with structured feedback. Work that fails QA after the retry limit remains blocked for human review. Dependencies are claimable only after the predecessor is `COMPLETED`, not merely because a draft was produced.

### Decide a human approval

Human approval uses a verified Supabase Auth access token (not the machine `x-luna-agent` credential). Only accounts whose server-controlled `app_metadata.ceos_role` is `admin` or whose `app_metadata.roles` contains `ceos_admin` can decide. Do not use editable `user_metadata` for authorization.

```http
POST /functions/v1/luna-ceo-agent
Authorization: Bearer <admin-user-access-token>
Content-Type: application/json

{
  "action": "decide_approval",
  "approval_id": "<pending-approval-uuid>",
  "decision": "APPROVED",
  "rationale": "Reviewed the risks and authorize draft-only work"
}
```

The decision is recorded with an audit event and only queues draft-only paper work. Rejections keep work blocked. `LIVE_TRADING` approval is always forbidden by the database function, including when a request is otherwise authenticated. Human approval is not a deployment, secret release, or trading order.

## Safety invariants

- All work orders remain paper-only; the database constraint requires `paper_only = true`.
- A specialist cannot approve its own draft. QA uses a different reviewer role and requires evidence for every criterion.
- High/consequential tasks require an explicit approval gate; while pending, work stays blocked.
- The current runtime produces analysis and draft deliverables only. It has no browser, shell, repository-write, deployment, secret-management or broker tool adapter. It must never claim an external action was performed.
- Live-money trading stays disabled; there is no order-placement action in this module.
- A role marked `HEALTHY` means provider/model connectivity was checked, not that the role can execute unconnected tools.
- Agent-run traces are service-role-only. Model credentials are never written into work-order outputs or run records.

## Current limitations / deployment gate

This code is still in a Draft Pull Request. The migration and Edge Function have **not** been applied to production. CI covers TypeScript/Deno checks and unit tests but cannot validate authenticated runtime behavior. The current Supabase plan does not support a staging branch, so do not treat CI as a substitute for integration testing.

Before activation, review the migration, provision secrets using the dashboard or authorized secrets workflow, verify the caller credential scope, test machine and human authentication, task retries, QA, dependency order, approvals and audit rows in an isolated environment. Add verified external tool adapters before asking an agent to change source repositories, perform live web research, publish production deployments or perform any other external side effect. Keep production dispatch and all real-money trading disabled until the corresponding controls and integration tests exist.
