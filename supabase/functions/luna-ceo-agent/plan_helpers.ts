export const MAX_PLAN_ITEMS = 8;
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const APPROVAL_GATES = [
  "NONE",
  "PRODUCTION_PUBLISH",
  "DESTRUCTIVE_DATA_CHANGE",
  "SECRET_ACCESS",
  "POLICY_CHANGE",
  "LIVE_TRADING",
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ApprovalGate = (typeof APPROVAL_GATES)[number];

export type PlannedWorkItem = {
  agent_key: string;
  title: string;
  description: string;
  priority: number;
  risk_level: RiskLevel;
  requires_human_gate: boolean;
  approval_gate: ApprovalGate;
  acceptance_criteria: string[];
  dependency_indexes: number[];
};

export type TaskPlan = {
  title: string;
  objective: string;
  summary: string;
  risk_level: RiskLevel;
  requires_human_gate: boolean;
  approval_gate: ApprovalGate;
  work_items: PlannedWorkItem[];
};

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`INVALID_PLAN_${field.toUpperCase()}`);
  const output = value.trim();
  if (!output || output.length > max) throw new Error(`INVALID_PLAN_${field.toUpperCase()}`);
  return output;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`INVALID_PLAN_${field.toUpperCase()}`);
  }
  return value as T;
}

function stringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`INVALID_PLAN_${field.toUpperCase()}`);
  }
  return value.map((item) => boundedText(item, field, maxLength));
}

function dependencyIndexes(value: unknown, itemIndex: number): number[] {
  if (!Array.isArray(value) || value.length > MAX_PLAN_ITEMS) {
    throw new Error("INVALID_PLAN_DEPENDENCIES");
  }
  const seen = new Set<number>();
  const indexes: number[] = [];
  for (const raw of value) {
    if (!Number.isSafeInteger(raw) || raw < 0 || raw >= itemIndex || seen.has(raw)) {
      throw new Error("INVALID_PLAN_DEPENDENCIES");
    }
    seen.add(raw);
    indexes.push(raw);
  }
  return indexes;
}

function gateImpliesHumanApproval(gate: ApprovalGate): boolean {
  return gate !== "NONE";
}

export function normalizeTaskPlan(raw: unknown, availableAgentKeys: readonly string[]): TaskPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_PLAN_OBJECT");
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.work_items) || input.work_items.length < 1 || input.work_items.length > MAX_PLAN_ITEMS) {
    throw new Error("INVALID_PLAN_WORK_ITEM_COUNT");
  }

  const allowedAgents = new Set(availableAgentKeys.filter((key) => key !== "ceo_orchestrator"));
  const workItems: PlannedWorkItem[] = input.work_items.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PLAN_WORK_ITEM");
    const row = value as Record<string, unknown>;
    const agentKey = boundedText(row.agent_key, "agent_key", 80);
    if (!allowedAgents.has(agentKey)) throw new Error("PLAN_REFERENCES_UNAVAILABLE_AGENT");
    const riskLevel = enumValue(row.risk_level, RISK_LEVELS, "risk_level");
    const approvalGate = enumValue(row.approval_gate, APPROVAL_GATES, "approval_gate");
    const requestedGate = row.requires_human_gate === true;
    const requiresHumanGate = requestedGate || gateImpliesHumanApproval(approvalGate) ||
      riskLevel === "CRITICAL" || (riskLevel === "HIGH" && approvalGate !== "NONE");
    if ((riskLevel === "HIGH" || riskLevel === "CRITICAL") &&
      approvalGate === "NONE" && row.requires_human_gate !== true) {
      throw new Error("HIGH_RISK_PLAN_MUST_REQUIRE_HUMAN_GATE");
    }

    return {
      agent_key: agentKey,
      title: boundedText(row.title, "work_item_title", 180),
      description: boundedText(row.description, "work_item_description", 5000),
      priority: Number.isSafeInteger(row.priority) && Number(row.priority) >= 1 && Number(row.priority) <= 5
        ? Number(row.priority)
        : (() => { throw new Error("INVALID_PLAN_PRIORITY"); })(),
      risk_level: riskLevel,
      requires_human_gate: requiresHumanGate,
      approval_gate: approvalGate,
      acceptance_criteria: stringArray(row.acceptance_criteria, "acceptance_criteria", 8, 300),
      dependency_indexes: dependencyIndexes(row.dependency_indexes, index),
    };
  });

  const planRisk = enumValue(input.risk_level, RISK_LEVELS, "risk_level");
  const planGate = enumValue(input.approval_gate, APPROVAL_GATES, "approval_gate");
  const planRequiresGate = input.requires_human_gate === true || gateImpliesHumanApproval(planGate) ||
    planRisk === "CRITICAL" || (planRisk === "HIGH" && planGate !== "NONE");
  if ((planRisk === "HIGH" || planRisk === "CRITICAL") &&
    planGate === "NONE" && input.requires_human_gate !== true) {
    throw new Error("HIGH_RISK_PLAN_MUST_REQUIRE_HUMAN_GATE");
  }

  return {
    title: boundedText(input.title, "title", 180),
    objective: boundedText(input.objective, "objective", 1200),
    summary: boundedText(input.summary, "summary", 3000),
    risk_level: planRisk,
    requires_human_gate: planRequiresGate,
    approval_gate: planGate,
    work_items: workItems,
  };
}

export function buildPlanJsonSchema(availableAgentKeys: readonly string[]) {
  const agentKeys = [...new Set(availableAgentKeys.filter((key) => key !== "ceo_orchestrator"))].sort();
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "objective", "summary", "risk_level", "requires_human_gate", "approval_gate", "work_items"],
    properties: {
      title: { type: "string" },
      objective: { type: "string" },
      summary: { type: "string" },
      risk_level: { type: "string", enum: [...RISK_LEVELS] },
      requires_human_gate: { type: "boolean" },
      approval_gate: { type: "string", enum: [...APPROVAL_GATES] },
      work_items: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PLAN_ITEMS,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "agent_key",
            "title",
            "description",
            "priority",
            "risk_level",
            "requires_human_gate",
            "approval_gate",
            "acceptance_criteria",
            "dependency_indexes",
          ],
          properties: {
            agent_key: { type: "string", enum: agentKeys },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "integer", minimum: 1, maximum: 5 },
            risk_level: { type: "string", enum: [...RISK_LEVELS] },
            requires_human_gate: { type: "boolean" },
            approval_gate: { type: "string", enum: [...APPROVAL_GATES] },
            acceptance_criteria: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string" },
            },
            dependency_indexes: {
              type: "array",
              maxItems: MAX_PLAN_ITEMS,
              items: { type: "integer", minimum: 0, maximum: MAX_PLAN_ITEMS - 1 },
            },
          },
        },
      },
    },
  };
}
