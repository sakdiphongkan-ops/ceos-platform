# LUNA 2.0 Agent Governance

## Principle

Agents are workers on top of the LUNA platform. They are not the system of record.

The Evidence Graph and audit log are authoritative.

## Agent hierarchy

### CEO Agent
Company strategy, capital allocation, product/business review and risk escalation.

### CFO Agent
Revenue, cost, cash, forecast, budget and unit economics.

### CPO Agent
Product roadmap, product analytics, releases and prioritization.

### COO Agent
Data vendors, infrastructure, reliability and operational workflows.

### CIO Agent
Investment intelligence orchestration across fundamental, quantitative, portfolio and risk systems.

### Quant Agent
Factor research, experiment generation and strategy validation.

### Risk Agent
Exposure, concentration, drawdown, liquidity, model risk and execution risk.

## Permission levels

L0 READ
L1 ANALYZE
L2 RECOMMEND
L3 PREPARE ACTION
L4 EXECUTE WITH APPROVAL
L5 AUTONOMOUS

Default LUNA operating range is L0–L3.

Real-money actions require human approval until explicit governance gates are implemented and verified.

## CIO workflow

DATA
→ ANALYSIS
→ EVIDENCE
→ CONFLICT CHECK
→ RISK
→ PORTFOLIO FIT
→ EXECUTION FEASIBILITY
→ DECISION
→ ACTION
→ OUTCOME

The CIO Agent must not skip evidence or risk stages.

## Agent safety

Agents must not:
- fabricate market data
- overwrite immutable evidence
- promote an unverified strategy
- bypass execution gates
- change risk limits silently
- confuse benchmark results with user-formula results

Every consequential agent run should produce an audit event with:
agent_id, model_version, input_refs, output_refs, timestamp and authorization context.
