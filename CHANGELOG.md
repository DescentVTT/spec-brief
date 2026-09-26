# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org).

## Unreleased

### Upgrading from 0.1.0

- **A configuration that already uses the word "deferred" no longer loads.**
  Deferred work is a new status, and its word is `"deferred"` unless the
  configuration says otherwise, so `"status": { "draft": "deferred" }` now
  names two statuses with one word and stops the run with exit 2: "the
  status words must differ: "deferred" is the word for draft and deferred".
  Set `"status": { "deferred": null }` where the repository defers no work,
  or give the new status a word of its own, `"deferred": "parked"`.
- **JSON documents are `schemaVersion: 2`**, every command's: the version
  is one number for all of them, and `matrix`'s document changed meaning. A
  collision is a pair of briefs and carries `overlaps`, a list of
  `{ patterns, witness }`, in place of `patterns` and `witness`, and a
  witness is always a file, never a directory; a `sharedDirectories` entry
  carries `directories` in place of `directory`; and deferred briefs, and
  the briefs waiting on them, left `waves[].briefs` for `deferred` and
  `waiting`. `list`, `lint` and `archive` changed only by adding: `trigger`
  and `sections`, a `"deferred"` status, and `path` and `paths` on a
  finding. A reader of those documents reads version 2 as it read 1.
- **`**` inside a name is an error**, where it was read as `*`: a scope
  written `docs/**.md` is a `glob` error in `lint`, and a `files` or
  `exclude` pattern written so stops the run with exit 2. Parentheses are
  literal unless a group holds a `|`. Both are under "Globs" below.
- **A note that continues its box's paragraph no longer closes the box**:
  `- [ ] Add a cache` over `  **Rejected** by 012` refuses an archival as
  `open-task` until the note is a bullet or has a blank line above it. See
  the entry on open boxes below.

### Breaking (library API)

- `Config['status']['deferred']` is required, `null` where a repository
  has no such word. A configuration from `resolveConfig` or
  `DEFAULT_CONFIG` has it; one built by hand must set it.
- `Status` gains `'deferred'`, and `Format` and `FORMATS` gain
  `'gitlab'`: an exhaustive `switch` over either needs the new case.
- `CollisionReport` gains the required `deferred` and `waiting`, and
  `WaveMatrix` the required `undecided`; a report built by hand carries
  them. A wave's `briefs` no longer holds a deferred brief or one waiting on
  deferred work.
- `Collision` carries `overlaps` in place of `patterns` and `witness`, and
  `SharedDirectory` carries `directories` in place of `directory`, as the
  JSON does.
- `parseGlob`'s `isFile` option is replaced by `literal` (`'file'`,
  `'directory'`, `'either'` or a function, such as `readingIn(files)`), a
  `Glob` carries `compiled` and `literals` in place of `alternatives`, and
  `intersectGlobs` throws where the search is undecided.

### Changes

- Markdown is read by spec-core's scanner and front matter by its reader,
  copied into `src/vendor/spec-core/` beside the glob engine and verified by
  hash (ADR-0001, amended). What a brief's structure is stays as it was: a
  section, and the title, is an ATX heading, `## Name`, outside a block
  quote, so prose over a `---` line is still prose and a rule, not a section,
  and a heading quoted from another document is not one of the brief's; a task
  is a list item outside a block quote with `[ ]`, `[x]` or `[X]`. What counts
  as code, a comment or a link is now what CommonMark says it is:
  - **Indented code and raw-text HTML are code.** Four spaces at the top
    level after a blank line, and a `<pre>`, `<script>`, `<style>` or
    `<textarea>` block, hold no heading, task or link: a box in an indented
    example no longer refuses an archival, and a fence indented four spaces
    there no longer hides the rest of the brief. Inside a list item, code
    starts four columns past the item's text: a box written that deep after a
    blank line is code, and a fence that deep opens nothing.
  - **A `<!--` in the middle of a line with no `-->` after it is text.** It
    hid everything after it, so every later section was missing. One that
    opens a line still runs to the end.
  - **A heading's text leaves out a comment on its line**:
    `## Intent <!-- required -->` fills `Intent`, where it was reported
    missing.
  - **A code span may close on a later line of its paragraph**, and a link
    inside one is not rewritten.
  - **A thematic break ends a task**, so a note after `***` no longer closes
    the box above it; and **a tab indents to the next multiple of four
    columns**, so a tab-indented note under a box indented by two spaces is
    part of the item.
  - **A link is one CommonMark reads.** `a](b.md)` and `[a](b.md c)` are text
    and are no longer rewritten on archival; a definition in a block quote
    is, and so is a destination after link text that runs over lines.
  - **TOML front matter** between `+++` lines is recognised. `front-matter`
    reports it, where it was read as body text and only the missing status
    was reported.
  - **An inline list on the line under its key** - `affectedFiles:` and then
    `  [src/**]` - is reported as "an inline list starts on the line after
    its key; write it after the colon", where the advice was to quote it,
    which would have made the list a string.
- Nothing is written into front matter that cannot hold it: TOML, or a block
  never closed. `schedule --write` and `unarchive` refuse such a brief as
  `front-matter`, and so does `archive` where lint's own `front-matter` error
  does not refuse it already. `unarchive` stopped with an unexpected error on
  a block never closed, as `archive` did with an empty banner template, and
  `archive` otherwise prepended a second block above the banner.
