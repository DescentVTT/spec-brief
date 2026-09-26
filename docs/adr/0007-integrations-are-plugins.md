---
status: accepted
date: 2026-09-24
---

# ADR-0007: Integrations are plugins

## Context

The commissioning brief asked for built-in switches that validate
cryptographic departure signatures (`spec-escalate`), verified reproducer logs
(`spec-probe`) and AST blast radiuses (`spec-code-graph`). None of those tools
is in the organisation's repositories today, so none of their formats is
defined. A verifier for a format nobody has written is an invention, and the
tool that later defines the format would have to match a guess.

## Decision

A plugin is a module that exports `{ name, rules }`, or a function of its
configured options that returns one. Its rules receive the brief, the corpus,
the configuration, the tracked files and their options, and return findings
with lines. They run inside `lint` as `<name>/<rule>`, with severities set in
configuration like any built-in rule. A plugin whose export has the wrong
shape stops the run, as a configuration that does not load does.

## Consequences

The tool that defines a format ships the check for it, and upgrades the two
together. spec-brief carries no copy of formats it does not own. Loading a
plugin runs its code; the configuration belongs to the repository, and so does
that trust, as with a linter's configuration.

## Amended 2026-09-26: a plugin may waive a refusal

spec-harness now defines one of the formats this record waited for: a ruling,
a row in a brief's `## Rulings` table whose last-changing commit is signed by a
key the base branch lists (spec-harness ADR-0006). A verified ruling that
allows a protected path must let the archive accept a change to it - and
spec-brief must still not read signatures. So a plugin may export, beside its
rules, a `waive` hook.

- **What it is asked.** After the archive is planned, the engine - the edge
  that meets plugins - calls each plugin's `waive` with the root, the brief (id,
  file, text), the plan's refusals, the base and the commit, all as one frozen
  copy. It asks only when the plan has a refusal a plugin may lift: a hook may
  read git and verify signatures, and a plan with nothing to lift has no
  question for it.
- **What it may answer.** A list of `{ rule, path, reason }`. Only
  `protected-file` and `out-of-scope` can be waived: a verifier can say a file
  was allowed to change, and whether the round is done - its boxes, its
  dependencies, its tree - stays spec-brief's to say. A waiver for any other
  rule is ignored, with a `waiver-ignored` warning. A waiver matches a refusal
  by rule and path, and the refusal becomes a `waived` note that names the
  plugin, the rule, the path and the reason, so the person approving the
  archive sees what stood in for it. The match is against the plan's own
  refusals, never the copy the hook read: handed the plan's list, a hook could
  drop a refusal from it, or relabel an open task as a protected file and
  waive that, and lift what only spec-brief may. A hook that returns nothing
  has waived nothing.
- **What a failure means.** A hook that throws, or answers in another shape,
  stops the run with exit 2, as a plugin that fails to load does. A write to
  the frozen copy throws, so a hook that tries to change the plan stops it.
  An archival decided without the check the configuration asked for is not
  one to trust.

For this, a refusal must name its path. **`protected-file` is one finding per
file**, with a `path` field - each protected file changed is its own defect,
reverted or ruled on one at a time, so one finding each keeps "one defect, one
finding". **`out-of-scope` stays one finding**, now with a `paths` list: a scope
that was wrong is one defect however many files show it, widened once. A
waiver takes one path out of it, and the finding goes when none is left.

A plugin is found as an import from the root would find it, a package's
`exports` read under the import conditions, so a subpath such as
`@descent-vtt/spec-harness/spec-brief-plugin` loads.
