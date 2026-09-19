"""Trials-adjusted research gate for the 1M-search program.

This module never selects a winner. It records the number of tested hypotheses
and applies hard gates before a candidate can enter a final holdout.
"""
from dataclasses import dataclass

@dataclass(frozen=True)
class Gate:
    min_oos_trades: int = 30
    min_positive_folds: int = 3
    min_windows: int = 4
    max_drawdown_pct: float = 20.0
    min_profit_factor: float = 1.05
    min_win_rate_pct: float = 35.0
    max_trials: int = 1_000_000

def eligible(x, gate=Gate()):
    if x.get("trials_tested", 0) > gate.max_trials: return False
    if x.get("oos_trades", 0) < gate.min_oos_trades: return False
    if x.get("positive_folds", 0) < gate.min_positive_folds: return False
    if x.get("windows", 0) < gate.min_windows: return False
    if x.get("max_drawdown_pct", 999) > gate.max_drawdown_pct: return False
    if x.get("profit_factor", 0) < gate.min_profit_factor: return False
    if x.get("win_rate_pct", 0) < gate.min_win_rate_pct: return False
    if not x.get("lookahead_clean", False): return False
    if not x.get("cost_stress_pass", False): return False
    if not x.get("holdout_locked", False): return False
    return True
