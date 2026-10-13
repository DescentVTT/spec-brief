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
is gone, the check that the variable is set in `today()`. For 0.8.0 the
sweep of 85e6ae9 (run 38128320340), the first for a release with a mutant's
quickest test files first, read 99.32% over 7,165 and, for the core, 99.39%
over 5,289. The refusals of that release made 124 mutants and left two:
the `default` of each of the two functions that say what an option would
tell (`src/cli.ts`), which answers nothing where it answered false, to
callers that ask only whether the answer is true. Each was equivalent, and
neither is there now: the two switches are written with no `default` and
their `return false` after them, and the sweep of that change (run
38136701661, of e887422) read 99.34% over 7,163, with 44 survivors and 3
without coverage. No other survivor was new. In the core two of 0.7.0's
31 timed out, the anchor of `NOTE_START` and `!read.ok` held false in
`src/glob.ts`; both survive the full sweep as they did, and the core sweep
since it has the full sweep's clock, where it reads 99.34% over 5,289 with
32 survivors (amended 2026-10-11, below).

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

## Amended 2026-10-11: what the sweeps wait for

**The core sweep has the full sweep's clock, and nothing else moves.** The
amendment above left three things seen and not measured: twenty seconds for
each mutant that times out in the full sweep, a test file a worker has not
timed, and five test files that cover no mutant. Measured from the reports
and logs of the sweeps since, none is worth its change, and each stays as
it was. What the measuring found is the core sweep's own clock: three
seconds, which scored as timed out mutants that survive and mutants a test
kills.

**A timeout is one of two verdicts, and the report says which.** Stryker
counts how often a mutant's own switch runs, and ends the run where that
passes a hundred times what the initial run counted: `Hit limit reached`,
beside the verdict. A loop that no longer ends passes its switch on every
turn and is over in the time the count takes. Any other run is over when
its time is: one and a half times what its tests took in the initial run,
and `timeoutMS`, and what the initial run took over its tests' own time,
four to seven seconds on these runners. Its worker is then replaced.

**The full sweep's clock decides six mutants.** In ten full sweeps, in
either order, 39 to 41 mutants time out, and 33 to 35 of them end at the
hit limit. The clock's are the same six each time: three promises nobody
settles, the pause before a rename is tried again in `src/fs.ts` and git's
answer in `src/git.ts`, twice, and three loops that stop passing their own
switch, two in `src/corpus.ts` and one in `src/schedule.ts`. Six waits of
twenty seconds are two minutes of one worker and half a minute of a sweep
on four; with the rest of what a mutant is allowed, 30 to 64 seconds of
sweeps that took 13 to 23 minutes, where the amendment above said about
four minutes. The log agrees: in run 38128320340 the 39 timeouts fall in 16
of its 79 ten-second intervals, seven of them in one, and the sweep tested
as many mutants in those intervals as in the others. At five seconds the
full sweep would return 19 to 23 seconds a sweep, and the core sweep shows
what it would pay for them. Twenty stays.

**The core sweep's clock decided more, and wrongly.** Three seconds gave a
mutant that runs the whole unit suite fifteen, for a suite that takes ten
alone on the runner and longer beside three busy workers. In each of the
eleven core sweeps whose reports were read, three of the clock's timeouts
are the three loops above. The others are set here beside what the same
mutants read in a core sweep with the full sweep's clock (run 38139011628):

| Core sweep | Timed out | At the hit limit | At the clock | Of the clock's: a loop above | the hit limit's | survives | a test kills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 37827733882, fba3c1e | 34 | 28 | 6 | 3 | 1 | 1 | 1 |
| 38116672624, 998eeb9 | 37 | 25 | 12 | 3 | 4 | 2 | 3 |
| 38111383731, 9e7c806 | 36 | 26 | 10 | 3 | 3 | 3 | 1 |
| 38114058527, b686bde | 36 | 26 | 10 | 3 | 3 | 3 | 1 |
| 38118962074, f5f33a2 | 36 | 26 | 10 | 3 | 3 | 3 | 1 |
| 38127993060, 9a6b0d0 | 38 | 25 | 13 | 3 | 4 | 3 | 3 |
| 38128316870, 85e6ae9 | 34 | 25 | 9 | 3 | 4 | 2 | 0 |
| 38128320340, 85e6ae9 | 34 | 25 | 9 | 3 | 3 | 3 | 0 |
| 38129482709, 9f9747d | 105 | 25 | 80 | 3 | 4 | 3 | 70 |
| 38129667388, b7fb20c | 33 | 25 | 8 | 3 | 4 | 1 | 0 |
| 38136701661, e887422 | 35 | 25 | 10 | 3 | 4 | 3 | 0 |

The mutants that survive are three, and the full sweep left each of them
surviving every time: the memo of `indexOf` held empty in `src/glob.ts`,
which the comment beside it calls time and no answer, timed out in all
eleven; the anchor of `NOTE_START` in nine; and `!read.ok` held false in
`src/glob.ts` in seven. The last two are the mutants the amendments above
follow from side to side: survivors that the core's clock cut off in most
sweeps under quickest first and in few under vitest's order. Why one order
brings them nearer the clock than the other is still not known; what they
were at the edge of was the clock, and the core sweep's score counted all
three as detected. The hit limit's are the four mutants of one loop in
`src/glob.ts`, which need 13 million turns to reach it.

**The bursts were the clock's.** The amendment above laid them to vitest's
order, and said two sweeps without one could not prove it of the next. The
seventh core sweep under quickest first, main's of 9f9747d (run
38129482709), had one: 105 timeouts, seventy of them among the 82 static
mutants of `src/trigger.ts`, in 19m06s where the sweep of the commit before
it took 13m01s.

How one forms is in what a worker knows. The four workers start before the
initial run and read then the times vitest keeps of each file, one
`results.json` that all of them write after every run and none reads again.
One worker makes the initial run and so times every file; the others time
a file when a mutant first has them run it. No mutant but those of
`src/trigger.ts` is covered by a test of `tests/trigger.test.ts`, and those
are static, so a worker that did not make the initial run meets that file
on such a mutant: not timed, so after every file that is, with the whole
unit suite ahead of it. Beside three busy workers that run passed its
fifteen seconds. A run that times out records no time, and its worker is
replaced by one that reads what a worker last wrote; the core's clock
replaced 8 to 13 workers a sweep. Once no worker and no file has the time,
every mutant of the file runs out in turn. In that sweep
`tests/trigger.test.ts` killed none of the 82, and `tests/rules.test.ts`,
on the way, twelve.

