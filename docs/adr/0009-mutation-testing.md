---
status: accepted
date: 2026-09-24
---

# ADR-0009: Mutation testing, in two sweeps

## Context

The commissioning brief asked for a mutation score of at least 95% on schema
parsing, dependency resolution, the collision matrix and archival, and for
100% coverage. The sibling tools measure mutation testing, set the gate below
the measurement, and treat it as a regression guard rather than a target.

The first sweep of everything - every module, every test, 6,646 mutants - was
stopped after 23 minutes with 551 tested and an estimate of 20 hours left, on a
Windows workstation with 16 cores and 8 workers. The cause is structural. The
CLI and engine tests run every line of the core, so under per-test coverage a
mutant in the Markdown scanner reruns them too, and each of them spawns git,
which measured between 0.3 and 1.5 seconds a process on that host.

## Decision

**Two sweeps.**

- **The core sweep** (`npm run test:mutation`, `stryker.core.config.mjs`)
  mutates every module but the edges - `cli`, `engine`, `fs`, `git`,
  `plugins` - and holds it to the unit suite: every test that reads no disk
  and spawns no process (`vitest.core.config.ts`). A core mutant has to be
  killed by the tests written for the module it is in, which is the stronger
  claim. It runs in about ten minutes on the workstation above.
- **The full sweep** (`npm run test:mutation:full`) mutates everything
  against the whole suite. It runs weekly in CI and on request, and its gate
  was set from its first hosted run (amended 2026-09-27, below).

**The core gate is `break: 93`**, below the measurement, and moves up with it,
never down to let a change pass.

## Measurement

Four rounds of the core sweep on 2026-09-24, 5,246 mutants in the last:

| Round | Score | What changed |
| --- | ---: | --- |
| 1 | 85.31 | The suite as first written. |
| 2 | 93.26 | Every finding, refusal and banner asserted whole; the algorithm edges below. |
| 3 | 94.11 | Dead code removed; the dialects' anchors and bounds tested. |
| 4 | **95.75** | Whole output of the reports; the last edges of rules and scanner. |

The final score by module, and by what the commissioning brief named:

| Area | Module | Score |
| --- | --- | ---: |
| Schema parsing | `config.ts` | 98.19 |
| | `schema.ts` | 95.88 |
| | `frontmatter.ts` | 94.40 |
| Dependency resolution | `corpus.ts` | 94.06 |
| Collision matrix | `collisions.ts` | 96.60 |
| | `glob.ts` | 94.03 |
| Archival | `integrity.ts` | 100.00 |
| | `links.ts` | 97.45 |
| | `apply.ts` | 97.22 |
| | `archive.ts` | 95.67 |
| Everything else | `scaffold.ts` 98.50, `report.ts` 97.76, `rules.ts` 97.28, `text.ts` 95.35, `lint.ts` 94.74, `brief.ts` 94.58, `markdown.ts` 93.94 | |

Six modules sit under 95. Their survivors were read one by one, and what
remains is equivalent: an array pre-sized to a length a mutant changes, which
JavaScript grows past anyway; a memo table whose loss costs time and not
answers; a loop bound one past the end, where reading past the end yields an
empty string or `undefined` and the loop stops the same; `??` fallbacks for
states the types rule out; comparator branches for values that are never
equal, such as two paths in one corpus. Killing them would take assertions
that restate the implementation, which is worse than the number.

### On the hosted runner

The first core sweep on `ubuntu-latest`, four cores, scored 97.37 in 22
minutes: 329 timeouts to the workstation's 75, and 123 survivors to its 208.
The configuration fixed eight workers, twice the runner's cores, and every
mutant ran slower for it; 85 mutants that survive on the workstation ran out
of time there, and Stryker counts a timeout as detected. The higher score was
the runner's contention, not the tests. The workers are now sized to the host,
which on the workstation changed only the time: 95.75, 208 survivors, ten
minutes. On the runner, with four workers, the next sweep matched the
workstation mutant for mutant - 95.75: 4,948 killed, 75 timed out, 208
survived - in 14 minutes, eight fewer than with eight workers. The gate is
now judged by the same number on both hosts.

