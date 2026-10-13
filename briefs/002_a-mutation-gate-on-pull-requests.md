---
status: active
date: 2026-09-24
type: chore
wave: 2
dependsOn: [001]
affectedFiles: [.github/**, stryker.config.mjs, stryker.core.config.mjs, vitest.mutation.config.ts, vitest.core.config.ts, scripts/**, tests/**, docs/adr/**, CLAUDE.md, CONTRIBUTING.md]
protectedFiles: [src/**]
---

# 002 - A mutation gate on pull requests, measured on the hosted runner first

## Intent

Mutation testing runs in two sweeps
([ADR-0009](../docs/adr/0009-mutation-testing.md)). When this round is done,
every pull request is swept by both before it merges, whatever it changes,
the full sweep has a gate set from a measurement on the hosted runner rather
than a workstation, and the record says what the hosted sweeps cost in
minutes.

*Amended 2026-10-14.* As written on 2026-09-24 the intent was that a pull
request "runs mutation testing on the files it changed". What was decided,
and built in [pull request 64](https://github.com/DescentVTT/spec-brief/pull/64),
is the whole of both sweeps for every pull request: a verdict is moved by
more than the files a pull request changes under `src/`, as *Decided* below
has it. The state the intent started from is gone too: the full sweep has
had a gate since 2026-09-27, and neither sweep waits for a push to main or
for Monday.

## Negative Scope

- No change to any source file to raise the score. Surviving mutants are
  killed by tests, or recorded as equivalent with the reason.
- No lowering of `break` below the hosted measurement to make a run pass.

## Decided

*2026-10-14.* The second invariant below, as written, was that a pull
request which changes no source file does not run the sweep. It was measured
whether that could be kept, and decided that it is not.

**A change to no source can move every verdict.** Pull request 32 took
vitest to 5 and changed `package.json` and the lockfile alone. It passed
every check it had; under vitest 5 a sweep reads 4.00% in spec-core and
3.83% in spec-harness (ADR-0009, amended 2026-10-07). A change to a test or
to the vendored spec-core moves a verdict the same way. Of the 60 pull
requests merged from 2026-09-26 to 2026-10-12, 24 changed tests, the
vendored copy, the manifest or the lockfile and no source of this
repository.

**A document alone can move one too, where it is a brief.** One run of the
whole suite with every read of a document traced, on 2026-10-14, found six
test files that read a document of this repository:

- `tests/source.test.ts` sets the README, the changelog, the documents the
  package ships and the ADR index against `src/`. It is in neither sweep's
  suite.
- `tests/names.test.ts` and `tests/npm.test.ts` read documents for the
  commands written in them. They are in the full sweep's suite, assert
  nothing of `src/`, and no mutant is covered by a test of theirs.
- `tests/mutation-unmeasured.test.ts` reads the README as a source that is
  none, and `tests/bin.test.ts` starts the built launcher in this
  repository, where `list` and `lint` read the briefs of this directory.
  Both are in neither suite.
- `tests/engine.test.ts`, in the full sweep's suite, reads the briefs of
  this directory through the tool: "opens the repository the process runs
  in when given no directory" asserts that there is a live brief here. In
  the full sweep of pull request 64 (run 38453488907) that test covers 665
  mutants and was the one that killed 28 of them, 20 of `src/engine.ts` and
  8 of `src/fs.ts`; none is covered by it alone.

So one test of a sweep sets `src/` against a document, and the document is
a brief. A change to any other document alone moves no verdict as the
suites stand.

**What a filter that left those documents out would save, and cost.** Three
of the 60 merged pull requests changed documents alone, 20, 38 and 40, none
of them a brief, and each ran once: three of the 79 runs a pull request
started, 28 to 37 minutes of runners each, which a public repository is not
charged for, and a last check after a minute or two where it now comes
after 15 to 23. Against that, GitHub leaves the checks of a workflow that a
filter of paths skipped pending, and a pull request that requires them
cannot merge (*Workflow syntax for GitHub Actions*, under
`on.<push|pull_request|pull_request_target>.<paths|paths-ignore>`, read
2026-10-14): with a filter, `core` and `full` could never be required. And
the filter would be a list to keep true, with this directory in it and
every document a test comes to read.

**No filter.** Every pull request runs both sweeps, and
`tests/mutation-sweeps.test.ts` fails a filter of paths or branches on
either event.

## Invariants

- [x] The full sweep on the hosted runner is run and its score and duration
      recorded before the gate is set.

  ADR-0009, amended 2026-09-27: run 36313440054 read 94.99% over 6,791
  mutants in 26 minutes on the hosted runner, and the gate was set at 93,
  under it, in the change that measured it.
- [ ] A pull request that changes no source file does not run the sweep.

  **Rejected** on 2026-10-14, for the reasons under *Decided*: a pull
  request that changed no source moved every verdict, and a sweep that a
  filter skips could never be required.
- [x] Every pull request runs both sweeps before it merges, whatever it
      changes, and so does every push to main; no path is filtered, and a
      test holds the workflow to that.
- [x] The record says what the hosted sweeps cost a pull request in minutes
      (ADR-0009, amended 2026-10-14).