- A carriage return that ends no line, as a `\r\r\n` ending leaves one, is
  read as a space; line numbers are unchanged. A front-matter line ending in
  one now reads, where it was "not a key: value line".
- Library API: `Brief.frontMatter` is spec-core's `FrontMatter`. It gains
  `kind` (`'yaml'` or `'toml'`), and each entry gains `parent`, `keyStart`,
  `valueStart` and `valueEnd`, offsets into the brief's `lines` joined by
  `\n`. `Brief.scan` gains `links`, the destinations archival rewrites.
- Globs are spec-core's `path` dialect, matched and intersected by its
  automaton, which is copied into `src/vendor/spec-core/` and verified by
  hash. The syntax is unchanged but for two refusals; what it means changes
  in four places.
  - **`**` inside a name is an error**: `docs/**.md`, `**.ts`, `a**b`. It
    was read as `*`, one level, and dropped every nested file from a scope
    that tools elsewhere read as recursive. The message says to write
    `docs/**/*.md` for any depth, or `*.md` for one level. A scope pattern
    written so is a `glob` error in `lint`, and a `files` or `exclude`
    pattern stops the run with exit 2.
  - **Parentheses are literal unless a group holds a `|`**:
    `C++(notes).md`, `*(2017).md` and `@(a)` are names, where every
    `?(`, `*(`, `+(`, `@(` or `!(` was refused as an extended glob.
    `+(a|b)` is still refused, and the message now says to write `{a,b}`,
    and a literal parenthesis as `[(]`.
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
  reports. A brief that depends on deferred work, directly or through another
  brief, runs in no wave either: `matrix` lists it under `waits`, and in JSON
  under `waiting` with the brief it waits on, and compares it with nothing,
  as `schedule` places it nowhere.
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
  untouched, as one transaction, and writes nothing over a cycle. A declared
  wave that differs from the computed one is judged as `lint` and `matrix`
  judge it: no collision in it, dependencies before it, dependents after it.
  One that holds is a person's choice to keep, and its move is a note.
  Exit 0 when every declared wave holds, 1 when a brief declares no wave or
  one that does not hold, or on a cycle. Pretty, JSON, SARIF, GitHub and
  GitLab output; `wave-schedule`, an error by default, is the finding per
  move, and a note for a move whose declared wave holds.
- A plugin may export a `waive` hook beside its rules (ADR-0007, amended).
  After an archival is planned, and only when it has a refusal a plugin may
  lift, each hook is given `{ root, brief: { id, file, text }, findings,
  base, commit }`, a frozen copy, and answers `[{ rule, path, reason }]`. A
  `protected-file` or `out-of-scope` refusal of the plan's own that it names
  by rule and path becomes a `waived` note; a waiver for any other rule is
  ignored with a `waiver-ignored` warning, and one that matches no refusal
  changes nothing. A hook that returns nothing waives nothing; one that
  throws - a write to the copy included - or answers in another shape stops
  the run with exit 2. This is how spec-harness's plugin lets a signed ruling
  allow a protected file, without spec-brief reading signatures.
- A `protected-file` refusal names its file in a new `path` field, one
  finding per file as before, and an `out-of-scope` finding lists its files
  in `paths`. Both appear in the JSON of `archive`; a plugin reads them.
- `--format gitlab` wherever `sarif` is offered - `lint`, `matrix`,
  `schedule` - writes a GitLab Code Quality report: an array of
  `{ description, check_name, fingerprint, severity, location }`, errors as
  `major`, warnings as `minor`, notes as `info`, and a fingerprint that
  hashes the rule, the file and the message but not the line.
- 24 lint rules and 5 collision rules.
- The library's `parseGlob`, `matchGlob`, `intersectGlobs` and `globBase`
  keep their signatures over the new engine, with the options and shapes
  under "Breaking (library API)" above. `globWitness`, `globCovers`,
  `globBases`, `readingIn`, `meet`, `scopeOf`, `contradictions` and
  `waitingOnDeferred` are new. `intersectTokens` is gone.
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
  disposition marker, and a note is a block of its own in the item: a
  bullet, `  - **Rejected** by 012`, or a paragraph after a blank line. A
  marker anywhere in the item used to count, the box's own text included, so
  `- [ ] Explain why the **Rejected** designs failed` archived as
  dispositioned, and so did the same sentence wrapped after "the", indented
  or not. A line that continues the box's paragraph no longer closes it,
  whatever it starts with: a note written as `- [ ] Add a cache` over
  `  **Rejected** by 012` now refuses the archival as `open-task`, and the
  hint says to make it a bullet or put a blank line above it.
- `archiving.rewriteLinks: false` now holds for the links other briefs hold
  to a moving brief, which were rewritten regardless. Those left pointing at
  the old path are reported as `stale-link`, a warning naming each file and
  line, on `archive` and `unarchive` alike; `unarchive --strict` refuses on
  it, as `archive --strict` does.
- `matrix` reports two briefs whose scopes meet as one collision, however
  many pairs of their patterns meet, and the finding lists every pair with a
  path both cover. A pair writing into several shared directories is likewise
  one `shared-directory` finding.
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
