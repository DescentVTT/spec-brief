# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org).

## Unreleased

- Globs are spec-core's `path` dialect, matched and intersected by its
  automaton, which is copied into `src/vendor/spec-core/` and verified by
  hash. The syntax is unchanged; what it means changes in four places.
  - **A literal path is read from the tree.** A file the tree holds is that
    file, a directory it holds is everything beneath it, and a path it does
    not hold is a file unless written with a trailing `/`. The extension
    guess is gone: it read `Dockerfile` as a directory, so `Dockerfile` and
    `**/x.ts` collided through `Dockerfile/x.ts`, and read `docs/v1.2` as a
    file, missing every collision inside it. Without a tree - the library
    called with no files - every literal is a file.
  - **A trailing `/**` or `/` is a directory's contents**, at least one name
    below it: `src/**` no longer matches `src`, and a collision witness is
    always a file, `docs/adr/x` where it was `docs/adr`.
  - **`./` alone, and a `..` segment, are refused in the core's words**
    ("the pattern names the root itself", "a pattern cannot climb out of its
    root"), and a lone `}` is a literal rather than an error. A leading `/`
    and a leading `!` are refused as before.
  - **Protection wins.** What a brief may write is `affectedFiles` less
    `protectedFiles`, so `affectedFiles: [src/**]` with
    `protectedFiles: [src/db/schema.ts]` is valid. `scope-contradiction` now
    fires only for affected patterns the protections cover entirely, as one
    finding per brief naming each; it used to fire for any file in both.
    `matrix` leaves out a file either brief of a pair protects.
- `literal-read-as-file`, a note: a path with no glob syntax that the tree
  does not hold and whose name has no extension, such as `src/newmod`, is
  read as a file, and the hint says to write `src/newmod/` for a directory.
  `glob-matches-nothing` leaves such a pattern to it.
- `collision-undecided`, a warning: a pair of briefs whose collision the
  witness search could not decide within its budget. It is never reported
  as a collision and never as clean. `matrix` marks the pair `?`, and its
  JSON gains an `undecided` list per wave (`{ a, b, patterns }`).
- Deferred work has a status: `status.deferred` in configuration, `"deferred"`
  by default and `null` for a repository without one. A deferred brief lives
  in the briefs directory, is never ready, is listed and left out by
  `matrix`, and is refused by `archive` as `archive-deferred`. It names the
  event that brings it back in `trigger`, a new built-in field that `list`
  reports.
- `deferral-trigger`, an error: a deferred brief with no `trigger`, or one
  that is only a date or a time - `2026-10`, `Q3`, `next month`, `October`,
  `in two weeks` - or a placeholder. "when the second tenant signs" and
  "when p95 > 200 ms" pass.
- `spec-brief schedule` computes the waves the live briefs can run in
  (ADR-0011): dependency order, ties by id, each brief in the lowest wave
  after its live dependencies that holds nothing it collides with, a brief
  with no scope in a wave of its own. Each brief's proposed wave is shown
  beside its declared one with the reason for a move - the dependency, or the
  brief and the file that kept it out of a wave - and deferred briefs, the
  briefs waiting on them, and dependency cycles are listed. `--write` sets
  `wave` in the front matter of each brief that moves, every other line
  untouched, as one transaction, and writes nothing over a cycle. Exit 0 when
  the declared waves hold, 1 when they would change or on a cycle. Pretty,
  JSON, SARIF and GitHub output; `wave-schedule`, an error by default, is the
  finding per move.
- A plugin may export a `waive` hook beside its rules (ADR-0007, amended).
  After an archival is planned, and only when it has a refusal a plugin may
  lift, each hook is given `{ root, brief: { id, file, text }, findings,
  base, commit }` and answers `[{ rule, path, reason }]`. A `protected-file`
  or `out-of-scope` refusal it names by rule and path becomes a `waived`
  note; a waiver for any other rule is ignored with a `waiver-ignored`
  warning. A hook that throws or answers in another shape stops the run
  with exit 2. This is how spec-harness's plugin lets a signed ruling allow
  a protected file, without spec-brief reading signatures.
- A `protected-file` refusal names its file in a new `path` field, one
  finding per file as before, and an `out-of-scope` finding lists its files
  in `paths`. Both appear in the JSON of `archive`; a plugin reads them.
- 24 lint rules and 5 collision rules.
- The library's `parseGlob`, `matchGlob`, `intersectGlobs` and `globBase`
  keep their signatures over the new engine. `parseGlob`'s `isFile` option is
  replaced by `literal` (`'file'`, `'directory'`, `'either'` or a function,
  such as `readingIn(files)`), a `Glob` carries `compiled` and `literals` in
  place of `alternatives`, and `intersectGlobs` throws where the search is
  undecided. `globWitness`, `globCovers`, `globBases`, `readingIn`, `meet`,
  `scopeOf` and `contradictions` are new. `intersectTokens` is gone.
- A `shared-directory` finding has a hint, and a `glob` finding says what a
  scope pattern looks like.
- Versions are published by CI through npm's trusted publishing, with
  provenance that names the commit and the run (ADR-0010).
- `archive` no longer passes a scope it never measured. With no `--commit`,
  `--base` or `archiving.base`, without git, or with a commit already in the
  base branch - where the diff from the merge base is empty - a brief that
  declares `affectedFiles` or `protectedFiles` gets `scope-unmeasured`, a
  warning that names the next step, and a refusal under `--strict`. It is the
  first archive rule, and configuration sets its severity like any other.
- An open box is closed only by a note under it that starts with a
  disposition marker. A marker anywhere in the item used to count, the box's
  own text included, so `- [ ] Explain why the **Rejected** designs failed`
  archived as dispositioned.
- `archiving.rewriteLinks: false` now holds for the links other briefs hold
  to a moving brief, which were rewritten regardless. Those left pointing at
  the old path are reported as `stale-link`, a warning naming each file and
  line, on `archive` and `unarchive` alike; `unarchive --strict` refuses on
  it, as `archive --strict` does.
- `matrix` reports two briefs whose scopes meet as one collision, however
  many pairs of their patterns meet, and the finding lists every pair with a
  path both cover. A pair writing into several shared directories is likewise
  one `shared-directory` finding.
- JSON documents are `schemaVersion: 2`. In `matrix --format json` a
  collision carries `overlaps`, a list of `{ patterns, witness }`, in place of
  `patterns` and `witness`, and a `sharedDirectories` entry carries
  `directories` in place of `directory`. The library's `Collision` and
  `SharedDirectory` change the same way.
- A plugin package whose `exports` offer only the `import` condition loads.
  Packages were resolved with `require.resolve`, which reads `exports` under
  the require conditions, so an ESM-only plugin could not be found.
- A brace group is split on its own commas only: `{[,]x,y}` has the two
  alternatives `[,]x` and `y`, where a comma or brace inside a class used to
  split the group or unbalance it.
- A section rule takes a `hint`: what the section must answer. A new brief
  carries it as a comment under the heading, `missing-section`,
  `empty-section` and `placeholder` findings give it as their hint, and the
  JSON of `list` and `lint` gains `sections`, every section the configuration
  asks for with its type, switches and hint. The default sections carry one,
  and `init` writes them out. `empty-section` and `placeholder` findings have
  a hint even without one.
- A `--base` or `archiving.base` that names no commit stops `archive` with a
  message that says so, where git's failure to diff from it surfaced as an
  unexpected error with a stack trace.

## 0.1.0

The first release.

- `init`, `new`, `lint`, `list`, `matrix`, `archive` and `unarchive`.
- Configurable conventions: directories, file names, ids, status words,
  sections with aliases, order and required text, brief types, archival
  dispositions and the banner template. A configuration that does not load
  stops the run with exit 2.
- 22 lint rules and 3 collision rules, with severities set in configuration.
- Scope collisions by glob intersection, with a path both scopes cover.
- Archival as a planned transaction: preflight, banner, link rewriting in both
  directions, freeze hash, rollback on failure. Git is read, never written.
- Pretty, JSON, SARIF 2.1.0 and GitHub workflow-command output.
- Rule plugins, and a library API over a real or an in-memory filesystem.
- No runtime dependencies.
- Mutation testing in two sweeps: the core measured at 95.75% and gated at 93
  (ADR-0009); coverage 100% of lines.
