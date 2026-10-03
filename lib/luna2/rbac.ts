export type LunaRole = "GUEST" | "USER" | "ADMIN";
export type LunaPermission =
  | "ACCOUNT_READ"
  | "RESEARCH_READ"
  | "BILLING_MANAGE"
  | "GOVERNANCE_MANAGE"
  | "PAPER_TRADE"
  | "LIVE_MONEY_EXECUTE";

const permissions: Record<LunaRole, ReadonlySet<LunaPermission>> = {
  GUEST: new Set<LunaPermission>(["RESEARCH_READ"]),
  USER: new Set<LunaPermission>(["ACCOUNT_READ", "RESEARCH_READ", "PAPER_TRADE"]),
  ADMIN: new Set<LunaPermission>([
    "ACCOUNT_READ",
    "RESEARCH_READ",
    "BILLING_MANAGE",
    "GOVERNANCE_MANAGE",
    "PAPER_TRADE",
  ]),
};

export function can(role: LunaRole, permission: LunaPermission): boolean {
  if (permission === "LIVE_MONEY_EXECUTE") return false;
  return permissions[role].has(permission);
}

export function getPermissions(role: LunaRole): LunaPermission[] {
  return [...permissions[role]];
}
