# spec-brief

**Lint the contract a round of work runs under, map which rounds can run side by side, and archive a finished one in one atomic command.**

A *brief* is the input to one round of work - for a coding agent or a person: what done looks like, what the round must not touch, and the checks that prove it finished. spec-brief manages briefs as files in your repository. It has no runtime dependencies, reads and writes nothing but Markdown in two directories, and never writes to git.

```bash
npm install --save-dev @descent-vtt/spec-brief
npx spec-brief init
npx spec-brief new "Rotate session tokens on privilege change" --wave 1
npx spec-brief lint
```

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

Work put off for later is a brief too, with `status: deferred` and a `trigger` naming the event that brings it back - "when the second tenant signs", "when p95 exceeds 200 ms", never a date. A deferred brief stays in the briefs directory, is never ready, and runs in no wave until someone sets it `active`.

The id comes from the file name (`012_rotate-session-tokens.md`) or from an `id` field. `affectedFiles` is the scope the round may write; `protectedFiles` is what it is not empowered to change, and archival refuses a round that changed it. Protection wins: what a round may write is `affectedFiles` less `protectedFiles`, so "all of `src/` but the schema" is `affectedFiles: [src/**]` with `protectedFiles: [src/db/schema.ts]`.

Scopes are globs in spec-core's `path` dialect, the one every spec-\* tool reads: `*`, `?`, `[a-z]` and `{a,b}` within a name, `**` for any number of directories, compared case-sensitively on every host. A trailing `/**` or `/` is a directory's contents - at least one name below it, never the directory itself. A path with no glob syntax is read from the tree: a file the tree holds is that file, a directory it holds is everything beneath it, and a path it does not hold yet is a file unless it ends in `/`. Write `src/newmod/` for a directory the round creates; `lint` notes a bare `src/newmod` it cannot place.

## Commands

### `spec-brief init`

Writes `.spec-brief.json` with every default spelled out, and creates the brief and archive directories. `--briefs <dir>` and `--archive <dir>` choose them.

### `spec-brief new <title>`

Scaffolds a brief with the next free number - one more than the highest id, live or archived, since ids are never reused - and every required section, each holding its `hint` in a comment. A comment is not content, so a fresh brief reads as unwritten until someone writes it. `--id`, `--type`, `--wave`, `--depends-on 7,8` and `--date` fill the front matter.

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

Live briefs with their status, wave, task count and readiness. A brief is *ready* when every brief it depends on is archived, and it is neither a draft nor deferred. `--ready` shows only those, which is the question an orchestrator asks; `--archived` includes the archive; `--format json` gives an orchestrator the whole table, and the sections the configuration asks for, each with its `hint`.

### `spec-brief matrix`

Compares the `affectedFiles` of every pair of live briefs in the same wave, `--all-waves` for every pair. Deferred briefs are listed and left out.

```text
wave 1 · 3 briefs
       001  002  003
  001    ·    X    ·
  002    X    ·    ·
  003    ·    ·    ·
  X 001 "src/auth/**" and 002 "src/**/session.ts" both cover src/auth/session.ts
  ? 003 declares no affectedFiles and cannot be checked
```

Scopes are intersected as globs, not compared as strings: the two above share no prefix and still meet, and the file named is one both patterns match and neither brief protects - always a file, never a directory. Two briefs whose scopes meet in several places are one collision, listing every pair of patterns that meets. A brief with no scope is reported as unscoped rather than counted as safe. The search for a shared file has a budget; a pair it cannot decide within it is marked `?` and reported as `collision-undecided`, a warning, never as a collision and never as clean. Exit 1 on a collision.

### `spec-brief schedule`

Computes the waves the live briefs can run in, drafts included, and sets each beside the wave it declares. A brief runs after every dependency that is still live - an archived one is done - and shares a wave with no brief whose writable scope meets its own. Briefs are taken in dependency order, ties broken by id, and each goes into the lowest wave that is after its dependencies and holds nothing it collides with. A brief with no `affectedFiles` cannot be proved apart from anything, so it runs in a wave of its own and is reported as `unscoped`. The first wave is the lowest any brief declares, or 1.

```text
wave 1 · 2 briefs
  001  Rotate session tokens
  003  Audit log            moves from wave 2
         nothing holds it later
wave 2 · 1 brief
  002  Store sessions       moves from wave 1
         not wave 1, where 001 also writes src/auth/session.ts ("src/**/session.ts" and "src/auth/**")

waits: 007 on 006, which is deferred
deferred: 006
2 briefs would move; "spec-brief schedule --write" writes the waves
```

Each move says why: the dependency that sets the earliest wave, and for every wave passed over, the brief there and the file both would write. A deferred brief, and one that waits on it, is placed nowhere; a dependency cycle is an error, and nothing in or after it is placed. `--write` sets `wave` in the front matter of each brief whose wave changes - every other line as it was, in one transaction - and writes nothing over a cycle. `--format json` gives an orchestrator the waves, each brief's declared and proposed wave with the reasons, and what waits on what; `sarif` and `github` carry a `wave-schedule` finding per move.