Coverage at the same commit: lines 100%, statements 99.9%, functions 99.8%,
branches 98.1%. The floors in `vitest.config.ts` sit just below. The
commissioning brief's 100% is met for lines; the branches short of it are
fallbacks the type system requires and no input reaches.

## What the rounds found

Mutation testing measures what the tests assert, and reading the survivors
was also a review. It found defects no test had:

- **A witness search that scanned all of Unicode** for every pair of
  characters that did not match - the common case of a glob intersection. It
  was milliseconds at native speed and timed a test out under instrumentation.
  It now checks the boundaries of the intervals each token accepts, which is
  complete: the least character of an intersection of unions of intervals is
  the left end of one of them.
- **Two findings for one defect**: a brief depending on itself and on a
  brief in a cycle had the cycle reported as `001 -> 001`, and a
  self-dependency was reported again by `wave-order`.
- **A slug cut at a word boundary lost the word before it.**
- **An empty banner template wrote an empty pair of markers.**
- **Directories were compared unresolved**, so `b` and `b/./` counted as
  different briefs and archive directories.
- Dead code, removed rather than tested: a backslash check the tokenizer
  repeated, a class that could never be empty checked for being empty, slash
  checks in functions a slash cannot reach, and a heading rule that could no
  longer match.

## Consequences

A change to a core module is measured in minutes. A change that makes a unit
test read the disk or spawn a process moves that test out of the core suite,
because under per-test coverage it would be rerun for every mutant it reaches.
The edges are measured weekly rather than per change until the hosted runner's
cost is known.

## Amended 2026-09-26

**The vendored spec-core is not mutated here.** Both sweeps and coverage leave
`src/vendor/` out, and `tests/vendor.test.ts` holds the configurations to it:
the copy is measured in spec-core, against its oracle, and counted here it
would pad or dilute a number about code this repository owns.

**Measured again** at the end of the branch that adopted spec-core's engine and
added `schedule`, deferral, waivers and GitLab output: 5,670 mutants, 97.83 -
5,023 killed, 524 timed out, 112 survived, 11 without coverage - in 26 minutes.
Three other repositories' sweeps shared the workstation, which is what the 524
timeouts are; the same commit an hour earlier, with less beside it, timed out
201 and left 115. The number to compare across hosts is the survivors: 112,
where 0.1.0 left 208.

| Module | Score | | Module | Score |
| --- | ---: | --- | --- | ---: |
| `glob.ts` | 100.00 | | `rules.ts` | 97.91 |
| `scope.ts` | 100.00 | | `brief.ts` | 97.61 |
| `trigger.ts` | 100.00 | | `text.ts` | 97.45 |
| `schedule.ts` | 99.66 | | `archive.ts` | 96.99 |
| `collisions.ts` | 99.42 | | `lint.ts` | 95.83 |
| `report.ts` | 98.83 | | `corpus.ts` | 94.69 |
| `config.ts` | 98.26 | | | |

Two survivors remain on the lines the branch changed, and both are
equivalent: the matrix's diagonal read as "not the same brief" - no pair of a
brief with itself is ever recorded - and a front matter's closing line tested
as below zero rather than at or below it, where it is never zero.

The rounds found one thing worth keeping. A test file that computes a corpus
at `describe` level runs that code at load, and Stryker counts the lines it
reaches as static: their mutants are then measured against the whole suite
rather than the tests that use them, and a mutant that breaks the schedule
outright survived that way. Build what a test needs inside the test. 1,597 of
the 5,670 mutants are static, most of them the rule and configuration tables,
and they are four fifths of the time.

The gate stays at 93.

## Amended 2026-09-27

**The full sweep has a gate: `break: 93`.** Its first hosted run, dispatched
on main (run 36312377428), failed before any mutant: `disableTypeChecks` in
`stryker.config.mjs` reached `src/vendor/`, and the sandbox copies of
spec-core, each with `// @ts-nocheck` prepended, no longer had the hashes
`tests/vendor.test.ts` checks. With the glob narrowed to `src/*.ts`, the run
on that branch (run 36313440054) measured **94.99% over 6,791 mutants** in 26
minutes on `ubuntu-latest`: 6,418 killed, 33 timed out, 316 survived, 24
without coverage. Losing every timeout kill would leave 94.51%. The core sweep
of the same commit read 96.93%, where main's had read 97.01%: that is the
noise between two runs of one source. The full gate sits at the core's 93,
under both, and moves up with the measurement. Twenty-six minutes is cheap
enough that the full sweep could run on every push to main as the core sweep
does; it stays weekly until a push shows the need.

