# LUNA WebApp UX/UI v1

## Direction
LUNA is presented as an investment control room, not a generic portfolio tracker.

Visual direction:
- graphite / near-black foundation
- restrained emerald signal color
- compact typography
- thin borders and low-contrast surfaces
- information density without visual noise
- clear separation between operational state and research state

## Information hierarchy
1. System state: market feed, execution mode, kill switch, live-order gate.
2. Capital state: equity, cash, market value, exposure, P&L, fees.
3. Decision state: current positions, signals and execution history.
4. Evidence state: latency, audit integrity, research and system checks.

## Navigation
The header provides persistent workspace navigation:
- Overview
- Trades
- Closed
- Research

The existing in-card tabs remain for contextual navigation on the same dataset.

## Primary interaction
The default workflow is:
open LUNA → confirm system state → scan capital/risk metrics → inspect positions → select a symbol → review current signal and execution timeline.

The right-side symbol detail panel is sticky on desktop so selected-position context remains visible while the table scrolls.

## Responsive behavior
Desktop:
- top navigation visible
- four-column metric grid
- two-column positions + detail workspace
- sticky detail panel

Tablet:
- navigation condenses
- metrics reduce to three/two columns
- workspace remains readable without horizontal page scrolling

Mobile:
- navigation moves to contextual tabs
- metrics become one/two columns
- detail panel moves below the table
- operating-status cards stack vertically

## Operational safety language
The UI distinguishes:
- LIVE DATA from OFFLINE
- PAPER EXECUTION from LIVE EXECUTION
- KILL SWITCH ON/OFF
- LIVE ORDER GATE READY/LOCKED

No visual state implies that an order was actually sent unless the underlying control state says so.

## Performance cues
The interface displays real latency metrics only when measured and labels unavailable measurements explicitly rather than showing misleading zeroes.

The visual design intentionally avoids animations that could compete with rapidly changing market information.
