# LUNA-TH1H skills

These original, project-specific skills are intended to guide coding and research agents working on LUNA. Read the skill relevant to the change before editing market-data, execution-readiness or research logic.

- `luna-market-data-quality/SKILL.md`: quote provenance, freshness and data-quality checks.
- `luna-execution-readiness/SKILL.md`: coverage interpretation and fail-closed execution constraints.
- `luna-quant-research-integrity/SKILL.md`: leakage, point-in-time, costs and holdout discipline.

The quant-research skill links to, but does not copy, upstream guidance from the ML4T Agent Skills project. Upstream reference: https://github.com/MorrisonAnalytical/ML4T_skills (Apache-2.0).

Run the relevant checks inside `luna-th1h/`:

```bash
npm run typecheck
npm run test:data-quality
```

All test fixtures are synthetic. They must never be presented as actual market observations.
