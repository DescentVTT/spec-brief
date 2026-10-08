# spec-brief

**Lint the contract a round of work runs under, map which rounds can run side by side, and archive a finished one in one atomic command.**

A *brief* is the input to one round of work - for a coding agent or a person: what done looks like, what the round must not touch, and the checks that prove it finished. spec-brief manages briefs as files in your repository. It has no runtime dependencies, reads and writes nothing but Markdown in two directories, and never writes to git.

spec-brief is one of the [spec-\* tools](https://github.com/DescentVTT/spec-core#the-family). The family's words - brief, round, wave, scope, the two kinds of plugin - are defined in [concepts](https://github.com/DescentVTT/spec-core/blob/main/docs/concepts.md), and the [tutorial](https://github.com/DescentVTT/spec-core/blob/main/docs/tutorial.md) takes one round from the brief to the archive in ten steps.

```bash
npm install --save-dev @descent-vtt/spec-brief
npx --no-install @descent-vtt/spec-brief init
npx --no-install @descent-vtt/spec-brief new "Rotate session tokens on privilege change" --wave 1
npx --no-install @descent-vtt/spec-brief lint
```

## Names

The package is `@descent-vtt/spec-brief`, and the command it installs is `spec-brief`. The name without the scope is not this project: on npm, `spec-brief` belonged to nobody on 2026-10-07, and whoever registers it decides what it runs.

`npx` fetches and runs the package of whatever name it is given when the project has none installed - a fresh clone, a worktree before `npm ci`, a CI job without the install step - and without a terminal it does not ask first. So give `npx` the full name:

- `npx --no-install @descent-vtt/spec-brief` in a project that installed it: it runs that install, the version the lockfile pins, and where there is none it stops with an error that names this package.
- `npx @descent-vtt/spec-brief`, without `--no-install`, where nothing is installed: it fetches this package and runs it.

<!-- bare-name: the two forms in the next sentence are shown as what not to write -->
Never `npx spec-brief`, and not `npx --no-install spec-brief` either: `--no-install` stops a download, and npm still runs a copy of the bare name's package that an earlier fetch left in its cache. A `package.json` script names the command alone, as in `"briefs": "spec-brief lint"`, because npm fetches nothing for a script. The family's [adopting guide](https://github.com/DescentVTT/spec-core/blob/main/docs/adopting.md#names) has what was measured, under npm 10, 11 and 12.

## Why

Repositories that run agents on briefs end up doing the same ceremony by hand, and getting it wrong in the same places:

- **A brief that is incomplete.** A missing negative scope or an empty invariant list is how a round wanders. `lint` checks the sections your repository requires, in the order it requires them, and that each one says something.
- **Two rounds that write the same files.** Run in parallel, they collide at merge time. `matrix` compares the scopes of briefs scheduled in the same wave *as globs*, and names a file both would write.
- **Archival.** Move the file, set its status, write a frozen banner with the date, the pull request and the commit, disposition every open box, add `../` to every relative link so they still resolve, fix the links other briefs hold to it. `archive` does all of it as one transaction, or none of it.

The conventions are not invented here. They were measured against two repositories that already keep briefs - one with front matter and eight ordered sections, one with none at all - and everything they disagree on is configuration.

## A brief

```markdown
---
status: active
wave: 2
dependsOn: [007]
affectedFiles: [src/auth/**, tests/auth/**]
protectedFiles: [src/db/schema.ts]
---

# 012 - Rotate session tokens on privilege change

## Intent

Every privilege change issues a new session token and invalidates the old one.

## Negative Scope

- No change to the login UI or the token format.

## Invariants

- [ ] `npm test` passes
- [ ] a rotated token is rejected by every endpoint
```

Work put off for later is a brief too, with `status: deferred` and a `trigger` naming the event that brings it back - "when the second tenant signs", "when p95 exceeds 200 ms", never a date: not `Q3`, not `2026-10`. A deferred brief stays in the briefs directory, is never ready, and runs in no wave until someone sets it `active`.

- The id comes from the file name (`012_rotate-session-tokens.md`) or from an `id` field.
- `affectedFiles` is the scope the round may write.
- `protectedFiles` is what it is not empowered to change, and archival refuses a round that changed it.
- Protection wins: what a round may write is `affectedFiles` less `protectedFiles`, so "all of `src/` but the schema" is `affectedFiles: [src/**]` with `protectedFiles: [src/db/schema.ts]`.

### Scope patterns

Scopes are globs in spec-core's `path` dialect, the one every spec-\* tool reads: `*`, `?`, `[a-z]` and `{a,b}` within a name, `**` for any number of directories, compared case-sensitively on every host. The rules:

- `**` is a whole segment: `docs/**.md` is refused, since tools read it three ways - write `docs/**/*.md` for any depth, or `docs/*.md` for one level.
- Parentheses are literal, `C++(notes).md`, unless a group holds a `|`: an extended glob such as `+(a|b)` is refused, and written `{a,b}`.
- A trailing `/**` or `/` is a directory's contents - at least one name below it, never the directory itself - on a brace alternative as on the whole pattern: `{src/,lib}` is `src/` or `lib`.
- Each alternative names a path under the root, as a whole pattern does: `./` is refused, and so is `{./,src}`.
- A pattern is relative to the repository root, so a leading `/` is refused, on an alternative as on the whole pattern: `/docs` and `{/docs,src}` alike. A leading `./` takes the slashes after it along, as POSIX reads them: `.//docs` is `docs`, and `./{/docs,src}` is `docs` or `src`.
- After a name, a `/` inside braces names nothing: `docs/{/a,b}` is `docs/a` or `docs/b`.
- A path with no glob syntax is read from the tree: a file the tree holds is that file, a directory it holds is everything beneath it, and a path it does not hold yet is a file unless it ends in `/`.
- Write `src/newmod/` for a directory the round creates; `lint` notes a bare `src/newmod` it cannot place.

### How a brief is read

A brief is read as CommonMark reads it wherever that decides what is code or a comment - fenced and indented code, `<pre>`, `<script>`, `<style>` and `<textarea>` blocks, code spans, HTML comments - and nothing inside those is structure.

- **A section**, and the title, is an ATX heading, `## Name`, outside a block quote: prose over a `---` line is prose and a rule, and a heading quoted from another document is not one of the brief's sections.
- **Section names** compare without case, typographic quotes, emphasis, a leading number or a trailing colon, and a heading may add a qualifier after a separator: `## 2. Commander’s Intent:` fills `Commander's Intent`, and `## Invariants (must hold)` fills `Invariants`.
- **A task** is a list item outside a block quote with `[ ]`, `[x]` or `[X]`.
- **The links archival rewrites** are the ones that write a destination: `[text](dest)`, `![alt](dest)` - one inside a link's text too - and a definition, `[label]: dest`, through which a reference is rewritten once. A definition is one where CommonMark reads it, opening a paragraph or under another: the shape of one under a paragraph's text, or in alt text, is text and stays as written.

## Commands

### `spec-brief init`

Writes `.spec-brief.json` with every default spelled out, and creates the brief and archive directories. `--briefs <dir>` and `--archive <dir>` choose them, and `--root <dir>` the directory to set up, which `init` makes when it is not there. It takes no argument: `init mydir` is [refused](#an-input-that-names-nothing).

### `spec-brief new <title>`

Scaffolds a brief with the next free number - one more than the highest id, live or archived, since ids are never reused - and every required section, each holding its `hint` in a comment. A comment is not content, so a fresh brief reads as unwritten until someone writes it. `--id`, `--type`, `--wave`, `--depends-on 7,8` and `--date` fill the front matter; without `--date` the date is [today's](#todays-date).

### `spec-brief lint [brief...]`

Checks every brief, or the ones named. A draft (`status: draft`) gets its unwritten sections as warnings; an active brief gets them as errors. Archived briefs are frozen records: they are checked for identity and for the freeze, never against today's schema.

```text
briefs/035_the-background-side.md
    5  error    has no "Report" section  missing-section
                add a "## Report" heading
   48  error    "Context" comes before "Standing directives"  section-order
                the order is Mission, Standing directives, Context, Deliverables, ...

2 errors, 0 warnings, 0 notes in 35 brief(s)
```

### `spec-brief list`

Live briefs with their status, in the word the brief writes (`封存` where the configuration names it for archived), wave, task count, readiness and title.

- **The title** is shown without the id it repeats: `new` writes `# 012 — Rotate tokens`, and the table has an id column, so the title shown is `Rotate tokens`. Only the brief's own id comes off, and only before a dash, a colon or a spaced hyphen, so `Fix - the login bug` is shown whole. `schedule` shows titles the same way, and `--format json` gives the title as written.
- **A brief is *ready*** when every brief it depends on is archived, and it is neither a draft nor deferred.

| Option | Shows |
| --- | --- |
| `--ready` | Only the ready briefs, which is the question an orchestrator asks. |
| `--archived` | The archive as well. |
| `--format json` | The whole table, for an orchestrator, and the sections the configuration asks for, each with its `hint`. |

### `spec-brief matrix`

Compares the `affectedFiles` of every pair of live briefs in the same wave, `--all-waves` for every pair. Deferred briefs, and briefs that wait on one directly or through another, are listed and left out: they run in no wave until the deferred work comes back, as `schedule` places them nowhere, so the two agree on which briefs run side by side.

```text
wave 1 · 3 briefs
       001  002  003
  001    ·    X    ·
  002    X    ·    ·
  003    ·    ·    ·
  X 001 "src/auth/**" and 002 "src/**/session.ts" both cover src/auth/session.ts
  ? 003 declares no affectedFiles and cannot be checked
```

Scopes are intersected as globs, not compared as strings: the two above share no prefix and still meet. Exit 1 on a collision.

- **The file named** is one both patterns match and neither brief protects - always a file, never a directory. It is a file the tree holds where there is one, the first in git's order; where the tree holds none, it is the shortest path the search built, said to be an example: `both cover src/newmod/a.ts, an example not in the tree`. `--format json` says which, as `inTree` on each pair of patterns: `true`, `false`, or `null` when the tree could not be read.
- **One collision per pair of briefs**: two briefs whose scopes meet in several places are one collision, listing every pair of patterns that meets.
- **Unscoped**: a brief with no scope is reported as unscoped rather than counted as safe.
- **Undecided**: the search for a shared file has a budget; a pair it cannot decide within it is marked `?` and reported as `collision-undecided`, a warning, never as a collision and never as clean - unless the tree holds a file both patterns match and neither brief protects, which proves the collision.
- **A mark is a finding**: the grid marks a pair, and a line beneath it says why, only for what the run reports, so a [rule](#rules) that is off marks nothing. `shared-directory` is off unless the configuration turns it on; on, two briefs that write into one directory without sharing a file are marked `~`. `--format json` lists every pair the comparison found under `waves`, and the `findings` the run reports beside them.

### `spec-brief schedule`

Computes the waves the live briefs can run in, drafts included, and sets each beside the wave it declares:

- A brief runs after every dependency that is still live - an archived one is done - and shares a wave with no brief whose writable scope meets its own.
- Briefs are taken in dependency order, ties broken by id, and each goes into the lowest wave that is after its dependencies and holds nothing it collides with.
- A brief with no `affectedFiles` cannot be proved apart from anything, so it runs in a wave of its own and is reported as `unscoped`.
- The first wave is the lowest any brief declares, or 1.

```text
wave 1 · 2 briefs
  001  Rotate session tokens
  003  Audit log            moves from wave 2
         wave 2 also holds
         nothing holds it later
wave 2 · 1 brief
  002  Store sessions       moves from wave 1
         wave 1 does not hold: 001 there also writes src/auth/session.ts
         not wave 1, where 001 also writes src/auth/session.ts ("src/**/session.ts" and "src/auth/**")

waits: 007 on 006, which is deferred
deferred: 006
2 briefs would move; "spec-brief schedule --write" writes the waves
```

Each move says why:

- first, whether the declared wave holds - whether `lint` and `matrix` would pass it: no brief there that it collides with, its dependencies in earlier waves, and the briefs that depend on it in later ones;
- the dependency that sets the earliest wave;
- for every wave passed over, the brief there and the file both would write.

A deferred brief, and one that waits on it, is placed nowhere; a dependency cycle is an error, and nothing in or after it is placed.

`--write` sets `wave` in the front matter of each brief whose wave changes, in one transaction, and writes nothing over a cycle:

- every other line stays as it was;
- a comment after the old wave, `wave: 2  # after the review`, stays after the new one;
- a brief whose lines end in both LF and CRLF is written with the ending of its first line throughout, as `archive` writes one.

`--format json` gives an orchestrator the waves, each brief's declared and proposed wave with the reasons and whether the declared one holds, and what waits on what; `sarif`, `github` and `gitlab` carry a `wave-schedule` finding per move.

The result is the same every time for the same briefs. It is a valid schedule, not always the shortest: no fast method promises the fewest waves, and a person can always move a brief later by hand, which `lint` and `matrix` then check. So a move is an error only when the declared wave does not hold, or there is none: a declared wave that holds is the person's to keep, and its move is a note.

| Exit | When |
| --- | --- |
| `0` | Every declared wave holds. |
| `1` | A brief declares no wave or one that does not hold, or the dependencies form a cycle. |
| `2` | The run cannot be trusted. |

### `spec-brief archive <brief>`

Closes a round. Refused, with every reason, when:

- the brief has lint errors, is a draft, or depends on a brief that is still live;
- a task item is neither ticked nor dispositioned:
  - an open box counts as closed when a note under it starts with one of the `dispositions` (`**Delegated`, `**Accepted debt`, `**Rejected` by default);
  - a note is a line under the box, above any box nested in it, that starts a bullet, a paragraph after a blank line, or a line after one that ends a sentence;
  - a line that continues a sentence is the box's text wrapping, not a note, so `- [ ] Explain why the` over `  **Rejected** designs failed` is open, and `- [ ] Add a cache.` over `  **Rejected** by 012` is closed;
- the working tree holds uncommitted work outside the brief directories (`--allow-dirty` to proceed);
- the round's commit changed a file in `protectedFiles` - one refusal per file, naming it, unless a spec-brief plugin that verifies rulings [waives it](#waiving-a-refusal).

Two warnings, which `--strict` turns into refusals:

- Changes outside `affectedFiles` are a warning, and an error under `--strict`.
- A scope is never passed by checks that measured nothing. When the files the round changed are unknown - no `--commit`, `--base` or `archiving.base`, `--no-git`, or a commit already in the base branch, as on `main` after the merge - a brief that declares one gets `scope-unmeasured`, a warning, and a refusal under `--strict`.

Otherwise, in one transaction, it:

- writes the archived brief with its status set, a frozen banner under the front matter, every relative link rewritten for the archive directory, and an `integrity` hash;
- rewrites the links other live briefs hold to it;
- removes the original.

With `archiving.rewriteLinks` off, no link is rewritten, and the links other live briefs are left holding are reported as `stale-link`. Archiving an archived brief does nothing and exits 0.

| Option | What it does |
| --- | --- |
| `--commit <rev>` | Records the commit and the files it changed. |
| `--base <rev>` | Measures from the merge base instead, for a branch of several commits. |
| `--pr <n>` | Links the pull request. |
| `--summary <text>` | What the round did, in the banner. |
| `--date <YYYY-MM-DD>` | The date in the banner, where it is not [today's](#todays-date). |
| `--dry-run` | Prints the plan and the banner, and writes nothing. |

spec-brief reads git and never writes it. Review the change and commit it with the round.

### `spec-brief unarchive <brief>`

Reopens an archived brief: the banner and the hash come off, the status goes back to the live word, and the links are rewritten again. A brief archived and reopened is the brief it was, blank lines and final newline included, with four exceptions:

1. The status line is written in its plain spelling.
2. A relative link that had to be rewritten comes back in its shortest form (`./b.md` returns as `b.md`).
3. An empty front matter block, `---` over `---`, comes back as none, since archival gives a brief with no front matter a block for its hash and reopening takes away a block it leaves empty.
4. A brief whose lines end in both LF and CRLF comes back with the ending of its first line throughout.

### Every command

| Flag | What it does |
| --- | --- |
| `--root <dir>` | Runs from another directory, which must be there: only `init` makes one that is not. |
| `--config <file>` | Names the configuration. |
| `--no-config` | Uses the defaults. |
| `--format <format>` | `pretty` by default, or `json`; `lint`, `matrix` and `schedule`, which report findings, also write `sarif`, `github` and `gitlab`, and `--help` lists each command's formats. |
| `--strict` | Makes warnings fail the run. |
| `--no-git` | Leaves git out even inside a repository: the tree is read from disk, and `archive` records no commit. |
| `--color`, `--no-color` | Override `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and the terminal check. |
| `--help`, `--version` | Do what they say. |

**Exit codes:**

| Code | Means |
| --- | --- |
| `0` | Clean. |
| `1` | Findings, a collision, or a refused action. |
| `2` | The run could not be trusted, or its answer did not arrive - a bad flag, [an input that names nothing](#an-input-that-names-nothing), a configuration that does not load, a brief that does not exist, a git command that failed, a `SOURCE_DATE_EPOCH` that [cannot be read as a date](#todays-date) where one is to be written, a stdout its reader closed before all of the output was written, as a pipeline into `head` does, each said in one line on stderr, or an error spec-brief did not expect, reported on stderr as `spec-brief: unexpected error:` with its stack. |

A run over a briefs directory that does not exist exits 2, because a check over nothing looks exactly like a clean one.

### An input that names nothing

An option, an argument or a path that is given and names nothing is refused: exit 2, one line that names it, nothing written. None is read as if it had not been given. `--root "$DIR"` where the variable is not set would otherwise run in the current directory, and the answer would look like the one that was asked for.

- **An option given nothing.** Every option that takes a value refuses one that is empty or only space, by the option's name: `--id is "", which is no value`. No option gives an empty value a meaning; leave the option out for what it does by default.
- **A list that names nothing.** `--depends-on ,` names no brief, and a brief that depends on nothing is one scaffolded without the option. A place in a list that names no brief, the comma too many in `7,8,` or the gap in `7,,8`, is refused as well: it is a brief left out, as `"$A,$B"` is with one of the two unset.
- **An argument a command does not take.** `init`, `list`, `matrix` and `schedule` take none and refuse one by name, with their usage. `init mydir` set up the current directory; `init --root mydir` is what sets up another.
- **A `--root` that is no directory.** A file, or a path that does not exist, is refused: the search for a configuration would go on from its parent, and the run would report on, or `new` write into, the tree above. A directory below the configuration's is a place to start from, as the current directory is.
- **A configuration that is a directory**, named by `--config` or found under the configuration's name, does not load, and is said so in a line, as one that is not JSON is.

### Today's date

`new` writes a date into the front matter and `archive` one into the banner: the one `--date` gives, or today's. Today is the clock's date in UTC, unless `SOURCE_DATE_EPOCH` is set, the variable a pipeline sets to have every run write the same bytes ([its specification](https://reproducible-builds.org/specs/source-date-epoch/)): then it is the date of that time, in UTC.

- **What it holds**: whole seconds since 1970-01-01 in digits alone, as `date +%s` prints them, from `0` to `253402300799`, the last second of 9999-12-31 and of the dates written `YYYY-MM-DD`.
- **Anything else is refused**, never read as unset: a word, `1.5`, `-1`, a space or a newline beside the digits, a later time, or nothing at all, which is what `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` leaves where git failed. `new` and `archive` then write nothing and exit 2 with a line that names the variable and shows what it holds. The clock's date, written where a pipeline asked for its own, would look like any other.
- **Only a run that would use it reads it**: `--date` gives the date instead, and `init`, `lint`, `list`, `matrix`, `schedule`, `unarchive`, `--version` and `--help` write none, so each runs whatever the variable holds.

## Configuration

`.spec-brief.json` (or `spec-brief.json`) at the root; the nearest one above the working directory is used, and its directory is the root. It is JSON, validated against [`schema.json`](schema.json): an unknown key, a misspelt rule or a value of the wrong type stops the run with exit 2 rather than falling back to defaults and reporting on the wrong rules.

| Key | Default | What it says |
| --- | --- | --- |
| `briefs` | `"briefs"` | Directory of live briefs. |
| `archive` | `"<briefs>/archive"` | Directory of archived briefs. |
| `files` | `"[0-9]*.md"` | Glob a file name must match to be a brief. |
| `exclude` | `[]` | File-name globs that are never briefs, such as an index. |
| `template` | `null` | A template file for `new`, with `{id}`, `{title}`, `{date}`, `{type}`, `{wave}`, `{status}`. |
| `id` | `{ "source": "filename", "separator": "_", "digits": 3 }` | Where an id comes from, and how a new one is written. |
| `status` | `{ "field": "status", "draft": "draft", "active": "active", "deferred": "deferred", "archived": "archived" }` | The words a repository uses. `field` may be a key of any script, `狀態` as well as `status`, followed by an ASCII colon in the brief; `field: null` reads status from location alone; `draft` and `deferred` may be `null` where a repository has no such word. |
| `sections` | Intent, Negative Scope, Not Empowered (optional), Invariants (checklist) | Sections every live brief carries: a name, or `{ name, aliases, mustContain, checklist, optional, hint }`. `hint` is below. |
| `sectionOrder` | `false` | Sections must appear in the listed order. |
| `types` | `feature`, `defect`, `refactor`, `chore` | Brief types and the sections each adds. |
| `placeholders` | `TBD`, `TODO`, `FIXME`, ... | Words that mark a section as unwritten: alone or ended by `.`, `!`, `?`, `;`, `…` or `-`, and then nothing, or a space, a colon or an em dash and a note. `TODO.md` and `TODO-driven` are words, not placeholders. |
| `fields` | `[]` | Front-matter keys the repository uses beyond the built-in ones. |
| `archiving.tasks` | `"all"` | `"all"`, or the sections whose boxes must be closed. |
| `archiving.dispositions` | `**Delegated`, `**Accepted debt`, `**Rejected` | What a note under an open box starts with to close it. |
| `archiving.banner` | see [`src/config.ts`](https://github.com/DescentVTT/spec-brief/blob/main/src/config.ts) | Banner lines, with `{date}`, `{summary}`, `{pr}`, `{commit}`, `{diffstat}`, `{links}`, `{id}`, `{title}`, `{author}`. A line with an empty placeholder is left out. |
| `archiving.rewriteLinks` | `true` | Rewrite relative links when a brief moves: its own, and the ones other live briefs hold to it. Off, neither is edited, and the links other briefs are left holding are reported as `stale-link`. |
| `archiving.freeze` | `true` | Write an integrity hash, so a later edit is caught. |
| `archiving.base` | `null` | Branch the diff is measured from, such as `"main"`. |
| `rules` | `{}` | Severity per rule: `off`, `note`, `warning` or `error`. |
| `plugins` | `[]` | Modules that contribute rules: a path or package, or `{ module, options }`. |

A section's `hint` says what the section must answer, so a tool helping to write a brief can ask for each section by what it is for:

- a new brief carries it as a comment under the heading;
- a finding that the section is missing or unwritten gives it as the next step;
- the JSON of `list` and `lint` reports it.

A repository whose briefs have eight ordered sections, `proposed` and `archived` for words, and a banner of its own:

```json
{
  "$schema": "./node_modules/@descent-vtt/spec-brief/schema.json",
  "files": "[0-9][0-9][0-9]_*.md",
  "status": { "draft": null, "active": "proposed", "archived": "archived" },
  "sections": [
    "Mission",
    { "name": "Standing directives", "mustContain": ["Latest ≠ Newest"] },
    "Context",
    { "name": "Deliverables", "checklist": true },
    "Not empowered",
    "Architectural empowerment",
    "Verification",
    "Report"
  ],
  "sectionOrder": true,
  "types": {},
  "archiving": {
    "tasks": ["Deliverables"],
    "banner": ["**Executed {date} in pull request {pr}.** {summary} The body below describes the tree before execution and is not maintained."]
  }
}
```

How a heading fills a section, and what counts as a heading, a task or a link, is under [How a brief is read](#how-a-brief-is-read).

## Rules

<!-- rules:start -->
| Rule | Default | Reports |
| --- | --- | --- |
| `front-matter` | error | Front matter that does not parse, a duplicate key, YAML beyond the flat subset, TOML. |
| `field` | error | A field spec-brief reads with a value of the wrong shape: a wave that is not a whole number, a list where one value belongs. |
| `unknown-field` | warning | A front-matter key nobody declared, with the one probably meant. |
| `status` | error | No status, a word the configuration does not use, or a status that disagrees with the directory. |
| `id` | error | No id, or one with whitespace or a slash. |
| `duplicate-id` | error | Two briefs, live or archived, with one id. |
| `title` | warning | A live brief with no title. |
| `unknown-type` | error | A type the configuration does not define. |
| `missing-section` | error | A required section that is absent. |
| `duplicate-section` | warning | A section that appears twice. |
| `empty-section` | error | A section with no content; a comment is not content. A warning in a draft. |
| `placeholder` | error | A section holding only `TBD`, `TODO` or an empty box. A warning in a draft. |
| `missing-checklist` | error | A checklist section with no task item. A warning in a draft. |
| `must-contain` | error | A section without the text the configuration requires of it. |
| `section-order` | error | Sections out of the configured order, when one is configured. |
| `dependency` | error | A dependency on itself, or on a brief that does not exist. |
| `dependency-cycle` | error | Live briefs that depend on each other in a cycle, reported once, as a path. |
| `wave-order` | error | A live dependency that does not run in an earlier wave. |
| `deferral-trigger` | error | A deferred brief with no `trigger`, or one that is only a date or a time - `2026-10`, `Q3`, `next month`, `October` - or a placeholder, rather than an event such as "when the second tenant signs". The words for a time are English. |
| `glob` | error | A scope pattern spec-brief cannot read. |
| `scope-contradiction` | error | Patterns in `affectedFiles` that `protectedFiles` cover entirely, so nothing of them is writable - one finding per brief, naming each. A pattern the search cannot decide is a warning. |
| `glob-matches-nothing` | note | A scope pattern that matches no file git sees, tracked or untracked - expected when the round creates it. |
| `literal-read-as-file` | note | A path with no glob syntax that the tree does not hold and whose name has no extension, such as `src/newmod`: read as a file, and `src/newmod/` if a directory was meant. Inside braces the advice is the pattern written with the `/` added, `lib/{util,new/}`, or the alternative in an entry of its own, `lib/new/`. |
| `archive-freeze` | error | An archived brief that changed after it was archived. |
| `collision` | error | Two briefs in one wave whose scopes can name the same file (`matrix`). |
| `collision-undecided` | warning | Two briefs in one wave whose collision the search could not decide within its budget and no file of the tree proves (`matrix`), or a wave `schedule` passed over for it. |
| `unscoped` | note | A brief sharing a wave that declares no scope (`matrix`), or one `schedule` runs alone. |
| `shared-directory` | off | Two briefs in one wave writing into the same directory (`matrix`). |
| `wave-schedule` | error | A brief with no wave, or a declared wave that does not hold - a collision in it, a dependency out of order - with the wave `schedule` computes and why (`schedule`). A declared wave that holds and is not the computed one is a note. |
| `scope-unmeasured` | warning | A brief with a scope archived without the files its round changed, so nothing checked the scope (`archive`). |
| `stale-link` | warning | Links in live briefs left pointing where a brief used to be, when `archiving.rewriteLinks` is off (`archive`, `unarchive`). |
<!-- rules:end -->

`archive` refuses with its own reasons - `open-task`, `archive-draft`, `archive-deferred`, `dependency-open`, `dirty-tree`, `protected-file`, `out-of-scope`, `archive-exists` - and says `waived` and `waiver-ignored` of what [plugins](#waiving-a-refusal) lift; none of these are lint rules: they are about whether this round is done, not whether the brief is well written. The rules marked `archive` above are raised by archival too, and configuration sets their severity like any other.

## In CI

After the job has installed the project, with `npm ci`:

```yaml
- run: npx --no-install @descent-vtt/spec-brief lint --format github
- run: npx --no-install @descent-vtt/spec-brief matrix --format github
- run: npx --no-install @descent-vtt/spec-brief schedule --format github
```

Each gives `npx` the package's [full name](#names) and `--no-install`: a job that lost its install step then stops, where the command's name alone would fetch whatever package has that name.

| Format | What it writes |
| --- | --- |
| `github` | Workflow commands, which annotate the pull request with no upload and no permission. |
| `sarif` | SARIF 2.1.0, for code-scanning upload. |
| `gitlab` | A GitLab Code Quality report - an array of `{ description, check_name, fingerprint, severity, location: { path, lines: { begin } } }` - for a merge request to show. |
| `json` | A versioned document for anything else: `schemaVersion` changes when a field changes meaning, and is 2 since a collision became a pair of briefs rather than a pair of patterns. |

```yaml
spec-brief:
  script:
    - npm ci
    - npx --no-install @descent-vtt/spec-brief lint --format gitlab > gl-code-quality.json
  artifacts:
    reports:
      codequality: gl-code-quality.json
```

In the GitLab report:

- An error is `major`, a warning `minor` and a note `info`; GitLab's `critical` and `blocker` are for security holes and crashes, which no finding here is.
- The `description` is the message and the next action.
- The fingerprint is a SHA-256 of what the finding is: its rule, its file, its brief, and what it is about there - a section, a pattern, a dependency, the other brief of a pair - never the message, the hint or the line. So a finding that moves, or is worded another way, or a collision that names another file both briefs write, is the same issue; two findings alike in all four, such as two problems in one front matter, are told apart by their order.

## As a library

```ts
import { BriefEngine } from '@descent-vtt/spec-brief';

const engine = await BriefEngine.open({ cwd: process.cwd() });
const findings = await engine.lint();
const ready = engine.ready();                        // what can run now
const { report } = await engine.collisions();        // who collides with whom
const { schedule } = await engine.schedule();        // the waves, computed
const plan = await engine.planArchive('012', { commit: 'HEAD', pr: 41 });
if (plan.blocking.length === 0) await engine.apply(plan);
```

Everything below the engine is a pure function of text: `parseBrief`, `lint`, `collisions`, `meet`, `globWitness`, `planArchive`. `MemoryFileSystem` runs an engine over files that were never written, which is how a harness can ask what archiving a brief would do.

`parseGlob`, `matchGlob`, `intersectGlobs` and `globBase` keep their 0.1 signatures as a compatibility layer over the spec-core engine. They follow its dialect: a literal is read as a file unless `parseGlob` is told otherwise (`{ literal: 'directory' | 'either' | (path) => ... }`, where `readingIn(files)` reads it from a tree), and `intersectGlobs` throws where `globWitness` would answer `undecided`.

## Plugins

A plugin here is a spec-brief plugin, a module this tool loads, not a Claude Code plugin. It exports `{ name, rules }`, or a function of its configured options that returns one. Its rules run beside the built-in ones as `<name>/<rule>`, and configuration sets their severity like any other.

```js
// tools/departures.mjs
export default (options) => ({
  name: 'departures',
  rules: [{
    id: 'signed',
    description: 'every departure is signed',
    severity: 'error',
    check: ({ brief }) => brief.text.includes(options.marker) ? [] : [{ line: 1, message: 'has an unsigned departure' }],
  }],
});
```

```json
{ "plugins": [{ "module": "./tools/departures.mjs", "options": { "marker": "Signed-off-by" } }] }
```

A result is `{ line, message }`, with optional fields:

| Field | What it is |
| --- | --- |
| `hint` | The next action. |
| `severity` | Lower than the rule's, for this one finding. |
| `subject` | What the finding is about, where the rule can report several in one brief; GitLab's fingerprint is built from it. |

This is where integrations belong. A tool that defines a format - signed departures, recorded reproducers, a code graph's blast radius - is the one that can check it, and spec-brief carries no copy of formats it does not own. Loading a plugin runs its code, exactly as loading a linter configuration does.

A path is relative to the root. A package is found from the root as an `import` there would find it, its `exports` read under the import conditions, so a plugin published as ESM only loads, and so does a subpath such as `@descent-vtt/spec-harness/spec-brief-plugin`.

### Waiving a refusal

A plugin may also export `waive`, which lets the archive accept a change its own check allows - spec-harness's spec-brief plugin verifies a signed ruling for a protected path, which spec-brief does not know how to read.

```js
export default () => ({
  name: 'rulings',
  rules: [],
  // context: { root, brief: { id, file, text }, findings, base, commit }
  waive: async ({ findings }) =>
    findings
      .filter((f) => f.rule === 'protected-file' && verifiedRulingCovers(f.path))
      .map((f) => ({ rule: f.rule, path: f.path, reason: 'ruling R3, signed by alice, allows it' })),
});
```

- `findings` are the archive's refusals, as a frozen copy: a hook reads them and cannot change them, and a write to them throws.
- Two refusals can be waived, and no others: `protected-file`, one per file, which names its `path`; and `out-of-scope`, which refuses only under `--strict` and lists its `paths`.
- A waiver matches one of the plan's own refusals by rule and path and turns it into a `waived` note naming the plugin, the rule, the path and the reason. A waiver for any other rule is ignored with a `waiver-ignored` warning.
- The hook is asked only when the plan has a refusal it could lift.
- A hook that returns nothing waives nothing. One that throws - a write to `findings` included - or answers in another shape stops the run with exit 2, as a plugin that fails to load does.

## What it does not do

- **No status file.** There is no `manifest.json` to keep in step. A brief and the directory it sits in are the record; `list --format json` is the index, computed when asked. A committed index is also the one file every round merging in parallel edits.
- **No roadmap editing.** A roadmap is a document people write. spec-brief reports on briefs; it does not rewrite prose around them.
- **No git writes.** It reads commits, diffs and the working tree, and leaves staging and committing to whoever does them.
- **No labels as sections, yet.** Sections are headings. A repository that marks its sections with bold or bracketed labels instead, `**Your Mission:**` or `[STANDING DIRECTIVES]`, is not described by this version.

## Design

The decisions and what they cost are in [`docs/adr/`](https://github.com/DescentVTT/spec-brief/blob/main/docs/adr/README.md). Working on spec-brief itself: [CONTRIBUTING.md](https://github.com/DescentVTT/spec-brief/blob/main/CONTRIBUTING.md); reporting a vulnerability: [SECURITY.md](https://github.com/DescentVTT/spec-brief/blob/main/SECURITY.md).

## License

MIT
