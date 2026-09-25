---
status: accepted
date: 2026-09-26
---

# ADR-0011: Waves are computed, not guessed

## Context

A goal too large for one round is split into briefs, and the briefs into
waves: the rounds that can run side by side. Until now a person or an agent
chose each brief's `wave`, and spec-brief checked the choice afterwards -
`wave-order` for a dependency in the same or a later wave, `matrix` for two
briefs in one wave that can write one file. Choosing is where the mistakes
were made; checking only found them.

The family's plan for decomposition (spec-core ADR-0006) split it in two. What
the rounds are is prose - reading a goal and cutting it along files and
decisions - and belongs to the agent, guided by spec-harness's `split-goal`
skill. Where the rounds go is not prose. Given each brief's dependencies and
scope, placing them is a precise question with an answer a tool can give the
same way every time.

## Decision

**`spec-brief schedule` computes the waves.** It reads the live briefs, drafts
included, and places each by precedence-constrained greedy colouring:

- Briefs are taken in dependency order - Kahn's, taking the least id among
  those whose live dependencies are all placed - so the order is fixed by the
  briefs and not by the file system.
- Each goes into the lowest wave that is after every live dependency's wave
  and holds no brief it collides with. A collision is the one `matrix`
  reports: some file in both writable scopes, affected less protected, found
  by spec-core's witness search ([ADR-0005](0005-scopes-collide-by-intersection.md)).
- An archived dependency is done and constrains nothing. A dependency spec-brief
  cannot find, or a brief's dependency on itself, is lint's finding and is
  left out.
- A brief with no `affectedFiles` shares its wave with nobody: an unscoped brief
  cannot be proved apart from anything, and placing one beside another would
  be a guess.
- A pair the search cannot decide within its budget is kept apart, as a
  collision would be, and reported as `collision-undecided`.
- The first wave is the lowest any scheduled brief declares, or 1, so a
  repository's numbering is kept.

**Every move is explained.** Beside each brief's declared wave is the proposed
one, and for a move, why: the dependency that set the earliest wave, and for
every wave passed over, the brief there and the file both would write. A
`wave-schedule` finding carries the same sentence, so CI can annotate it.

**It is written only when asked, and as the archive writes.** `--write` sets
`wave` in the front matter of each brief whose wave changes, with the
front-matter editor that leaves every other line as it was, as one transaction
over files ([ADR-0004](0004-archival-is-a-planned-transaction.md)). A front
matter that is never closed cannot be edited, and refuses the whole write.

**A cycle is an error, and stops the schedule where it is.** Nothing in a
cycle, or depending on one, can be placed; the cycle is reported, the rest are
placed, and nothing is written.

**Exit codes are the family's.** `0` when the declared waves are the computed
ones, `1` when they would change or there is a cycle, `2` when the run cannot
be trusted.

## Deferred work

A deferred brief ([ADR-0003](0003-conventions-are-configuration.md), amended)
is placed in no wave, and neither is a brief that depends on one: it cannot
start before work that is waiting for an event. `schedule` lists both, with the
brief each waits on.

## Alternatives

| Option | Why not |
| --- | --- |
| The fewest waves | Colouring a graph with the fewest colours is NP-hard. A search that promises it costs time that grows with the input's exponent, and a timeout that answers differently on a slower host is not an answer. |
| Keep each declared wave when it is valid | Two valid schedules would both exit 0 and neither would be "the" schedule; the answer would depend on the order briefs were written in. A person can still move a brief later by hand, and `lint` and `matrix` check that. |
| Order by file name, or by wave declared | The id is what a brief is called everywhere else, and a declared wave is the thing being computed. |
| Write a roadmap | The brief is the record ([ADR-0002](0002-the-brief-is-the-record.md)). The waves live in the briefs' own front matter, and a roadmap is a document people write. |

## Consequences

Greedy colouring can use more waves than necessary: a brief placed early by
its id can push a later one past a wave it could have shared. The schedule is
valid and deterministic, and a generated corpus holds it to both: once
written, `matrix` finds no collision in it, `lint` finds every dependency in an
earlier wave, every unscoped brief is alone, and scheduling it again moves
nothing (`tests/schedule.test.ts`). The cost of a run is one witness search
per pair of patterns of briefs it compares, a fraction of a millisecond each.
