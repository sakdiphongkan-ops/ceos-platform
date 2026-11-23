import {
  buildPlanJsonSchema,
  normalizeTaskPlan,
  qaReviewPassesAcceptanceCriteria,
  type TaskPlan,
} from "./plan_helpers.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
function assertThrows(fn: () => unknown, expected: string): void {
  let message = "";
  try { fn(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  assertEquals(message, expected);
}
function item(overrides: Record<string, unknown> = {}) {
  return {
    agent_key: "product_manager",
    title: "Define requirements",
    description: "Write testable requirements and acceptance criteria.",
    priority: 3,
    risk_level: "LOW",
    requires_human_gate: false,
    approval_gate: "NONE",
    acceptance_criteria: ["Requirements are testable"],
    dependency_indexes: [],
    ...overrides,
  };
}
function plan(overrides: Record<string, unknown> = {}) {
  return {
    title: "Safe test plan",
    objective: "Create a plan without changing production.",
    summary: "The CEO will distribute a small, low-risk task.",
    risk_level: "LOW",
    requires_human_gate: false,
    approval_gate: "NONE",
    work_items: [item()],
    ...overrides,
  };
}

Deno.test("plan schema limits assignments to available specialist agents", () => {
  const schema = buildPlanJsonSchema(["ceo_orchestrator", "qa_validator", "product_manager"]);
  const root = schema as any;
  assertEquals(root.additionalProperties, false);
  assertEquals(root.properties.work_items.maxItems, 8);
  assertEquals(root.properties.work_items.items.properties.agent_key.enum, ["product_manager", "qa_validator"]);
});

Deno.test("valid plans retain agent, acceptance criteria and dependency order", () => {
  const result: TaskPlan = normalizeTaskPlan(plan({
    work_items: [
      item(),
      item({
        agent_key: "qa_validator",
        title: "Validate output",
        dependency_indexes: [0],
      }),
    ],
  }), ["ceo_orchestrator", "product_manager", "qa_validator"]);
  assertEquals(result.work_items.length, 2);
  assertEquals(result.work_items[1].dependency_indexes, [0]);
  assertEquals(result.work_items[1].agent_key, "qa_validator");
});

Deno.test("plans cannot assign the CEO to a child or route to an unavailable agent", () => {
  assertThrows(
    () => normalizeTaskPlan(plan({ work_items: [item({ agent_key: "ceo_orchestrator" })] }), [
      "ceo_orchestrator", "product_manager",
    ]),
    "PLAN_REFERENCES_UNAVAILABLE_AGENT",
  );
  assertThrows(
    () => normalizeTaskPlan(plan({ work_items: [item({ agent_key: "unknown_agent" })] }), [
      "ceo_orchestrator", "product_manager",
    ]),
    "PLAN_REFERENCES_UNAVAILABLE_AGENT",
  );
});

Deno.test("high-risk plans fail closed unless a human gate is required", () => {
  assertThrows(
    () => normalizeTaskPlan(plan({
      risk_level: "CRITICAL",
      approval_gate: "NONE",
      requires_human_gate: false,
    }), ["ceo_orchestrator", "product_manager"]),
    "HIGH_RISK_PLAN_MUST_REQUIRE_HUMAN_GATE",
  );
  const safe = normalizeTaskPlan(plan({
    risk_level: "CRITICAL",
    approval_gate: "LIVE_TRADING",
    requires_human_gate: false,
  }), ["ceo_orchestrator", "product_manager"]);
  assertEquals(safe.requires_human_gate, true);
  assertEquals(safe.work_items[0].requires_human_gate, false);
});

Deno.test("task dependencies must point backward and cannot repeat", () => {
  assertThrows(
    () => normalizeTaskPlan(plan({
      work_items: [item(), item({ dependency_indexes: [1] })],
    }), ["ceo_orchestrator", "product_manager"]),
    "INVALID_PLAN_DEPENDENCIES",
  );
  assertThrows(
    () => normalizeTaskPlan(plan({
      work_items: [item(), item({ dependency_indexes: [0, 0] })],
    }), ["ceo_orchestrator", "product_manager"]),
    "INVALID_PLAN_DEPENDENCIES",
  );
});

Deno.test("unknown keys are rejected instead of silently accepted", () => {
  assertThrows(
    () => normalizeTaskPlan({ ...plan(), confidence: 0.99 }, ["ceo_orchestrator", "product_manager"]),
    "INVALID_PLAN_OBJECT",
  );
});


Deno.test("QA acceptance requires every criterion to pass with evidence", () => {
  const criteria = ["Includes implementation notes", "Lists risks"];
  assertEquals(qaReviewPassesAcceptanceCriteria(criteria, {
    decision: "APPROVE",
    criteria_results: [
      { criterion_index: 0, passed: true, evidence: "Implementation notes are present" },
      { criterion_index: 1, passed: true, evidence: "Risks are explicitly listed" },
    ],
  }), true);
});

Deno.test("QA cannot approve when criteria are omitted, duplicated or unsupported", () => {
  const criteria = ["Criterion A", "Criterion B"];
  assertEquals(qaReviewPassesAcceptanceCriteria(criteria, {
    decision: "APPROVE",
    criteria_results: [{ criterion_index: 0, passed: true, evidence: "Present" }],
  }), false);
  assertEquals(qaReviewPassesAcceptanceCriteria(criteria, {
    decision: "APPROVE",
    criteria_results: [
      { criterion_index: 0, passed: true, evidence: "Present" },
      { criterion_index: 0, passed: true, evidence: "Duplicated criterion" },
    ],
  }), false);
  assertEquals(qaReviewPassesAcceptanceCriteria(criteria, {
    decision: "APPROVE",
    criteria_results: [
      { criterion_index: 0, passed: true, evidence: "Present" },
      { criterion_index: 1, passed: false, evidence: "Missing" },
    ],
  }), false);
});
