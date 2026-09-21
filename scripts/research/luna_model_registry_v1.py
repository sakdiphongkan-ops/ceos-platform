#!/usr/bin/env python3
"""Create an immutable-style LUNA research/model registry entry."""
from __future__ import annotations
import argparse, hashlib, json, os
from pathlib import Path
from datetime import datetime, timezone

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--search-summary",required=True)
    ap.add_argument("--scorecard",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--benchmark",required=True)
    ap.add_argument("--neutralized",required=False)
    ap.add_argument("--multiple-testing",required=False)
    ap.add_argument("--universe",required=False)
    ap.add_argument("--sector-neutralization",required=False)
    ap.add_argument("--lifecycle",required=False)
    ap.add_argument("--pit-security-master",required=False)
    ap.add_argument("--pit-fundamentals",required=False)
    ap.add_argument("--corporate-actions",required=False)
    args=ap.parse_args()
    s=json.loads(Path(args.search_summary).read_text())
    c=json.loads(Path(args.scorecard).read_text())
    n=json.loads(Path(args.neutralized).read_text()) if args.neutralized else {}
    mt=json.loads(Path(args.multiple_testing).read_text()) if args.multiple_testing else {}
    u=json.loads(Path(args.universe).read_text()) if args.universe else {}
    sn=json.loads(Path(args.sector_neutralization).read_text()) if args.sector_neutralization else {}
    lc=json.loads(Path(args.lifecycle).read_text()) if args.lifecycle else {}
    pit=json.loads(Path(args.pit_security_master).read_text()) if args.pit_security_master else {}
    pf=json.loads(Path(args.pit_fundamentals).read_text()) if args.pit_fundamentals else {}
    ca=json.loads(Path(args.corporate_actions).read_text()) if args.corporate_actions else {}
    reg={
      "registry_version":"luna-model-registry-v1",
      "created_at":datetime.now(timezone.utc).isoformat(),
      "git_sha":os.getenv("GITHUB_SHA"),
      "workflow_run_id":os.getenv("GITHUB_RUN_ID"),
      "candidate":{
        "formula_id":s["final_formula"]["id"],
        "formula":s["final_formula"],
        "selection":s["final_selection"],
      },
      "lineage":{
        "input_sha256":s["input_sha256"],
        "search_summary_sha256":sha(args.search_summary),
        "scorecard_sha256":sha(args.scorecard),
        "neutralized_sha256":sha(args.neutralized) if args.neutralized else None,
        "multiple_testing_sha256":sha(args.multiple_testing) if args.multiple_testing else None,
        "universe_robustness_sha256":sha(args.universe) if args.universe else None,
        "sector_neutralization_sha256":sha(args.sector_neutralization) if args.sector_neutralization else None,
        "symbol_lifecycle_sha256":sha(args.lifecycle) if args.lifecycle else None,
        "pit_security_master_validation_sha256":sha(args.pit_security_master) if args.pit_security_master else None,
        "pit_fundamentals_validation_sha256":sha(args.pit_fundamentals) if args.pit_fundamentals else None,
        "corporate_actions_validation_sha256":sha(args.corporate_actions) if args.corporate_actions else None,
        "benchmark_sha256":sha(args.benchmark),
        "holdout_start":s["holdout_start"],
        "holdout_end":s["holdout_end"],
        "selection_rule":s["selection_rule"],
        "holdout_rule":s["holdout_rule"],
        "leakage_guard":s["leakage_guard"],
      },
      "evidence":{
        "outer_oos":s["outer_oos_stats"],
        "frozen_holdout":s["frozen_holdout"],
        "diagnostics":{
          "development_ic_mean":c["development_ic_mean"],
          "development_icir_annualized":c["development_icir_annualized"],
          "quintile_spread_mean":c["quintile_spread_mean"],
          "benchmark_overlap":c["benchmark_overlap"],
          "neutral_ic_mean":n.get("neutral_ic_mean"),
          "neutral_icir_annualized":n.get("neutral_icir_annualized"),
          "neutral_churn_mean":n.get("neutral_churn_mean"),
          "crowding_max_abs_corr":n.get("crowding_max_abs_corr"),
          "multiple_testing": {
            "method":mt.get("method"),
            "formula_family_size_after_coverage":mt.get("formula_family_size_after_coverage"),
            "observed_max_t":mt.get("observed_max_t"),
            "reality_check_style_p_value":mt.get("reality_check_style_p_value"),
            "block_length_months":mt.get("block_length_months"),
          },
          "universe_robustness": u,
          "sector_industry_neutralization": sn,
          "symbol_lifecycle": lc,
          "pit_security_master_validation": pit,
          "pit_fundamentals_validation": pf,
          "corporate_actions_validation": ca,
        },
        "promotion_checks":c["promotion_checks"],
      },
      "promotion":{
        "status":"RESEARCH_ONLY",
        "reason":"Registry entry is immutable evidence of a research candidate; production promotion requires independent human review and additional live/shadow validation.",
      }
    }
    out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(reg,indent=2,default=str),encoding="utf-8")
    print(json.dumps(reg,indent=2,default=str))

if __name__=="__main__":
    main()