The full sweep has the same order, the same workers and the same file, and
no burst in ten sweeps: there the first such mutant a worker meets runs 700
to 800 tests, is killed, and the file that killed it runs first from then
on.

**With the full sweep's clock** the core sweep was run twice, of 88ff45c
and of e91857e (runs 38139011628 and 38140522710). `stryker.core.config.mjs`
now sets no clock of its own, and a test holds the two sweeps to one and
fails a shorter one. Both sweeps read 99.34% over 5,289: 5,222 killed, 32
timed out, 32 survived and 3 without coverage, with the same verdict for
every mutant in the one as in the other.

- The clock decides three mutants, the three loops, which it decides in
  the full sweep too. The four of the loop in `src/glob.ts` end at the hit
  limit.
- The 32 survivors are the 29 the full sweep leaves of the 5,289 mutants
  both sweeps make, and three that only tests outside the unit suite kill,
  two in `src/lint.ts` and one in `src/scaffold.ts`. On every other mutant
  the two sweeps agree on whether it is detected.
- Set beside each of the eleven sweeps in the table, every mutant that
  changed sides had been the clock's, but for one of the two below, and no
  mutant an assertion killed ran out of the clock.
- In the first of the two, a mutant of `src/trigger.ts` that a worker met
  with no time for its file ran 571 tests and was killed.

Two mutants of `src/corpus.ts` change sides between sweeps of one source
under any clock, by which of their tests runs first: `stack.push(v)` taken
out is killed by an assertion where a test that fails comes before the test
that hangs, in three full sweeps of the ten, and a `||` made `&&` is killed
after one test or ends at the hit limit.

The longer clock costs seconds. Three mutants wait for it where eight to
thirteen waited for the short one, seventeen seconds longer each: 51
seconds of one worker, 13 of a sweep. The survivors and the loop in
`src/glob.ts` now run to their end, which no report times. The two sweeps
took 12m41s and 13m43s, 86.7 and 88.9 seconds for each second of their
initial runs, where the eight sweeps under quickest first that had no burst
read 83.2 to 88.0, a mean of 85.4, and the one that had it 120.0. A
burst is four to six minutes, and three of the eighteen core sweeps in
these tables that had the short clock had one.

**The core's score reads lower for it, and is the same tests.** 99.34%
where the sweeps above read 99.36% to 99.39%: 32 survivors for 29 to 31,
each of the three recorded as equivalent beside its code already. With
every timeout lost it reads 98.73%, where it read 98.68% to 98.75% and, in
a burst, 97.41%. The gates stay at 97.

**A file the worker has not timed still runs after those it has.** In the
six full sweeps under quickest first that came before this change, the
tests a killed mutant ran ahead of the file that killed it were set beside
what the order accounts for: the tests of its files that are quicker than
the killer's, by the times of the suite's own CI job (run 38129482640).
Static mutants ran 1,630 to 4,838 tests more than that, 13 to 61 mutants a
sweep, and the others 2,937 to 3,793, 226 to 241 mutants. Priced at the
slower files' share of the initial run, that is 59 to 103 seconds of one
worker: 15 to 26 seconds of a sweep, for everything the order does not
explain, a file with no time and a long file whose last run in that worker
was of a few of its tests alike. The mutants of `src/trigger.ts` are 2 to
23 seconds of one worker in it. Running a file with no time first would
move that wait, not end it: each worker that did not make the initial run
would run every long file first, once. With one clock for both sweeps the
wait costs a mutant a turn through the suite and no verdict, and no sweep
could show the difference: the full sweeps under quickest first read 75.5
to 86.1 seconds for each second of their initial runs.

**The five files stay in the full sweep's suite.** No mutant in any report
is covered or killed by a test of theirs. Of the 726 static mutants, under
quickest first, 572 to 579 are killed by the first file they run and one
survives; 65 to 78 run 154 tests or more before the file that kills them,
which is as many as the five files hold. So at most 79 mutants a sweep run
all five. Their
tests take 0.43 seconds in the suite's CI job, 0.33 of them `npm`'s, and a
file a quarter of a second before its first test: at most 33 seconds of a
sweep for all five. Two may leave, by what the five reach under `src/`,
read from a trace of every path each run asks the file system for there:
`names` reads every source as text, `vendor` hashes the vendored copy,
which is how the first hosted full sweep was caught rewriting it, and `npm`
lists the directories. `runner-images` and `release` ask for nothing under
`src/`: 37 tests and 23 milliseconds between them, at most ten seconds of a
sweep.

**The sweeps read for this amendment** that the tables above do not have,
each beside its own initial run. The full sweep's configuration is the same
in all of them.

| Full sweep | Order | Initial run | Timeouts, at the hit limit and at the clock | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: | ---: |
| 38116672624, 998eeb9 | vitest's | 15.8 s | 34 + 6 | 30m11s | 114.5 |
| 38127993060, 9a6b0d0 | quickest first | 17.6 s | 33 + 6 | 23m00s | 78.3 |
| 38128320340, 85e6ae9 | quickest first | 9.8 s | 34 + 5 | 13m35s | 83.5 |
| 38129667388, b7fb20c | quickest first | 15.8 s | 34 + 6 | 21m59s | 83.7 |
| 38136701661, e887422 | quickest first | 16.0 s | 34 + 6 | 22m57s | 86.1 |
| 38139011628, 88ff45c | quickest first | 15.3 s | 34 + 6 | 21m21s | 83.8 |
| 38140522710, e91857e | quickest first | 13.3 s | 34 + 5 | 16m47s | 75.5 |

