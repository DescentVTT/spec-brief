# CLAUDE.md

Working agreements for this repository. Short on purpose: the ADRs in
`docs/adr/` carry the reasoning, and `CONTRIBUTING.md` carries the map.

## Invariants

These are not preferences. Breaking one is a decision that needs an ADR.

- **Zero runtime dependencies.** `dependencies` is empty and every import in
  `src/` is relative or `node:`. `tests/source.test.ts` holds both
  ([ADR-0001](docs/adr/0001-no-runtime-dependencies.md)).
- **The brief is the record.** No status file, no manifest, no generated
  index committed to the tree, no git writes
  ([ADR-0002](docs/adr/0002-the-brief-is-the-record.md),
  [ADR-0004](docs/adr/0004-archival-is-a-planned-transaction.md)).
- **I/O stays at the edges.** `cli.ts`, `engine.ts`, `fs.ts`, `git.ts` and
  `plugins.ts` meet the disk, git or the process. Everything else is a pure
  function of its arguments. `tests/source.test.ts` holds that list.
- **Nothing takes longer than its input.** No user-supplied pattern compiles
  to a `RegExp`; globs are matched and intersected by dynamic programming
  ([ADR-0005](docs/adr/0005-scopes-collide-by-intersection.md)). Every loop
  ends by construction.
- **A run that cannot be trusted exits 2.** A configuration that does not
  load, an unknown key or rule, a briefs directory that does not exist. Never
  fall back to defaults and report clean.
- **Native ESM, TypeScript 7, Node >= 22.** `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`.
- **LF line endings, no control characters.** Held by a test. Write escapes
  for anything invisible; the files are read by people and by diff tools.
- **Releases come from a tag, through CI.** Never `npm publish` from a
  workstation; the release workflow publishes with provenance
  ([ADR-0010](docs/adr/0010-releases-are-published-by-ci.md)).

## Verification

All of these pass before anything is called done.

```bash
npm run lint            # tsc --noEmit
npm test                # vitest
npm run build
npm run selfcheck       # spec-brief lints this repository's own briefs
npm run test:mutation   # the core sweep: pure modules against the unit suite
```

`npm run test:mutation:full` mutates the edges too, against the whole suite;
it spawns git for every CLI mutant and runs weekly in CI rather than per
change. See [ADR-0009](docs/adr/0009-mutation-testing.md) for both, and for
why a unit test that belongs in the core suite must not read the disk or
spawn a process: under per-test coverage, one that does is run for every
mutant it reaches.

The coverage floors in `vitest.config.ts` and the mutation `break` in
`stryker.core.config.mjs` sit below the last measurement. They move up with the
measurement and never down to make a change pass.

## Design rules

- **False positives cost more than misses.** When the evidence is ambiguous,
  stay quiet or lower the severity. A collision report that cries wolf is
  switched off.
- **One defect is one finding.** A protected file changed is reported as
  protected, not again as out of scope; a self-dependency by `dependency`, not
  again by `dependency-cycle`.
- **A finding names the place to fix and the next action.** Every refusal has
  a hint.
- **Prefer configuration to code** for anything two repositories do
  differently ([ADR-0003](docs/adr/0003-conventions-are-configuration.md)).

## Testing

New behaviour needs a test that fails without it, and a heuristic needs a test
for the case that must not match. Assert decisions, not shapes. A test that
writes to disk writes under the system temporary directory, in a path named
for its process (`tests/helpers.ts`), because Stryker runs a file in several
workers at once. Parsing code is checked against something outside itself: the
glob intersection against brute-force enumeration, the archival against its
own reverse.

## Prose

Comments explain why, never what. No exclamation marks, no hedging. The same
for diagnostics and commit bodies.
