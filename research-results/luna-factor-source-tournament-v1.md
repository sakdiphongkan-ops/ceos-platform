# LUNA Factor Source Tournament v1

This experiment compares three data-source configurations under one locked protocol:

1. technical-only
2. fundamental-only
3. hybrid technical + fundamental

## Locked protocol

- identical universe and monthly panel
- identical formula count
- identical random seed
- identical K
- identical round-trip cost
- identical nested walk-forward windows
- identical frozen holdout
- holdout never used for selection

## Anti-overfitting controls

Each track reports:

- train
- validation
- nested outer OOS
- frozen holdout
- validation-to-holdout geometric-return gap
- outer-OOS-to-holdout geometric-return gap
- number of technical/fundamental factors actually eligible

A fundamental-only track is marked `UNAVAILABLE` when PIT fundamental coverage is insufficient. The hybrid track is not silently reduced to technical-only.

## Interpretation

The tournament is descriptive evidence. It does not declare a global winner and does not promote a strategy to live trading.

The useful question is whether adding PIT fundamentals improves out-of-sample and frozen-holdout behavior while reducing or preserving the generalization gap under the exact same search budget.
