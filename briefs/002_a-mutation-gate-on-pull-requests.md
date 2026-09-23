---
status: active
date: 2026-09-24
type: chore
wave: 2
dependsOn: [001]
affectedFiles: [.github/workflows/**, stryker.config.mjs, vitest.mutation.config.ts, scripts/**, docs/adr/**, CLAUDE.md]
protectedFiles: [src/**]
---

# 002 - A mutation gate on pull requests, measured on the hosted runner first

## Intent

Mutation testing runs on every push to `main` and weekly, and its `break`
threshold rests on one local measurement
([ADR-0009](../docs/adr/0009-mutation-testing.md)). When this round is done, a
pull request runs mutation testing on the files it changed, the gate is set
from a measurement on the hosted runner rather than a workstation, and the
record says what the hosted sweep costs in minutes.

## Negative Scope

- No change to any source file to raise the score. Surviving mutants are
  killed by tests, or recorded as equivalent with the reason.
- No lowering of `break` below the hosted measurement to make a run pass.

## Invariants

- [ ] The full sweep on the hosted runner is run and its score and duration
      recorded before the gate is set.
- [ ] A pull request that changes no source file does not run the sweep.