## Amended 2026-10-07

**The full sweep's survivors, read one by one.** Main's sweep of 9e2f6a1 (run
37511908755) read 95.22% over 7,096 mutants: 6,716 killed, 41 timed out, 315
survived and 24 without coverage; 94.64% with every timeout lost. Each of the
339 it left undetected was read and applied by hand: killed by a test that
states what a caller sees, removed with code that decided nothing, or left
as equivalent with a comment at the code saying why. The sweep of that branch
(run 37535078122) read **99.31% over 6,941 mutants**: 6,852 killed, 41 timed
out, 45 survived and 3 without coverage; 98.72% with every timeout lost. Of
the 339, 197 are the same mutant at the same text and detected there, 109
are gone with their text, and 33 stand where they stood; the 48 the branch
leaves are the equivalent ones, each commented. The core sweep of the same
commit read 99.38% over 5,286, with 30 survived. The gate stays at 93 until
main has been measured, and then moves up under that worst case.

Reading them was a review again, and found what no test had:

- **A table kept in an object answers to names it was never given.**
  `constructor`, `toString` and `__proto__` are on every object, so
  `spec-brief constructor` passed for a command and ended on a stack trace
  with exit 1, a brief with `type: constructor` stopped lint for every brief,
  a configuration key `toString` was "must be undefined", and `{constructor}`
  in a template was filled with a function's source. The commands are a map,
  and a type, a key and a placeholder are asked for as an own key.
- **A directory named `..drafts` was taken for a path out of the work tree**,
  and a configuration there lost git: archival skipped its dirty-tree check
  and reported the scope as unmeasured.
- **The matrix marked a pair of briefs by their ids**, so two briefs that
  share one drew as one. The 2026-09-26 amendment calls the diagonal's mutant
  equivalent; that held while no two labels were equal, and the grid is now
  drawn by where a brief stands, with no diagonal of its own.
- **A banner on a file's first line hides the front matter under it**, and an
  archival of such a brief with a TOML or an unclosed block threw out of the
  planner instead of refusing.

What the pass taught, for the next one:

- **Vitest resolves an import as a bundler does.** A path without an
  extension loads under the test runner and not under Node, so no test here
  can tell which resolver a plugin's path went through by what loads; the
  message of a path that does not load tells them apart.
- **A condition the host does not offer goes under the test's control, in a
  file of its own.** A rename another process holds, a directory that may not
  be read and names that come in no order are Windows' or Linux's, never
  both: `tests/io-faults.test.ts` mocks `rename` and `readdir` alone, as the
  sibling tools do, and every other call reaches the disk.
- **A hand replay that finds a mutant by the text around it must say where
  it landed.** With a comment added above a mutant, its longer anchors no
  longer match, and the shortest one found the same line in another
  function, whose test then "killed" it.
- **What a test file builds while it loads is static to Stryker**, as the
  2026-09-26 amendment says, and it was still done: three test files parsed
  briefs or resolved a configuration at `describe` level, which made the
  reader's, the scanner's and the schema's mutants static. They are built
  for each test now. Listing the tests with a probe in `parseBrief` and
  `resolveConfig` finds such calls, since `vitest list` loads every file and
  runs none. Main's sweep counted 1,308 static mutants, 18% of all and by
  Stryker's estimate two thirds of its time; the branch's counts 722, a
  tenth and half.

**Shards, not yet.** The full sweep took 22 to 31 minutes as one job, and 25
on the branch. It runs weekly and on request, outside the path of a change,
and under the 45 minutes at which its workflow says it wants shards. Split
as spec-harness's is, it would finish sooner, at the price of the merge
script and its tests kept here as well, and of every shard's own start. The
static mutants above were the cheaper minutes, and were taken first.