Exit 0 when the declared waves already hold, 1 when they would change or the dependencies form a cycle, 2 when the run cannot be trusted. The result is the same every time for the same briefs. It is a valid schedule, not always the shortest: no fast method promises the fewest waves, and a person can always move a brief later by hand, which `lint` and `matrix` then check.

### `spec-brief archive <brief>`

Closes a round. Refused, with every reason, when:

- the brief has lint errors, is a draft, or depends on a brief that is still live;
- a task item is neither ticked nor dispositioned - an open box counts as closed when a note under it starts with one of the `dispositions` (`**Delegated`, `**Accepted debt`, `**Rejected` by default), a note being a line of the item, bare or as a bullet, above any box nested in it;
- the working tree holds uncommitted work outside the brief directories (`--allow-dirty` to proceed);
- the round's commit changed a file in `protectedFiles`.

Changes outside `affectedFiles` are a warning, and an error under `--strict`. A scope is never passed by checks that measured nothing: when the files the round changed are unknown - no `--commit`, `--base` or `archiving.base`, `--no-git`, or a commit already in the base branch, as on `main` after the merge - a brief that declares one gets `scope-unmeasured`, a warning, and a refusal under `--strict`. Otherwise it writes the archived brief with its status set, a frozen banner under the front matter, every relative link rewritten for the archive directory, and an `integrity` hash; rewrites the links other live briefs hold to it; and removes the original. With `archiving.rewriteLinks` off, no link is rewritten, and the links other live briefs are left holding are reported as `stale-link`. `--commit <rev>` records the commit and the files it changed; `--base <rev>` measures from the merge base instead, for a branch of several commits; `--pr <n>` links the pull request; `--summary <text>` is what the round did, in the banner. `--dry-run` prints the plan and the banner and writes nothing. Archiving an archived brief does nothing and exits 0.

spec-brief reads git and never writes it. Review the change and commit it with the round.

### `spec-brief unarchive <brief>`

Reopens an archived brief: the banner and the hash come off, the status goes back to the live word, and the links are rewritten again. A brief archived and reopened is the brief it was, blank lines and final newline included, with two exceptions: the status line is written in its plain spelling, and a relative link that had to be rewritten comes back in its shortest form (`./b.md` returns as `b.md`).

### Every command

`--root <dir>` runs from another directory. `--config <file>` names the configuration; `--no-config` uses the defaults. `--format` is `pretty`, `json`, `sarif` or `github` where the command reports findings. `--strict` makes warnings fail the run. `--no-git` leaves git out even inside a repository: the tree is read from disk, and `archive` records no commit. `--color` and `--no-color` override `NO_COLOR`, `FORCE_COLOR` and the terminal check. `--help` and `--version` do what they say.

**Exit codes:** `0` clean, `1` findings, a collision, or a refused action, `2` the run could not be trusted - a bad flag, a configuration that does not load, a brief that does not exist. A run over a briefs directory that does not exist exits 2, because a check over nothing looks exactly like a clean one.

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
| `status` | `{ "field": "status", "draft": "draft", "active": "active", "deferred": "deferred", "archived": "archived" }` | The words a repository uses. `field: null` reads status from location alone; `draft` and `deferred` may be `null` where a repository has no such word. |
| `sections` | Intent, Negative Scope, Not Empowered (optional), Invariants (checklist) | Sections every live brief carries: a name, or `{ name, aliases, mustContain, checklist, optional, hint }`. `hint` says what the section must answer: a new brief carries it as a comment under the heading, a finding that the section is missing or unwritten gives it as the next step, and the JSON of `list` and `lint` reports it, so a tool helping to write a brief can ask for each section by what it is for. |
| `sectionOrder` | `false` | Sections must appear in the listed order. |
| `types` | `feature`, `defect`, `refactor`, `chore` | Brief types and the sections each adds. |
| `placeholders` | `TBD`, `TODO`, `FIXME`, ... | Words that mark a section as unwritten. |
| `fields` | `[]` | Front-matter keys the repository uses beyond the built-in ones. |
| `archiving.tasks` | `"all"` | `"all"`, or the sections whose boxes must be closed. |
| `archiving.dispositions` | `**Delegated`, `**Accepted debt`, `**Rejected` | What a note under an open box starts with to close it. |
| `archiving.banner` | see [`src/config.ts`](src/config.ts) | Banner lines, with `{date}`, `{summary}`, `{pr}`, `{commit}`, `{diffstat}`, `{links}`, `{id}`, `{title}`, `{author}`. A line with an empty placeholder is left out. |
| `archiving.rewriteLinks` | `true` | Rewrite relative links when a brief moves: its own, and the ones other live briefs hold to it. Off, neither is edited, and the links other briefs are left holding are reported as `stale-link`. |
| `archiving.freeze` | `true` | Write an integrity hash, so a later edit is caught. |
| `archiving.base` | `null` | Branch the diff is measured from, such as `"main"`. |
| `rules` | `{}` | Severity per rule: `off`, `note`, `warning` or `error`. |
| `plugins` | `[]` | Modules that contribute rules: a path or package, or `{ module, options }`. |

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