| Core sweep | Order | Clock | Initial run | Timeouts, at the hit limit and at the clock | Survived | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 38116672624, 998eeb9 | vitest's | 3 s | 10.1 s | 25 + 12 | 30 | 15m55s | 94.5 |
| 38118962074, f5f33a2 | quickest first | 3 s | 9.9 s | 26 + 10 | 29 | 13m56s | 84.1 |
| 38127993060, 9a6b0d0 | quickest first | 3 s | 9.6 s | 25 + 13 | 29 | 13m58s | 87.1 |
| 38128316870, 85e6ae9 | quickest first | 3 s | 9.3 s | 25 + 9 | 30 | 13m01s | 83.7 |
| 38128320340, 85e6ae9 | quickest first | 3 s | 9.7 s | 25 + 9 | 29 | 13m27s | 83.2 |
| 38129482709, 9f9747d | quickest first | 3 s | 9.6 s | 25 + 80 | 29 | 19m06s | 120.0 |
| 38129667388, b7fb20c | quickest first | 3 s | 9.2 s | 25 + 8 | 31 | 13m08s | 85.2 |
| 38136701661, e887422 | quickest first | 3 s | 9.6 s | 25 + 10 | 29 | 13m46s | 85.7 |
| 38139011628, 88ff45c | quickest first | 20 s | 8.8 s | 29 + 3 | 32 | 12m41s | 86.7 |
| 38140522710, e91857e | quickest first | 20 s | 9.3 s | 29 + 3 | 32 | 13m43s | 88.9 |

## Amended 2026-10-12: nothing a mutator reads stands under an `as`

**A score is of the mutants a sweep makes, and Stryker makes none under a
TypeScript `as`.** Read from the source of Stryker 10.0.0: `shouldSkip` in
its instrumenter's `babel-transformer.js` asks `isTypeNode`, whose list
holds `TSAsExpression`, and the whole subtree is passed over. A table
written `{ ... } as const`, the `i - 1` of `lines[i - 1] as string` and the
comparator of `[...found].sort((a, b) => ...)[0] as Brief` were read by no
mutator. No report says so: a mutant that is not made is in no column, and
the score was of the rest. `satisfies` and `!` are not on that list.

**What stood there.** `scripts/mutation-unmeasured.mjs` reads each source as
a sweep's report holds it, with the parser Stryker reads it with, and counts
under every outermost `as` the nodes one of Stryker's mutators has a site
at. A site is a place a mutator applies, not a mutant: each makes one to
three. The last full sweep of main's source is that of e887422 (run
38136701661), whose `src/` is main's; no full sweep has run on main since
the one for 0.8.0. In it, 47 of the 150 `as` expressions had a site under
them, 82 sites in all, and not one of the report's 7,163 mutants stands
inside any of the 47.

| File | Sites | Beside mutants | What stood under an `as` |
| --- | ---: | ---: | --- |
| `config.ts` | 32 | 471 | Every key a configuration, a section and a plugin is read by, as `r['key'] as T` (21); the four status keys the check for a shared word goes through (5); the patterns the check of `files` and `exclude` goes through (6). |
| `cli.ts` | 15 | 717 | The call that asks the argument parser, with all it passes (7); the option a format is read from and its fallback (3); the path and the encoding of the package's manifest (2); a row of the help's formats (2); the last option a refusal lists (1). |
| `corpus.ts` | 6 | 287 | Where a cycle's path starts: the copy, the sort and the whole of its comparator. |
| `report.ts` | 6 | 673 | The colour codes. |
| `rules.ts` | 4 | 810 | The two scope fields three rules go through (3); the section before, in `section-order` (1). |
| `git.ts` | 3 | 189 | The tab of a numstat record; the trim and the separator of a commit's author and date. |
| `lint.ts` | 3 | 119 | Finding a built-in rule by its id. |
| `schedule.ts` | 3 | 331 | The dependency an unplaced brief waits on (2); a pair of patterns turned round for a finding (1). |
| `archive.ts` | 2 | 744 | The reason a scope went unmeasured; the line above a note that disposes of a box. |
| `plugins.ts` | 2 | 374 | A manifest's encoding; the `severity` of a plugin's rule. |
| `schema.ts` | 2 | 337 | Two index reads of the edit distance behind "did you mean". |
| `brief.ts`, `markdown.ts`, `scope.ts`, `text.ts` | 1 each | 235, 123, 80, 155 | The `wave` entry; the line a heading stands on; a pair of patterns that meet; the last item of a list in words. |

**Each was taken out from under its `as`, and none is left there.** The 108
`as` expressions the sources still have hold a name, a call or an index
read, and nothing a mutator applies to.

| Way | `as` | Sites | Where |
| --- | ---: | ---: | --- |
| The cast on a name | 25 | 34 | The 21 keys of `config.ts`, by one cast on each of the three objects they are read from, typed as what the schema has passed; four values hoisted to a constant, in `cli.ts` and `git.ts`. |
| `!` | 11 | 19 | Where the cast only dropped `undefined` from an index read or a `find`. |
| `literal` | 4 | 20 | The tables that took their literal types from `as const`: the colour codes, the scope fields and the two lists `checkConfig` goes through. `literal`, in `src/literal.ts`, is a function with a `const` type parameter that returns its argument, and infers the same readonly literal types. |
| An annotation | 6 | 8 | A declaration's type or an arrow's return type in place of the cast, where it says the same: a pair of strings, what `JSON.parse` returns, a set asked about a value of any type. |
| `satisfies` | 1 | 1 | The reason a scope went unmeasured, held to `Unmeasured`. |
| Left under an `as` | 0 | 0 | |

**The compiler's types are what they were, and so is every answer.** The
build emits every declaration file main's does, byte for byte, 47 with the
vendored spec-core's, and one more, for `literal.ts`. Seven of the emitted
modules differ: a constant a value is hoisted to, a call of `literal`, an
import, and comments. Through the built
launcher of main and of the branch, 153 command lines in five scratch trees
gave the same exit code and the same bytes on stdout and on stderr, and the
sixteen that write left the same files: every command in each format it
writes, the refusals of 0.7.0 and 0.8.0, a configuration that sets every
key and names two plugins, sixteen configurations that do not load, and a
repository with a round to archive.

**What the sweeps read.** Main's source is the full sweep of e887422 and
main's own core sweep; the rewrite is 7bf8ff7; the last row of each is
2c07e60, which adds the two tests below.

