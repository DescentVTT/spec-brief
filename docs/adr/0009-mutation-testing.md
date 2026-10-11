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
commit read 99.38% over 5,286, with 30 survived. The gate stayed at 93 until
main had been measured: its sweep of 9670753 (run 37541947048) read 99.31%
over 6,941 and, for the core, 99.38% over 5,286 - 98.73% and 98.68% with
every timeout lost. **Both gates are now `break: 97`**, under that worst
case, and move only up. For 0.6.0 the sweep of 6decf9d (run 37697989079)
read the same two figures over the same counts, with the survivors of
9670753 and none new. For 0.6.1 the sweep of d94da7d (run 37791585328) read
99.31% over 6,963 and, for the core, 99.36% over 5,286, where 34 mutants
timed out against 106 before: the full sweep's survivors are the same, and
the core's one more is the anchor of `NOTE_START`, which had only timed out
there, survives the full sweep as it always has, and is called equivalent
beside the code. For 0.7.0 the sweep of fba3c1e (run 37827733882) read
99.33% over 7,041 and, for the core, 99.36% over 5,289: the 78 mutants the
refusals of that release made were all killed, no survivor is new, and one
is gone, the check that the variable is set in `today()`.

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

## Amended 2026-10-07: vitest is held on 4

**Vitest stays on 4 until Stryker's runner reads 5.** On vitest 5,
`@stryker-mutator/vitest-runner` 10.0.0, the newest there is, runs no test
against a mutant a test covers and scores it as survived, with every test
green: vitest 5 matches a test's name with ` > ` between its suites, and the
runner asks for the tests of a mutant by names joined with a space
([stryker-js #6210](https://github.com/stryker-mutator/stryker-js/issues/6210),
open). The evidence is spec-guard's, which met this on 2026-09-07 and pinned
vitest then
([its ADR-0003](https://github.com/DescentVTT/spec-guard/blob/main/docs/adr/0003-mutation-testing.md)).
On 2026-10-06 Dependabot proposed vitest 5.0.0 across the family. The two
repositories that sweep a pull request in full measured it: 4.00% in
spec-core, where main reads 96.36%, and 3.83% in spec-harness, where main
reads 98.13%. Here pull request 32 passed every check, because no sweep runs
on a pull request: the bump would have merged green, and main's core sweep
would have failed after it, with a score and no reason.

So `.github/dependabot.yml` proposes no major of `vitest` or of an `@vitest`
package, and `tests/source.test.ts` fails when `package.json` admits a
vitest that is not a 4, with the issue and this amendment in its message: a
bump made by hand fails `npm test` before it reaches main. Minors and
patches of 4 still come, and a security update is not held back.

The hold is the family's and is lifted in spec-core first, by the steps in
[its ADR-0008](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0008-toolchain.md)
(amended 2026-10-07), which also records what vitest 4 still receives while
it is held. When the bump comes here, its pull request measures nothing:
dispatch `mutation.yml` on the branch with `full` ticked, and hold both
sweeps to that ADR's two conditions before merging.

## Amended 2026-10-11: a mutant's quickest test files first

**Both sweeps run a mutant's test files quickest first.** Stryker's vitest
runner runs a mutant's files one after another in one worker and stops at
the first test that fails, and vitest's own sequencer puts a file that
failed in the last run first and then the longest. spec-harness measured
what that costs a sweep whose longest file takes most of a minute, and
halved its sweep with an order of its own
([its ADR-0010](https://github.com/DescentVTT/spec-harness/blob/main/docs/adr/0010-toolchain-and-verification.md),
amended 2026-10-09). Here the whole suite takes eight seconds before any
mutant, so the first question was whether there is anything to gain.

**What the last sweep under vitest's order said** (run 37827733882, of
fba3c1e, from which main had moved in no source and no test):

- The 726 static mutants, a tenth of the 7,041, took 6.1 of the sweep's 24.4
  minutes.
- 99 of them were killed only after another file's tests had run to their
  end, and 600 of the 6,312 others, which run the files of the tests that
  cover them: 47,370 tests ahead of the file that killed, of the 81,120 the
  killed mutants ran.
- Longest first, the files ahead were `tests/glob.test.ts`,
  `tests/cli.test.ts` and `tests/schedule.test.ts`, three fifths of the
  suite's time between them. Priced by each file's share of the initial run,
  the tests ahead cost between 1.7 and 3.2 of the 24.4 minutes, and each
  file ahead a quarter of a second more before its first test.

That bounded the gain at a few minutes and could not say how much of it
another order keeps: quickest first, a mutant that only a long file kills
waits for more files, each cheaper. So the order was written and the sweeps
run.

**The order** is `QuickestFirst` in `vitest.mutation.config.ts`, which
`vitest.core.config.ts` reads too: a file that failed in the worker's last
run first, as vitest has it, then the quickest, and a file the worker has
not timed after those, the smaller first. It reads what vitest recorded of
each file by the key vitest files it under. `tests/mutation-order.test.ts`
sets it beside vitest's own sequencer, so that a key vitest stops using
fails a test where the order would quietly have gone by size, and holds it
to the two sweeps' suites and to no other run. That file reaches nothing
under `src/` and is left out of both suites. No test left either run: the
initial runs count 976 tests and 663, as before, and `npm test` runs as it
did.

**A hosted runner is one of several machines**, and a sweep's minutes say
more about which one it drew than about the order: Stryker's initial run,
the suite once before any mutant, took between 9.6 and 15.3 seconds in the
full sweeps below, and between 5.7 and 9.8 in the core's. So each sweep is
set beside its own initial run, as the seconds it took for each second of
that.

| Full sweep | Order | Initial run | Timeouts | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: | ---: |
| 37535078122, 10f7e31 | vitest's | 14.1 s | 41 | 25m28s | 108.3 |
| 37541947048, 9670753 | vitest's | 13.7 s | 40 | 25m06s | 110.1 |
| 37697989079, 6decf9d | vitest's | 11.2 s | 40 | 19m14s | 102.6 |
| 37791585328, d94da7d | vitest's | 11.2 s | 40 | 18m28s | 98.5 |
| 37823599893, 52bd762 | vitest's | 14.7 s | 42 | 27m45s | 113.0 |
| 37827733882, fba3c1e | vitest's | 15.0 s | 41 | 24m53s | 99.6 |
| 38111383731, 9e7c806 | quickest first | 9.6 s | 39 | 13m16s | 83.2 |
| 38114058527, b686bde | quickest first | 15.3 s | 40 | 21m27s | 84.2 |

Both full sweeps in the new order read the score of the one before them,
99.33% over 7,041, with the same 44 survivors and the same 3 without
coverage, mutant for mutant. One or two of the 41 that had timed out were
killed instead. The second drew a runner as slow as fba3c1e's and took
21m27s where that sweep took 24m53s: its killed mutants ran 67,897 tests
for 81,120, and its static mutants took 3.7 of its 21.0 minutes for 6.1 of
24.4, where the other mutants took 17.3 for 18.3. The first, on the fastest
runner of the eight, says the same against its initial run: the static
mutants two fifths less, the others a tenth.

| Core sweep | Order | Initial run | Timeouts | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: | ---: |
| 37535078122, 10f7e31 | vitest's | 9.7 s | 38 | 16m19s | 101.2 |
| 37541947048, 9670753 | vitest's | 8.7 s | 37 | 14m51s | 102.9 |
| 37697989079, 6decf9d | vitest's | 9.7 s | 106 | 20m57s | 129.7 |
| 37791585328, d94da7d | vitest's | 7.3 s | 34 | 12m03s | 99.2 |
| 37823599893, 52bd762 | vitest's | 8.9 s | 33 | 13m34s | 91.8 |
| 37827733882, fba3c1e | vitest's | 5.7 s | 34 | 9m59s | 105.2 |
| 37832112651, 8574276 | vitest's | 5.8 s | 105 | 13m43s | 140.7 |
| 38111072675, bffbb0e | vitest's | 9.2 s | 38 | 15m18s | 100.2 |
| 38111383731, 9e7c806 | quickest first | 9.8 s | 36 | 14m21s | 88.0 |
| 38114058527, b686bde | quickest first | 9.3 s | 36 | 13m20s | 86.0 |

The core sweep gains less: 88.0 and 86.0, where the six sweeps under
vitest's order that had no burst of timeouts read 91.8 to 105.2. Both read
99.39% over 5,289, with 5,221 killed, 36 timed out, 29 survived and 3
without coverage, and no survivor that is new. Two of the 31 that fba3c1e
left timed out in both, which is two mutants changing sides and no test
killing them:

- the anchor of `NOTE_START`, which had changed sides between two sweeps of
  one source under vitest's order already;
- `!read.ok` held false in `src/glob.ts`, which survived the four sweeps
  under vitest's order whose reports were read and timed out in both under
  this one. Written into the source by hand, it fails none of the 471 tests
  of the fifteen unit files that cover it, in the time the source as it
  stands takes, and the full sweep, which allows a mutant twenty seconds,
  leaves it surviving in either order. It is a survivor at the edge of what
  the core sweep allows, and why this order takes it over the edge is not
  known.

**The bursts of timeouts were the order's.** In two of the eight core
sweeps under vitest's order, 70 of the 82 static mutants of
`src/trigger.ts` timed out one after another: the 106 timeouts for 34 that
the amendment of 2026-10-07 records, and about four minutes of each of those
sweeps. `tests/trigger.test.ts` is the quickest file of the suite, so
vitest's order ran it last, and the first such mutant a worker met ran the
whole unit suite before the file that kills it, 554 to 566 tests in the
sweep of fba3c1e. With four workers on the runner's four cores that can
pass what the core sweep allows a mutant. A mutant that times out takes its
worker with it, and the worker that replaced it ran the longest files first
again: the few mutants of the burst that were killed were killed by
`tests/rules.test.ts`, after 107 tests. A timeout counts as a kill, so the
score did not show a burst; the score with every timeout lost did, 97.39%
where it reads 98.71%.

Quickest first, neither core sweep had a burst, which two sweeps cannot
prove of the next. What they show is the wait getting shorter and rarer:
the first such mutants met that file after 38, 38 and 39 tests in one core
sweep and after 31, 31 and 572 in the other. A worker that has not run a
file has no time for it and runs it after every file it has, which is the
572, and 749 and 792 tests in the full sweeps; a worker with no times at
all runs the smaller files first, and that file is the third smallest.

The gates stay at 97: an order changes no mutant's fate, and the two that
changed sides are timeouts. The workflow's comment said the hosted full
sweep takes 22 to 25 minutes, and now says what the table does.

Seen on the way, and left:

- A file the worker has not timed could run before the files it has
  instead of after them, as vitest runs a file it does not know first. That
  would end the waits above, at the price of a long file run first once in
  each worker; it was not measured.
- Five test files that reach no mutant, `names`, `npm`, `runner-images`,
  `vendor` and `release`, 154 tests, are in the full sweep's suite, and a
  static mutant now runs them before any slower file, where it ran them
  last. Leaving them out is a test leaving the run, and a decision of its
  own.
- The 39 to 42 mutants that time out in the full sweep wait twenty seconds
  each, `timeoutMS`, for a suite that takes eight: about four of its
  minutes on four workers.