Section names compare without case, typographic quotes, emphasis, a leading number or a trailing colon, and a heading may add a qualifier after a separator: `## 2. Commander’s Intent:` fills `Commander's Intent`, and `## Invariants (must hold)` fills `Invariants`.

## Rules

<!-- rules:start -->
| Rule | Default | Reports |
| --- | --- | --- |
| `front-matter` | error | Front matter that does not parse, a duplicate key, YAML beyond the flat subset. |
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
| `deferral-trigger` | error | A deferred brief with no `trigger`, or one that is only a date or a time - `2026-10`, `Q3`, `next month`, `October` - or a placeholder, rather than an event such as "when the second tenant signs". |
| `glob` | error | A scope pattern spec-brief cannot read. |
| `scope-contradiction` | error | Patterns in `affectedFiles` that `protectedFiles` cover entirely, so nothing of them is writable - one finding per brief, naming each. A pattern the search cannot decide is a warning. |
| `glob-matches-nothing` | note | A scope pattern that matches no file git sees, tracked or untracked - expected when the round creates it. |
| `literal-read-as-file` | note | A path with no glob syntax that the tree does not hold and whose name has no extension, such as `src/newmod`: read as a file, and `src/newmod/` if a directory was meant. |
| `archive-freeze` | error | An archived brief that changed after it was archived. |
| `collision` | error | Two briefs in one wave whose scopes can name the same file (`matrix`). |
| `collision-undecided` | warning | Two briefs in one wave whose collision the search could not decide within its budget (`matrix`), or a wave `schedule` passed over for it. |
| `unscoped` | note | A brief sharing a wave that declares no scope (`matrix`), or one `schedule` runs alone. |
| `shared-directory` | off | Two briefs in one wave writing into the same directory (`matrix`). |
| `wave-schedule` | error | A brief whose declared wave is not the one `schedule` computes, with the reason (`schedule`). |
| `scope-unmeasured` | warning | A brief with a scope archived without the files its round changed, so nothing checked the scope (`archive`). |
| `stale-link` | warning | Links in live briefs left pointing where a brief used to be, when `archiving.rewriteLinks` is off (`archive`, `unarchive`). |
<!-- rules:end -->

`archive` refuses with its own reasons - `open-task`, `archive-draft`, `archive-deferred`, `dependency-open`, `dirty-tree`, `protected-file`, `out-of-scope`, `archive-exists` - which are not lint rules: they are about whether this round is done, not whether the brief is well written. The rules marked `archive` above are raised by archival too, and configuration sets their severity like any other.

## In CI

```yaml
- run: npx spec-brief lint --format github
- run: npx spec-brief matrix --format github
- run: npx spec-brief schedule --format github
```

`github` writes workflow commands, which annotate the pull request with no upload and no permission. `sarif` writes SARIF 2.1.0 for code-scanning upload. `json` is a versioned document for anything else: `schemaVersion` changes when a field changes meaning, and is 2 since a collision became a pair of briefs rather than a pair of patterns.

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

A plugin is a module that exports `{ name, rules }`, or a function of its configured options that returns one. Its rules run beside the built-in ones as `<name>/<rule>`, and configuration sets their severity like any other.

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

This is where integrations belong. A tool that defines a format - signed departures, recorded reproducers, a code graph's blast radius - is the one that can check it, and spec-brief carries no copy of formats it does not own. Loading a plugin runs its code, exactly as loading a linter configuration does.

A path is relative to the root. A package is found from the root as an `import` there would find it, its `exports` read under the import conditions, so a plugin published as ESM only loads.

## What it does not do

- **No status file.** There is no `manifest.json` to keep in step. A brief and the directory it sits in are the record; `list --format json` is the index, computed when asked. A committed index is also the one file every round merging in parallel edits.
- **No roadmap editing.** A roadmap is a document people write. spec-brief reports on briefs; it does not rewrite prose around them.
- **No git writes.** It reads commits, diffs and the working tree, and leaves staging and committing to whoever does them.
- **No labels as sections, yet.** Sections are headings. A repository that marks its sections with bold or bracketed labels instead, `**Your Mission:**` or `[STANDING DIRECTIVES]`, is not described by this version.

## Design

The decisions and what they cost are in [`docs/adr/`](docs/adr/README.md).

## License

MIT