| Sweep | Run, commit | Mutants | Killed | Timed out | Survived | No coverage | Score | Static |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full, main's source | 38136701661, e887422 | 7,163 | 7,076 | 40 | 44 | 3 | 99.34% | 726 |
| Full, the rewrite | 38159283061, 7bf8ff7 | 7,250 | 7,159 | 39 | 49 | 3 | 99.28% | 738 |
| Full, with two tests | 38160965717, 2c07e60 | 7,250 | 7,161 | 39 | 47 | 3 | 99.31% | 738 |
| Core, main | 38142281754, faa9cf6 | 5,289 | 5,222 | 32 | 32 | 3 | 99.34% | 586 |
| Core, the rewrite | 38159283061, 7bf8ff7 | 5,356 | 5,286 | 32 | 35 | 3 | 99.29% | 596 |
| Core, with two tests | 38160965717, 2c07e60 | 5,356 | 5,288 | 32 | 33 | 3 | 99.33% | 596 |

The full sweep makes 87 mutants more: 86 at the 82 sites, and the body of
`literal`. The core sweep makes 67 more: 66 at the 62 sites its modules
had, and that body. Set beside the sweep of main's source mutant for
mutant, 7,079 of the full sweep's are the same mutant with the same
verdict, 83 were made again with the text of a line the rewrite changed
and are killed as they were, and one changed sides: `stack.push(v)` taken out in `src/corpus.ts`, which is
killed or ends at the hit limit by which of its tests runs first (amended
2026-10-11, above). The core sweep reads main's verdict for every mutant
main's core sweep made, 63 of them made again.

**What the new mutants found.** Written into the source by hand, one at a
time, 82 of the 87 failed a test that was already there and five failed
none; the first sweep, run beside that replay, left the same five. Two
were behaviours no test held:

- **A configuration's `placeholders` could be dropped.** With the key read
  as `r['']` every test passed: one test gives the key the default list,
  and none a list of its own. A repository that marks unwritten work
  with a word of its own is now a test, for a section and for a deferral's
  trigger, with the default words no placeholders there.
- **Where a cycle's path starts was held by half of its comparator.** A
  comparator that answers "before" for every pair reads a component
  backwards, which starts at the brief the search came into the cycle by.
  Briefs are searched in the order of their paths, so in every cycle the
  tests had, that brief was the first by path as well: the test named for
  "whatever order the search visits them in" hands its files over in
  another order, and `buildCorpus` sorts them before any search. A cycle
  the search comes into from a brief outside it is now a test.

Three are equivalent, and say so beside the code: the same comparator with
`<=`, between two briefs that are never one file, as the sort of the corpus
already has it; and the encoding named for each of the two manifests handed
to `JSON.parse`, the package's own in `src/cli.ts` and a plugin package's
in `src/plugins.ts`, since `JSON.parse` reads a file's bytes as it reads
their text in UTF-8. The full sweep's survivors are main's 44 and those
three; the core's are main's 32 and the comparator's.

**What the rewrite made static, and what that costs.** A table built when
its module loads is static to Stryker, as the amendment of 2026-09-26 says,
and twelve of the 87 are: the six of the colour codes, the three of the
scope fields, two in a row of the help's formats, which `HELP` builds as
`src/cli.ts` loads, and the body of `literal`, which those tables call
then. The colour codes are a table by their type: `paint` takes
`keyof typeof CODES`, and a function in the table's place would change a
declaration this change leaves byte for byte. The scope fields could be a
function, as the rule in `src/cli.ts` is, and it would gain nothing: every
lint of a brief reads them, so nearly every test would cover it, and its
mutants would run the files a static mutant runs. In the two full sweeps
the twelve ran 387 and 91 tests, of the 76,524 and 84,472 their sweeps'
mutants ran: the eleven in tables 5 to 15 each, and the body of `literal`
305 and 9, by how many files its worker ran ahead of the first to resolve
a configuration. Two sweeps differ by more than that with nothing between
them: those two, of one source and the same 7,250 mutants, are 7,948 tests
apart.

| Sweep | Run | Initial run | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: |
| Full, main's source | 38136701661 | 16.0 s | 22m57s | 86.1 |
| Full, the rewrite | 38159283061 | 10.3 s | 15m19s | 89.2 |
| Full, with two tests | 38160965717 | 12.3 s | 16m54s | 82.4 |
| Core, main | 38142281754 | 9.1 s | 12m56s | 85.2 |
| Core, the rewrite | 38159283061 | 9.7 s | 14m12s | 87.8 |
| Core, with two tests | 38160965717 | 7.3 s | 10m17s | 85.0 |

Beside its own initial run the full sweep read 89.2 and then 82.4, where
the eight full sweeps under quickest first before it read 75.5 to 86.1;
the core read 87.8 and then 85.0, where the three with the full sweep's
clock read 85.2 to 88.9. The mutants are 1.2% more, and two sweeps of one
source are further apart than that: the rewrite does not show in the
minutes.

**Held from here on.** `scripts/mutation-unmeasured.mjs` records the sites
that may stay under an `as`, by file, and records none. The mutation
workflow runs it after each sweep on the report that sweep wrote, and a
file with more sites than its record, or fewer, fails the job with each
place listed; an `as` the report does have a mutant inside counts as
measured, so a Stryker that comes to mutate there fails nothing.
`tests/mutation-unmeasured.test.ts` holds the count to a source small
enough to count by hand and this repository's sources to none, so a pull
request that puts a site under an `as` fails before any sweep; it reads
the sources as text, which in a sweep's sandbox is Stryker's copy, and is
in neither sweep's suite. The script needs `@babel/parser`, which Stryker
brings and this package does not ask for: a copy pinned here could read a
source otherwise than the sweep did, and where it is not installed the
script says so and exits 2.

The gates stay at 97: with every timeout lost the two sweeps read 98.77%
and 98.73%.

Seen on the way, and left:

- The count is of sites, by the script's own reading of Stryker's mutators:
  an estimate, 82 for the 86 mutants the sweep then made there. What it
  holds is that the number is none.
- Stryker passes over an `enum` declaration as it does an `as`. No source
  here declares one, and the script does not look for one.
