# Changelog

Notable changes, newest first. Before 1.0, a minor release (0.2 to 0.3)
carries anything that can turn a passing run red or change what a script
reads - a finding not reported before, a changed exit code, input refused
that was accepted, a flag, key or JSON field removed or renamed after a
release of warning - and new features; a patch release carries only fixes
that report less, crashes, speed and documentation, so `^0.3.0` takes no
release that can turn a run red. This is the family's policy, recorded in
[spec-core ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md);
releases up to 0.2.7 came before it, and several of their patches changed
what a run reports.

## 0.6.1

Four ways a run ended with `unexpected error:` and a stack for something
that was no defect of spec-brief's. Each is one line now; every exit code is
as it was.

### Fixed

- **A reader that closes the output is answered in one line, not a stack.**
  `spec-brief list | head` could end with `spec-brief: unexpected error:
  Error: EPIPE: broken pipe, write` and a stack once `head` had left; it now
  prints `spec-brief: stdout was closed before all of the output was
  written` on stderr, exit 2 as before
  ([the family contract](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
- A `SOURCE_DATE_EPOCH` of more seconds than any date has is named, with
  what to do about it, where the run ended on `RangeError: Invalid time
  value` and a stack. Exit 2, as before.
- `archive` reports what git was not handed or could not do by its message
  alone: `"-x" is not a revision` for a `--commit`, a `--base` or an
  `archiving.base` that would be read as an option, and git's own words
  when its status or its diff fails. Exit 2, as before.
- `init --briefs ../docs` and `--archive` likewise are refused as the
  configuration refuses them, `--briefs must be a directory inside the
  repository`, where the path's error came with a stack. Exit 2, as before.

## 0.6.0

An error spec-brief did not expect before a command started, or where
nothing waited for it, ended the run with exit 1, which reads as findings; it
is exit 2 now, as it was already inside a command.

### Changed

- **An error spec-brief did not expect before a command starts ends the run
  with exit 2, not 1.** A command's own such failure was already
  `spec-brief: unexpected error:` with its stack and exit 2; one from
  `--version`, `--help` or what a run reads first - a `SOURCE_DATE_EPOCH`
  no date can be made of, for one - left the process as Node's uncaught
  error with exit 1, which reads as findings, and so did an error thrown
  where nothing waits for it. Each is now reported the same way, with exit 2
  ([the family contract](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
  Upgrading: a script that took exit 1 after such a crash for findings now
  sees 2, "the run could not be trusted"; `main()` from the package resolves
  to 2 where its promise rejected.

## 0.5.1

The README's commands gave `npx` the command's bare name, which on npm is
not this project's package. spec-brief itself is unchanged.

### Security

- Every command in the README gives `npx` the package's full name behind
  `--no-install`, as in `npx --no-install @descent-vtt/spec-brief ...`.
  `spec-brief` without the scope belongs to nobody on npm (2026-10-07), so
  anyone can register it.
  `npx` given a name the project has not installed fetches the package of
  that name and runs it, unasked when no terminal is attached: a fresh
  clone, a worktree before `npm ci`, a CI job with no install step.
  The CI examples install first, and [Names](README.md#names) says whose the
  names are; what was measured is in the family's
  [adopting guide](https://github.com/DescentVTT/spec-core/blob/main/docs/adopting.md#names).
  Upgrading: where a CI job or a script gives `npx` the command's name
  alone, write `npx --no-install @descent-vtt/spec-brief`. `--no-install`
  before the bare name is not enough: npm still runs a copy of that name's
  package an earlier fetch left in its cache.

## 0.5.0

Five defects a reading of every surviving mutant found, none of which a test
had held: names every JavaScript object answers to, a root directory named
with two leading dots, and three in what `matrix` and `archive` show.

### Changed

- A root whose directory name starts with two dots, such as `..drafts/`,
  keeps git: it was taken for a path outside the work tree, so `archive`
  skipped its dirty-tree check there. Upgrading: an archival that passed can
  be refused; commit the work or pass `--allow-dirty`, and name the round
  with `--commit` or `--base`.

### Fixed

- A command, brief type, configuration key or template placeholder named
  `constructor`, `toString` or `__proto__` is the unknown name it is:
  `spec-brief constructor` is "not a command" with exit 2 where it was a
  stack trace with exit 1, `type: constructor` is an `unknown-type` finding
  where it stopped `lint` for every brief, and `{constructor}` in a
  template is left as written.
- `matrix` draws its grid by brief, so two briefs that share an id are two
  rows marked each for itself; the findings and exit code were already right.
- `matrix` marks in its grid only what the run reports: with
  `shared-directory` off, as by default, two briefs writing into one
  directory are no longer marked `~`. `--format json` is unchanged.
- `archive` and `unarchive` refuse a brief whose banner on the first line
  hides TOML or unclosed front matter, with the `front-matter` finding,
  where they ended on an unexpected error.

## 0.4.1

`lint`, `matrix`, `schedule` and `archive` over a large repository take time
that grows with the work, not with its square; nothing they answer has
changed.

### Changed

- **`lint`, `matrix`, `schedule` and `archive` take time that grows with the
  briefs and the tree, not with the one times the other.** Every scope pattern
  was asked about every file git sees; the tree is now indexed by path once a
  run, and a pattern is asked only about the files below the directories its
  matches must lie in. Over 240 briefs and 93,000 files a lint took 35 s,
  nine tenths of it matching, and `matrix` 16 s. Nothing any command answers
  has changed.

## 0.4.0

spec-brief reads English only again, and a placeholder is told from a word
that begins with one: `TBD!` is a placeholder, `TODO.md` and `TODO-driven`
are not.

### Changed

- A placeholder ended by `!`, `?`, `;` or an ellipsis is read as one
  ended by a period is: `TBD!` and `TBD?` are a `placeholder`. A trigger
  that is only a placeholder and a stop, `TBD.`, is refused by
  `deferral-trigger` as a placeholder, where it passed as an event
  (ADR-0003). Upgrading: fill the section, or name the event that brings the
  work back.

### Removed

- spec-brief reads English only (ADR-0003). A deferral trigger that names
  only a time in Chinese (`下個月`, `2026年10月`, full-width `Ｑ３`) passes
  as an event again, the default `placeholders` lose `待定`, `未定`,
  `待補`, `待確認` and their Simplified forms, and a full-width colon after
  a placeholder no longer ends it. Upgrading: write the trigger in English,
  e.g. `trigger: when the second tenant signs`, and list any Chinese
  placeholder the repository uses under `placeholders`.

### Fixed

- A section whose line opens with a placeholder and a dot that goes on into
  a word, `TODO.md lists the open work.`, is no longer a `placeholder`.
- Nor is one whose placeholder runs into a word by a hyphen, such as
  `TODO-driven work is out.`; `TBD -` and `TBD - later` still are.

## 0.3.0

Deferral triggers and placeholders written in Chinese are read, the GitLab
fingerprint no longer changes with a message's wording, `matrix` names a file
the tree holds, and Chinese columns line up. spec-core is at 5666c96.

### Changed

- spec-core at 5666c96: `.//docs`, `./{/docs,src}` and `{.//docs,src}` read
  as relative patterns, where they were refused as rooted (ADR-0005).
  Upgrading: a scope refused before is read now; run `spec-brief matrix`.
- A front-matter key may be written in any script: `狀態: 已接受` is an
  `unknown-field` warning where it was a `front-matter` error, and
  `status.field` may name `狀態` or `状态`. Upgrading: write `status:`, or
  set `status.field`.
- `archive`, `unarchive` and `new` write a status word such as `封存`
  unquoted. Upgrading: a script matching the written line sees
  `status: 封存`.
- A deferral trigger that names only a time in Chinese (`下個月`,
  `2026年10月`, `第三季`, full-width `Ｑ３`) is refused by `deferral-trigger`
  (ADR-0003). Upgrading: name the event that brings the work back.
- The default `placeholders` gain `待定`, `未定`, `待補`, `待確認` and their
  Simplified forms, and a full-width colon ends a placeholder as a colon
  does. Upgrading: fill the section, or list the old `placeholders`.
- The GitLab fingerprint is built from the rule, the file, the brief and
  the finding's subject, never its message. Upgrading: the first merge
  request after upgrading shows each issue resolved and found again once.
- `matrix` and `schedule` name a file the tree holds where both patterns
  match one outside the protections, or say the file named is an example
  (ADR-0005).
- A pair the search could not decide is a `collision` (an error) when the
  tree holds a file both patterns match and neither brief protects.
  Upgrading: run the two briefs in different waves, or narrow a scope.

### Added

- `inTree` on each pair of patterns in `matrix` and `schedule` JSON
  (`schemaVersion` stays 2); `meet` takes the tree's files.
- A rule's result, a plugin's included, may carry a `subject`, which the
  GitLab fingerprint is built from.

### Fixed

- `list`, `schedule` and `matrix` line up columns holding Chinese.
- `unknown-field` no longer suggests a key that shares nothing with the one
  written (`狀態` was asked about `id`).
- `list` shows the status word the brief writes, such as `封存`, not its
  English equivalent.
- `list` and `schedule` show a title without the id it repeats.
- `--help` lists the formats each command writes.

### Documentation

- The README is reorganised into lists and tables, with a "Scope patterns"
  list of one rule per item; SECURITY.md says how to report a vulnerability
  privately.

## 0.2.7

spec-core at 7e41240: a brace alternative that starts with `/`, such as
`{/docs,src}`, is refused as a pattern that starts with one is, where the
new copy roots it at the filesystem's root and `docs` would have left the
scope unsaid. So is `.//docs`, which spec-core read as `/docs` already.

### Changed

- spec-core at 7e41240. It reads a leading `/` on a brace alternative as it
  reads one on the whole pattern, so `{/docs,src}` is `/docs`, rooted at
  the filesystem's root, or `src`, where the slash was dropped and it read
  `docs` or `src`. spec-brief refuses it, as it refuses `/docs`: in
  `affectedFiles` or `protectedFiles` it is a `glob` error, `a pattern is
  relative to the repository root, and the braces expand to "/docs", which
  starts with "/"`, and a `files` or `exclude` pattern spelt so is a
  configuration problem, and the run exits 2. Read as the copy reads it,
  `docs` would have fallen out of the scope, the protection or the briefs
  a run reads, with nothing said. `{src,/docs}`, nested braces,
  `{//docs,src}`, `{.//docs,src}`, `./{/docs,src}` and `{a,/b}c` are
  refused the same way, each naming the text the braces give. A `/` after
  a name starts no text, and reads as it did: `docs/{/a,b}` is `docs/a` or
  `docs/b`, and `a{/b,c}` is `a/b` or `ac`.

### Fixed

- A pattern that starts with `./` and then `/`, such as `.//docs`, is
  refused as `/docs` is, `a pattern is relative to the repository root and
  cannot start with "/"`. spec-core drops the `./` and reads `/docs`,
  rooted at the filesystem's root, so in a scope it matched nothing and no
  finding said so, and as `files` it read no briefs. `./docs` reads as it
  did.

## 0.2.6

spec-core at 56c7e54: a brace alternative that names no path, such as
`{./,src}`, is refused as the same text alone is, where it read as every
path. `literal-read-as-file` advises the `/` on the brace alternative it
names, built from the pattern written.

### Changed

- spec-core at 56c7e54. A brace alternative that names no path is refused,
  as the same text written alone is. `{./,src}` in `affectedFiles` or
  `protectedFiles` read its `./` as every path, where `./` alone is
  refused: protecting it protected the whole tree, so `scope-contradiction`
  reported every affected pattern, and in `affectedFiles` it overlapped
  every other brief's scope. It is now a `glob` error, `the braces expand
  to "./", which names no path`, and so are `{src,./}`, `{.,src}/` and
  `.{/,src}`. A `files` or `exclude` pattern spelt so matched every name in
  the briefs directory; it is now a configuration problem, and the run
  exits 2. `src/{./,a}`, `{./a,b}` and `a{,.ts}` read as they did.
- `glob` names the alternative in refusals it already made: `{.,src}` is
  `the braces expand to ".", which names no path`, and `{/,src}` the same
  with `"/"`, where both were `the pattern names no path`; `{,src}`,
  `{src,}` and `{}` are `the braces expand to an empty pattern`.
- `literal-read-as-file` advises the pattern as written with a `/` ending
  each alternative it names, where it said to write a directory with a
  trailing `/`, in an entry of its own. Since 0.2.5 a trailing `/` on a
  brace alternative says directory, so for `lib/{util,new}` in a tree
  without `lib/new` the hint is `write "lib/{util,new/}" for a directory,
  or "lib/new/" in an entry of its own`. Where more of the pattern follows
  the braces, `{a,b}/new`, a `/` inside them cannot end one alternative
  alone, and the hint names the entries: `write "a/new/" and "b/new/" for
  directories, in entries of their own`. What the note fires on is
  unchanged.

## 0.2.5

spec-core at f9ce375. A trailing `/` on a brace alternative means that
directory's contents, as one written alone does: `{src/newmod/,lib}` scopes
what `src/newmod/` and `lib` scope, so a collision inside a directory the
round creates is no longer missed.

### Changed

- spec-core at f9ce375. Its glob reads a trailing `/` on a brace
  alternative as it reads one on the whole pattern. In a scope,
  `{src/newmod/,lib}` covers `src/newmod/index.ts` and not `src/newmod`,
  whatever the tree holds. `src/newmod` was a literal read from the tree,
  and while the tree did not hold the directory, or with no tree, it
  covered only a file of that name: `matrix` missed a collision with a
  brief writing `src/newmod/index.ts`, which it now reports, and `schedule`
  now keeps the two briefs apart. A directory the tree holds reads as
  before.
- `literal-read-as-file` no longer names what a trailing `/` says is a
  directory: `{src/newmod/,lib}` in a tree holding neither names `lib`
  alone, where it named `src/newmod` and `lib`. A pattern left with no
  bare name to place, `{src/newmod/,docs/new.md}` in a tree holding
  neither, is `glob-matches-nothing`'s, as `src/newmod/` alone is, where it
  was noted for `src/newmod`.
- `archive`, which reads a literal as either, no longer takes a changed file
  at `build` itself as inside `{build/,Makefile}`, protected or in scope, as
  it never took one inside `build/`.
- In the library, `parseGlob(...).glob.literals` leaves out an alternative
  written with a trailing `/`, and the base `globBases` gives for
  `{src/newmod/,lib}` is `src/newmod` whatever the tree holds, where it was
  `src` while the tree did not hold the directory.

## 0.2.4

spec-core at 65ef842. Archival rewrites a link reference definition only
where CommonMark reads one, so text shaped like a definition - under a
paragraph's text, in alt text, in a wiki link's text - stays as written.

### Changed

- spec-core at 65ef842. Its Markdown scanner reads a link reference
  definition as CommonMark does. A definition cannot interrupt a paragraph:
  `[r]: r.md` on the line under a paragraph's text, a lazy line in a block
  quote or a list item included, is that text, and `archive` and
  `unarchive` leave it as written, where they rewrote `r.md`. A label holds
  no unescaped bracket and at most 999 characters: `[[r]: r.md](z.md)` is a
  link to `z.md`, which they rewrite, where they rewrote `r.md](z.md)` as
  the destination of a definition, and `[a\]b]: x.md` is a definition,
  whose `x.md` they now rewrite.
- References follow the definitions. With `[r]: r.md` written under text,
  `[x][r](y.md)` is a link to `y.md`, which archival now rewrites. A second
  bracket holding a bracket is no label, so with `[r]` defined,
  `[x [r][a[b]c] y](o.md)` holds the reference `[r]`, and `(o.md)` is text
  and stays as written, as around any link inside a link.

### Fixed

- Text shaped like a definition at the start of an image's alt text or a
  wiki link's text, `![[r]: r.md](z.png)` or `[[[r]: r.md]]`, is no longer
  rewritten by `archive`. spec-brief reads those texts again on their own,
  where such text opens a document and reads as a definition; CommonMark
  reads none there. `z.png` is rewritten as before.

## 0.2.3

spec-core at 119345e. A link inside a link now counts only the inner one, as
CommonMark and a renderer read it, so archival leaves the outer destination
as written. The refusal of `**` inside a name suggests patterns built from
the one written.

### Changed

- spec-core at 119345e. Its Markdown scanner reads a link inside a link's
  text as CommonMark does: in `[a [b](inner.md) c](outer.md)` the inner pair
  is the link, and the outer brackets and `(outer.md)` are text. `archive`
  and `unarchive` rewrite `inner.md` and leave `(outer.md)` as written,
  where they rewrote both; a renderer links nothing to `outer.md`, so it
  does not move with the brief. spec-brief no longer reads a link's text
  again to find the inner link. It still reads an image's alt text and a
  wiki link's text, which the scanner leaves unread, and keeps each
  destination once.
- The `glob` error for `**` inside a name suggests the pattern written,
  spelled both ways it may have meant: `docs/**.md` is told `docs/**/*.md`
  for any depth or `docs/*.md` for one level, and `src/a**` `src/a*/**` or
  `src/a*`, where every such pattern was told `docs/**/*.md` or `*.md`. The
  message's first clause is as it was.

### Fixed

- Text shaped like a reference definition at the start of a link's text,
  `see [[r]: r.md](z.md)`, is no longer rewritten by `archive`. spec-brief
  read the link's text on its own, where that text starts a line and reads
  as a definition.

## 0.2.2

A packaging fix: the tarball no longer carries spec-core's internal README.
Nothing a command does has changed.

### Fixed

- **The package ships one README, its own.** `files` named `README.md`,
  which npm reads as a name at any depth, so the tarball carried spec-core's
  vendored README beside the licence it ships; the entry is `/README.md`.

## 0.2.1

`spec-brief init` points `$schema` at the schema of the installed version, and
the README's links to files the package does not ship resolve on npmjs.com and
in `node_modules`. spec-core's scanner now reads an image inside a link's text
itself; archival rewrites and restores such a badge as 0.2.0 did, each
destination once. Nothing needs to change in a repository that upgrades.

### Changed

- `npm publish` in a checkout refuses to run outside GitHub Actions, so a
  version cannot reach npm from a workstation by mistake, without provenance;
  spec-harness 0.1.0 did. The release never runs it: it stages a tarball it
  packed.
- spec-core at 8840d36. Its Markdown scanner reads an image inside a link's
  text, as CommonMark renders it, and lists it after the link it lies in:
  `[![build](badge.svg)](actions)` gives both. spec-brief read the link's
  text itself, and still does for what the scanner leaves there - a link in
  a link's text, which CommonMark takes as the link - so a destination found
  both ways is kept once, and archival rewrites the badge inside a link once,
  as before, and restores it on reopening.
- The scanner makes a document's links, list items and directives mask the
  first time they are read, and keeps them. The answers are the same.

### Fixed

- `spec-brief init` points `$schema` at
  `./node_modules/@descent-vtt/spec-brief/schema.json`, the schema of the
  version installed, as the README recommends. It wrote a URL on GitHub that
  follows main, so an editor judged the configuration by a schema the
  installed version might not share. A configuration `init` already wrote
  keeps its URL until it is edited; either loads.
- The README's links to `docs/adr/` and `src/config.ts` are GitHub URLs. The
  package ships neither, so the relative links were dead on npmjs.com and in
  `node_modules`. A test holds every link in a document the package ships to
  a file it ships, or to one the repository holds by URL.

## 0.2.0

Scopes are read by spec-core's glob automaton, so a collision is proved with a
file both briefs would write and protected paths are subtracted from a scope
exactly. `spec-brief schedule` places briefs in waves from their dependencies
and provable collisions. Deferred work waits on an observable trigger. A plugin
may waive a `protected-file` or `out-of-scope` refusal, which is how
spec-harness applies a signed ruling. Briefs are read with spec-core's
CommonMark scanner, and the review of 0.1.0 is fixed throughout.

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
- Reopening a brief that had no front matter, in a repository with no status
  field, gives it back with none. Archival wrote a block to hold the
  integrity hash, and `unarchive` took the hash out and left `---` over
  `---` behind; a block the reopening empties now goes with it.
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
  untouched and a comment after the old wave kept, as one transaction, and
  writes nothing over a cycle. A declared
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
- Versions are staged by CI through npm's trusted publishing, with
  provenance that names the commit and the run, and a maintainer releases
  each with a second factor (ADR-0010).
- `archive` no longer passes a scope it never measured. With no `--commit`,
  `--base` or `archiving.base`, without git, or with a commit already in the
  base branch - where the diff from the merge base is empty - a brief that
  declares `affectedFiles` or `protectedFiles` gets `scope-unmeasured`, a
  warning that names the next step, and a refusal under `--strict`. It is the
  first archive rule, and configuration sets its severity like any other.
- An open box is closed only by a note under it that starts with a
  disposition marker, and a note starts a bullet, a paragraph after a blank
  line, or a line after one that ends a sentence (`.`, `?` or `!`, then
  only closing marks). A marker anywhere in the item used to count, the
  box's own text included, so `- [ ] Explain why the **Rejected** designs
  failed` archived as dispositioned, and so did the same sentence wrapped
  after "the", indented or not. A line that continues a sentence no longer
  closes the box, whatever it starts with; `- [ ] Add a cache.` over
  `  **Rejected** by 012` still does. A note under a box whose text ends
  without a stop, `- [ ] Add a cache` over `  **Rejected** by 012`, now
  refuses the archival as `open-task`, and the hint says to make it a bullet
  or put a blank line above it.
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
  A subpath is held to `exports` as Node holds it: a target, or what a
  `*` matched, with a `.`, `..` or `node_modules` segment is refused,
  split on `/` and on a backslash alike, so `pkg/..\..\outside` cannot
  climb out of `node_modules` on Windows.
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
