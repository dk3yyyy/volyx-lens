# Agent Etna — Contract & Guardrails

This file is maintained automatically by **Agent Etna** for **volyx lens**.
It is this agent's behavioral **contract**: what it's for, who it serves, what's
in and out of scope, plus a log of every change Etna has applied — so the whole
footprint is visible and auditable in your own repo.

_Maintained by Agent Etna. Don't edit by hand — it is rewritten on every shipped change._

## Agent
- **Repo:** `dk3yyyy/volyx-lens` (branch `main`)

## Behavioral contract
_No calibration set yet — Agent Etna uses general defaults until you calibrate this agent._

## Guardrails
- No behavioral calibration set yet — Agent Etna uses general defaults until you calibrate this agent.

## Change history

### 2026-08-27 · Cycle 2 · 1 change · merged
- **behavior:honest-limits** — The agent crashed because it attempted to import a module that is not available in its execution environment, indicating a lack of domain knowledge about its own runtime constraints.