- `inWords` in `src/text.ts` has no test in `tests/text.test.ts`: its
  mutants, the one of its last item among them, are killed by the tests of
  the messages it words, a configuration's refusal first, and by no test
  of its own module.
- The test named for the order the search visits a cycle in, above, says
  more than it does. It still fails a path that starts at the last brief
  the search reached.

## Amended 2026-10-12: a file that does not load fails no test

**A sweep counts a test that failed, and a test file that did not load has
none.** Read from the source of Stryker 10.0.0's vitest runner: `run` in its
`vitest-test-runner.js` goes through the tests vitest collected, and a run
has failed where one of them has. A module that throws as it loads takes
with it every test file that imports it. None of their tests exists, none
fails, and where no test of another file fails either, the mutant is scored
as survived although nothing works. spec-harness's full sweep for its 0.15.0
counted one so, the body of its `literal()` emptied
([its ADR-0010](https://github.com/DescentVTT/spec-harness/blob/main/docs/adr/0010-toolchain-and-verification.md)).
The same was asked here, of every mutant it can be asked of.

**It can be asked of a static mutant only.** The runner's `stryker-setup.js`
puts a mutant Stryker calls static in force as each test file starts, and
any other in a `beforeAll`, when the file's imports have run. A module that
a test imports inside its own body loads after that, and what it throws is
that test's failure. The static mutants are 738 of the full sweep's 7,250
and 596 of the core's 5,356: the same 596, and the 142 of `src/cli.ts`,
`src/fs.ts` and `src/plugins.ts`.

**No survivor is a file that did not load.** The newest sweeps were those of
run 38160965717, of 2c07e60, whose `src/` and `tests/` are main's, and
main's own core sweep of fd66edd (run 38163494908), which reads another
verdict for one mutant, `stack.push(v)` of `src/corpus.ts` (amended
2026-10-11, above).

| Sweep | Static mutants | Killed | Survived | The survivors, written by hand: a test fails | a file does not load | nothing happens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full, 38160965717 | 738 | 737 | 1 | 0 | 0 | 1 |
| Core, 38160965717 and 38163494908 | 596 | 595 | 1 | 0 | 0 | 1 |

The one is the same mutant in all three: the anchor of `NOTE_START` in
`src/archive.ts`, equivalent by the comment beside it. It was written into
the source all the same. Every file of both suites loads and no test fails:
997 tests in the full sweep's 29 files and 665 in the unit suite's 21, as a
Windows workstation runs them.

**Twelve static mutants do stop a module loading, and each is killed by a
test of a file that still loads.** A mutant that is killed can be one under
which files do not load, and its kill then holds for as long as the file
that kills it stays clear of the module. Each of the 738 was written into a
copy of the sources, where Node imported every module in a process of its
own. Under twelve a module throws as it loads, and each of the twelve was
then run against the suites by hand:

| Mutants | What throws as it loads | Test files that do not load | Tests that fail |
| --- | --- | --- | --- |
| Eleven of `src/cli.ts`: each of the table's eight commands emptied, and three expressions of `formatsHelp` | `src/cli.ts`, where `HELP` is built from the table | Two of the full suite's 30, `cli` and `report`, with 144 tests | One, of the 855 that run |
| One of `src/config.ts`: `DEFAULT_CONFIG` emptied | `src/scaffold.ts`, which reads its sections | Six of the full suite's 30, `cli`, `dialects`, `edges`, `engine`, `regressions` and `report`; of the unit suite's 22, the four of those it has | 227 in ten files, of the 675 that run in the full suite and of the 512 in the unit suite |

The eleven hang on one test. `tests/catalogue.test.ts` has imported the CLI
inside a test's body since 2026-09-30, with the reason beside it, and that
test is the one that fails, by hand and in the sweep, which names it for
each of the eleven. Without it the 112 tests of `tests/cli.test.ts` would
not run under these mutants and each would be scored as survived. The
twelfth is killed by the tests of its own module: `tests/config.test.ts`
loads no `scaffold.ts`.

**The body of `literal` emptied stops no module loading, as the sources
stand.** `literal` (`src/literal.ts`; amended 2026-10-12, above) is the
function three modules build their tables through, and with its body
emptied each of those tables is nothing. Two are built as their modules
load, the colour codes and the scope fields, and every one is read inside a
function. So each module loads, and the tests that reach a table fail: 270
of the 997 in 14 of the full suite's files, 184 of the 665 in 12 of the
unit suite's. The sweep killed the mutant by a test that resolves a
configuration, the first to fail in the order of the worker that drew it:
one of `tests/edges.test.ts` in the full sweep, the ninth test of that run,
and one of `tests/dialects.test.ts` in the core, the thirty-seventh.

Both files import the modules that build the tables, and neither would load
under the mutant once one of those modules read a table as it loads. That
is one line, and it was written by hand beside the emptied body, into two
modules in turn:

| A table read as this module loads | Suite | Test files that do not load | Tests that fail | in `tests/literal.test.ts` | in any other file |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/rules.ts` | Full | 14 of 30 | 8 | 2 | 6, of `tests/config.test.ts` |
| | Core | 12 of 22 | 8 | 2 | 6, of `tests/config.test.ts` |
| `src/config.ts` | Full | 18 of 30 | 2 | 2 | 0 |
| | Core | 14 of 22 | 2 | 2 | 0 |

Every test file that reaches the function reaches `src/config.ts`. With a
table read as that module loads none of them loads, and the files that do
load reach no table: the two tests that fail are those of the file below,
and without it the function emptied is scored as survived, which is
spec-harness's case. The lines alone, with `literal` as it stands, fail
nothing.

**`tests/literal.test.ts` loads the function alone.** It imports `literal`
and nothing else under `src/`, so it loads whatever the modules that call
the function do as they load, and its failure is a test's: with the body
emptied both of its tests fail, in either suite, and in the last two rows
above they are the only tests that do. It reads no disk and starts no
process, and both suites run it, since both sweeps make the mutant. Its
second test holds the types the function is for, by the compiler: with a
type parameter that is not `const`, `npm run lint` fails there, as it does
in the two modules that index by a table's literal types.

No sweep can say that the file stopped being the one that loads alone, so
`tests/source.test.ts` holds it: the file imports the function and nothing
else of this repository, `src/literal.ts` imports nothing, and each sweep
runs the one and mutates the other. Seven changes made by hand each fail
it: an import in the test file, written either way, an import in
`literal.ts`, the file in either suite's `exclude`, and the module left out
of either sweep's `mutate`.

**What the sweeps read.** Run 38192433556, of 3952188, beside the sweeps
before it.

| Sweep | Run, commit | Mutants | Killed | Timed out | Survived | No coverage | Score | Static | Test files | Initial run | Sweep | Sweep / initial run |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full, before | 38160965717, 2c07e60 | 7,250 | 7,161 | 39 | 47 | 3 | 99.31% | 738 | 29 | 12.3 s | 16m54s | 82.4 |
| Full, with the test | 38192433556, 3952188 | 7,250 | 7,160 | 40 | 47 | 3 | 99.31% | 738 | 30 | 15.6 s | 21m50s | 84.1 |
| Core, before | 38160965717, 2c07e60 | 5,356 | 5,288 | 32 | 33 | 3 | 99.33% | 596 | 21 | 7.3 s | 10m17s | 85.0 |
| Core, main | 38163494908, fd66edd | 5,356 | 5,289 | 31 | 33 | 3 | 99.33% | 596 | 21 | 6.5 s | 9m08s | 83.9 |
| Core, with the test | 38192433556, 3952188 | 5,356 | 5,288 | 32 | 33 | 3 | 99.33% | 596 | 22 | 9.9 s | 14m36s | 88.8 |

No source changed, and the mutants are the same 7,250 and 5,356. Set beside
the sweep before it mutant for mutant, the full sweep reads the same
verdict for 7,249: the one that changed sides is `stack.push(v)` of
`src/corpus.ts` again, killed there and at the hit limit here. The core
sweep reads that run's verdict for all 5,356. The survivors are the same 47
and 33, with the same three without coverage, and the one static survivor
is the anchor of `NOTE_START`. The initial runs count two tests more, 1,004
and 667.

The body of `literal` is killed in both, and in both the two new tests are
among those that cover it. In the full sweep `tests/literal.test.ts` killed
it, the sixth test of its run. In the core sweep `tests/dialects.test.ts`
did again, the thirty-seventh: a worker that has not timed a file runs it
after those it has (amended 2026-10-11, above), and this file's tests cover
no other mutant, so few workers have. With every timeout lost the sweeps
read 98.76% and 98.73%. The gates stay at 97.

Seen on the way, and left:

- The eleven mutants of `src/cli.ts` hang on where one test file imports
  the CLI, and no test holds `tests/catalogue.test.ts` to it as
  `tests/source.test.ts` now holds `tests/literal.test.ts`. An import of the
  module at the top of that file would show as eleven survivors in the next
  full sweep, and not before.
- The twelve were found by loading the modules, not the test files. A test
  file that calls into a module while vitest collects it can throw there
  under a static mutant with every module loaded. No survivor is one, since
  the only static survivor fails nothing; among the killed it was not
  looked for.

## Amended 2026-10-14: a change is swept before it merges

**Until now no sweep ran on a pull request.** Read from the workflow and the
two configurations at 146d5b0, with what each sweep mutates taken from the
reports of main's own sweeps of that commit (run 38237119766):

| Sweep | Mutates | Against | A pull request | A push to main | Monday | A dispatch | A release |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core | 21 modules | the unit suite, 22 files | no | yes | yes | yes | no |
| Full | those and the five edges, 26 | the whole suite, 30 files | no | no | yes | with `full` ticked, which was not its default | no |

Twenty-eight files under `src/` are this repository's own, so two were in
neither list. `types.ts` declares types alone. `index.ts` was left out as
re-exports, by a comment in the configuration, and declares `definePlugin`:
asked as a library, the instrumenter of the Stryker installed makes one
mutant of the file, that function's body emptied, and none of `types.ts`.

What that left, in the 60 pull requests merged from 2026-09-26 to
2026-10-12: every one merged with no sweep having read it. After the merge
the core sweep read the 21. The edges, which 12 of the 60 changed, were
read when someone dispatched the workflow, 29 of its 98 runs and 19 of
those on a branch, or on a Monday, three of them. And each of the six
releases from 0.5.0 to
0.8.0 was tagged on a commit of which the core sweep alone had run: the
full sweep recorded for 0.8.0 is of the commit before, dispatched by hand,
and the tagged commit differs from it in `src/cli.ts`, by the two comments
that call a mutant equivalent.

**Both sweeps now run for every pull request and for every push to main**,
whatever either changes, beside Monday's run and a dispatch, whose `full`
is now ticked unless someone unticks it. Both mutate `index.ts`: 27 files
for the full sweep and 22 for the core, with one mutant more in each, which
`tests/report.test.ts` kills in the unit suite.

**The whole of both, and no split by path.** spec-harness sweeps a pull
request in full only where it changes a module its core sweep does not
reach
([its ADR-0010](https://github.com/DescentVTT/spec-harness/blob/main/docs/adr/0010-toolchain-and-verification.md),
amended 2026-10-12), where a full sweep is nine jobs and two hours of
runners. Here the minutes say otherwise. Each job from its start to its
end, the install and the upload with the sweep, over the last five that
passed:

| Job | The five | Median | Runs |
| --- | --- | ---: | --- |
| `core` | 9m19s to 14m53s | 14m01s | 38237119766, 38197575644, 38196507833, 38192433556, 38163494908 |
| `full` | 15m13s to 22m02s | 17m02s | 38237119766, 38192433556, 38160965717, 38159283061, 38140522710 |

The two run side by side, so a pull request waits for the longer. In the
four of those runs that started both at once, the full job ended 1m07s to
7m09s after the core job, and the two took 28 to 37 minutes of runners
between them. A minute to seven is all a split would give back to a pull
request that changes no edge. By the 60 merged it would have swept 22 in
full, the 12 and ten that changed only what the sweeps are made of; left to
the core sweep nine that changed a pure module, which the tests of the
edges run every line of; and left to it 24 that changed tests, the vendored
spec-core, the manifest or the lockfile and no source of this repository,
each of which can move a verdict of the full sweep. The pull request that
took vitest to 5, under which a sweep reads 4% (amended 2026-10-07, above),
changed `package.json` and the lockfile and passed every check it had. Five
of the 60 changed documents, another workflow or Dependabot's configuration
alone, and are now swept for nothing. The price of the split is a list of
paths that has to be kept true, and checks that could never be required,
below.

The suite's own CI took 1m03s to 6m30s for the last five pull requests'
runs that passed, a median of 1m05s, and 1m31s over the 38 listed. So a
pull request has 15 checks where it had 13, and has its last one about 17
minutes after a push where it had it after one or two. From 2026-09-23 to
2026-10-12 CI ran 79 times for a pull request and 66 times for a push to
main: at most 145 runs of the two jobs, fewer by each a newer push ended,
where the workflow ran 98 times.

What GitHub does with the workflow, from its documentation as read on
2026-10-14:

- *Workflow syntax for GitHub Actions*, under
  `on.<push|pull_request|pull_request_target>.<paths|paths-ignore>`, and
  *Troubleshooting required status checks*, under *Handling skipped but
  required checks*: a check of a workflow that a filter of paths or
  branches, or a commit message, skipped stays pending, and a pull request
  that requires it cannot merge; a job that a condition skips reports
  success. What follows: with no filter on either event, `core` and `full`
  can be required of a pull request, which a split by path could not be.
  Main's ruleset requires no check today, so what holds a merge until the
  sweeps end is whoever merges. The second page, under *Checks from some
  workflow jobs are not evaluated*: the checks of a run that a dispatch
  started on a pull request's branch are not among the pull request's
  checks and satisfy no required one. So the dispatches by hand, above,
  were never a check of the pull request they were for.
- *Events that trigger workflows*, under `pull_request`: the commit a run
  checks out is the pull request's merge into its base, its ref is
  `refs/pull/<number>/merge`, and no workflow runs while the pull request
  has a merge conflict. So a sweep is of what main would be, and a pull
  request in conflict is not swept until it is mended. The same section: a
  pull request from a fork, and one of Dependabot's, has a token that can
  only read.
- *Workflow syntax*, under `concurrency`: one run of a group at a time, and
  with `cancel-in-progress` a new run ends the one in progress. *Reusing
  workflow configurations*, under *`github` context* and *Supported
  keywords for jobs that call a reusable workflow*: a called workflow has
  its caller's `github` context, and its caller's name in
  `github.workflow`. So the group is the workflow's name, the ref and the
  event: a newer push to a pull request ends the sweep of the push before
  it and no other run's, and a release's sweep is in a group of its own.
- *Workflow syntax*, under `permissions`: a job that names a permission has
  none it does not name, and a pull request from a fork may be given a
  permission to read. *Permissions required for GitHub Apps*, under
  *Repository permissions for "Actions"*: listing a workflow's runs and
  downloading an artifact each take read access to Actions. That page has
  it for a private repository and leaves a public one to each endpoint's
  own page, and *REST API endpoints for GitHub Actions artifacts*, under
  *Download an artifact*, names no way without. So each of the two jobs
  names `contents: read` and `actions: read`, and no other.
- *Reusing workflow configurations*, under *Supported keywords for jobs
  that call a reusable workflow*: a called workflow can lower what its
  caller's job hands it and cannot raise it. So the job of `release.yml`
  that calls the sweeps names the same two.
- *Store and share data with workflow artifacts*, under *Configuring a
  custom artifact retention period*: an upload's `retention-days` cannot
  pass the limit of its repository or organisation. Asked of the API, this
  repository keeps an artifact fourteen days and may keep it no longer, and
  every report listed expires fourteen days after its run. A sweep for
  every push to main, and one each Monday, leave a report of main inside
  that.
- *Using GitHub CLI in workflows*: the CLI is on every hosted runner and
  takes its token from `GH_TOKEN`, which the one step sets. *Workflow
  commands for GitHub Actions*, under *Step isolation and limits*: a
  step's summary may hold 1 MiB, and one that passes it is not uploaded.
  The comparison lists 150 rows there and every row in the log.
- *GitHub Actions billing*: standard hosted runners are free for a public
  repository, which this is. *Actions limits*, under *Job concurrency
  limits for GitHub-hosted runners*: an account on the Free plan runs 20
  jobs at once, five of them on macOS. What follows: the sweeps cost no
  money and do cost places in that queue, which the family's five
  repositories share.

**Each sweep names the undetected mutants that are new.** A score does not:
50 undetected of 7,250 read 99.31%, 52 would read 99.28%, and both pass a
`break` of 97. Until now a sweep's survivors were set beside main's by
hand, release by release, which is where every "no survivor is new" above
comes from. `scripts/mutation-compare.mjs` does it in the job that has the
report: it asks GitHub for main's newest run of this workflow that passed
and still has the artifact, a sweep of main itself by a push, the schedule
or a dispatch, and lists what this sweep leaves undetected, survived or
reached by no test, that the other did not. A mutant is its file, its
mutator, the text it replaces and what replaces it, never its line;
mutants the same in all four are told apart by how many there are. The
list goes to the job's summary and to its log, with the files only one of
the two sweeps mutated, and fails the job for none of it: a new survivor
may be equivalent, and is then said so beside its code, and the `break`
still gates the score. Where there is no report to fetch it says that
nothing was compared, as a warning, and never that none is new. The core
sweep's job does the same against main's core report, so a mutant that
only a test outside the unit suite kills is named too.

Run by hand on reports kept from the sweeps above, it reads what those
amendments record:

| Main's report | This sweep's | New | Gone | What they are |
| --- | --- | ---: | ---: | --- |
| Full, 38136701661, e887422 | Full, 38159283061, 7bf8ff7 | 5 | 0 | The five the rewrite left: `'placeholders'`, the comparator held true and with `<=`, and `'utf8'` twice. |
| Full, 38159283061, 7bf8ff7 | Full, 38160965717, 2c07e60 | 0 | 2 | The two the two tests kill. |
| Full, 38128320340, 85e6ae9 | Full, 38136701661, e887422 | 0 | 2 | The `default` of each of the two switches, one row at two lines. |
| Full, 38192433556, 3952188 | Full, 38237119766, 146d5b0 | 0 | 0 | One source, swept twice. |
| Core, 38163494908, fd66edd | Core, 38197575644, 146d5b0 | 0 | 0 | The same. |
| Full, 38237119766 | Core, 38237119766 | 3 | 17 | The three that only tests outside the unit suite kill, and the edges' 17. |

What a list can hold that the change did not make: a mutant whose own text
was edited, which is another mutant; one of anything main took after the
commit its report is of; and a verdict that differs between two sweeps of
one source, as `stack.push(v)` of `src/corpus.ts` does, though between
killed and timed out, which are both detected and on no list. The pull
request says which each is (`CONTRIBUTING.md`).

**A release sweeps the commit it publishes.** `release.yml` calls this
workflow as it calls CI, and for the same reason: main's sweep is ended
when a newer push arrives, and a tag can be pushed before it has finished.
`pack` waits for both, so nothing is packed, staged or released from a
commit either sweep has failed. A tag can still be pushed on any commit of
main; what it cannot do is publish one unswept. That is about seventeen
minutes more for a release, and for a rehearsal, which runs them too
([ADR-0010](0010-releases-are-published-by-ci.md), amended 2026-10-14).

**The arrangement is held to the sources.** `tests/mutation-sweeps.test.ts`
asks the instrumenter of each file the full sweep's list leaves out, and
fails one of which it makes a mutant; holds what the core sweep leaves out
to the five edges; and holds the workflow to both events with no filter, to
one condition, the dispatch's, and to the release's call. A module added to
`src/` is mutated by both sweeps with nothing written, since both lists are
patterns, and a list that comes to leave one out fails the suite. Thirty-
seven changes made by hand to the workflows and the four configurations
each fail it or the tests of the comparison.

**The count of what stands under an `as` is held to the Stryker
installed.** The count was the script's own reading of Stryker's mutators,
"an estimate" above. It is now set beside the instrumenter: over a source
written with every kind of site, Stryker makes no mutant under a cast, and
with the casts taken away it mutates exactly the places counted, 60 of them
in 13 expressions, and so for 19 sources more, each for something Stryker
leaves alone. That moved one rule: a choice between two values is no site
of its own, since Stryker holds its test true or false at the comparison.
The report of e887422, which read 82 sites under 47 expressions, reads 81
under the same 47. An `enum` is counted as an `as` is, a source Stryker's
parser refuses is refused by name where it had been recovered from and
counted, and the parser is the one Stryker's own `@babel/core` resolves.

**The eleven static mutants of `src/cli.ts` cost seconds, and are left.**
They "hang on" one test in the sense of the amendment above: it is the one
that kills them. None runs out a clock. In each of the last five full
sweeps all eleven are killed by that test of `tests/catalogue.test.ts`,
after 15 to 575 of the suite's thousand tests, 1,890 to 2,962 tests
between them: two to three runs' worth of a suite that one worker runs in
ten to sixteen seconds. No static mutant timed out in any of the five, and
the clock's five or six are the ones the amendment of 2026-10-11 names.
There is nothing to mend.

**What the sweeps of this change read.** Run 38453488907, of the pull
request's merge into 146d5b0, beside main's own sweeps of that commit (run
38237119766):

| Sweep | Run | Files | Mutants | Killed | Timed out | Survived | No coverage | Score | Static | Job |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full, main | 38237119766 | 26 | 7,250 | 7,161 | 39 | 47 | 3 | 99.31% | 738 | 15m13s |
| Full, this change | 38453488907 | 27 | 7,251 | 7,161 | 40 | 47 | 3 | 99.31% | 738 | 21m41s |
| Core, main | 38237119766 | 21 | 5,356 | 5,288 | 32 | 33 | 3 | 99.33% | 596 | 14m01s |
| Core, this change | 38453488907 | 22 | 5,357 | 5,289 | 32 | 33 | 3 | 99.33% | 596 | 14m24s |

Each sweep makes one mutant more, the body of `definePlugin`, and kills it
by the one test that covers it, of `tests/report.test.ts`, the first it
runs. No test joined either suite: the initial runs count 1,004 tests and
667, as before. Each job's comparison fetched main's report, said that
`src/index.ts` is mutated here and not there, and listed nothing new and
nothing gone. In the full sweep `stack.push(v)` of `src/corpus.ts` changed
sides once more, killed in main's and timed out here, which is on neither
list. The full sweep drew a runner at the slow end, 16 seconds for its
initial run, and the pull request had the last check of the two 21m46s
after the push. The suite's three macOS jobs started ten minutes after
the push; what else the account's macOS runners were doing then was not
read.

**The call the release makes was tried once, and the release was not
run.** A workflow of the release's shape, calling this one from a job that
names the same two permissions, ran on the pull request (run 38453489165)
and was taken out again. GitHub took the call; both sweeps ran and read
the counts above; each fetched main's report with the permission handed
down; the job after them started four seconds after the second ended; and
the pull request's own sweeps, in another group by the workflow's name,
ran beside them to their end. What it could not try is a tag, and a
rehearsal: under a rehearsal the full sweep's condition reads the called
workflow's own `full`, which is ticked by its default.

Seen on the way, and left:

- Main's ruleset requires no check. Requiring `core` and `full` there would
  make "swept before it merges" something GitHub holds; it is a setting of
  the repository, and was not changed.
- `briefs/002_a-mutation-gate-on-pull-requests.md` has as an invariant that
  a pull request which changes no source file runs no sweep. This change
  does the opposite, for the pull request above that changed none and moved
  every verdict. The brief is as it was written.
- Monday's run started at 10:15 and 10:33 UTC on its last two Mondays,
  where its schedule says 03:00, and in the second the full job started 33
  minutes after that.
- spec-core's ADR-0008 says of this repository's dispatch that `full` is
  not its default. It is now.
- A report expires fourteen days after its run, which a longer
  `retention-days` cannot change here. Two Mondays without a sweep of main
  that passes, and no push, would leave a pull request's comparison with
  nothing to compare with, and it would say so.
