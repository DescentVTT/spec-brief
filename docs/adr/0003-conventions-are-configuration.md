---
status: accepted
date: 2026-09-24
---

# ADR-0003: Conventions are configuration

## Context

The schema in the commissioning brief - `id`, `title` and `wave` required in
front matter, "Commander's Intent" and "Negative Scope" sections - was a
design, not a measurement. Measured on 2026-09-24:

- **VirtualCortex** (`briefs/`, 1 live, 34 archived): front matter holds only
  `status: proposed` or `status: archived` and a `date`. The id is the file
  name's three-digit prefix. Eight `##` sections in a fixed order, from
  `Mission` to `Report`; the standing directives must restate one sentence.
  Archived deliverables are closed by a tick or by a note under the box, and
  the notes in the archive read `**Rejected** by ...`, not the `**Rejected:**`
  its README documents.
- **DescentVTT** (`specs/`, 61 live, 153 archived): no front matter at all.
  Sections are headings named `Item N - ...` beside bracketed labels such as
  `[STANDING DIRECTIVES]`; waves live in the roadmap.

No fixed schema describes both, and a tool that describes neither describes
nobody.

## Decision

Every convention the two disagree on is a key: where briefs live, which file
names are briefs, where the id comes from, the words for each status, the
sections with their aliases, order and required text, which boxes must close
at archival and what closes them, and the banner. The defaults describe the
commissioning brief's four parts - intent, negative scope, what the round is
not empowered to change, invariants - and `init` writes every default out, so
a repository edits a file rather than looking values up.

Section names compare after normalising what does not change meaning:
typographic quotes, emphasis, a leading number, a trailing colon, case. A
heading may qualify the name after a separator. Disposition markers match as
prefixes, so `**Rejected` covers both spellings found in the archive.

## Consequences

A copy of VirtualCortex's 35 briefs lints clean under a twenty-line
configuration, and three deliberately broken copies each produce the finding
expected: a missing section, sections out of order, and standing directives
that no longer restate their sentence. Archiving a ticked copy of its live
brief produced the banner shape, the link rewriting and the status its README
prescribes.

DescentVTT is **not** described by this version: its sections are labels, not
headings, and its waves are in a document rather than in the briefs. Label
sections are the next extension this ADR invites. The README records it as
open rather than claiming it.

## Amended 2026-09-26: deferred work

Splitting a goal into rounds leaves work that should wait: the second backend,
the scaling nobody needs yet. Written down nowhere, it is forgotten; written
as a live brief, it is scheduled; archived, it is recorded as done. So a
fourth status word, `status.deferred`, `"deferred"` by default and `null` for
a repository that has none, as `draft` is. A deferred brief lives in the briefs
directory, is never ready, runs in no wave - `matrix` and `schedule` list it
and leave it out - and `archive` refuses it as it refuses a draft.

A deferral must say what brings it back, in a built-in `trigger` field, and
what brings it back must be an event someone can observe: "when the second
tenant signs", "when p95 exceeds 200 ms". A date is not a trigger. It arrives
whether or not the reason for the work has, so a deferral dated "Q3" is a
reminder to decide again, which is what the deferral already was.
`deferral-trigger` refuses a missing trigger, a placeholder, and one made only
of words that say when: dates, quarters, months and weekdays, stretches of
time, and the small words that join them. The lists are short on purpose; a
time the rule reads as an event is a miss, which costs less than refusing an
event that looks like a date.

## Amended 2026-09-30: a trigger written in Chinese

The words that say when were read as runs of letters and digits split at
spaces and punctuation. Chinese is written without spaces, so `下個月` (next
month), `2026年10月` and `第三季` (the third quarter) were each one word that
was on no list, and passed as events. A trigger is now read in NFKC first,
so full-width `Ｑ３` is `Q3`, and a run of Han characters is a word of its
own, apart from the letters and digits beside it: `10月` is `10` and `月`.
A run says only when if taking out the time words - `星期`, `近期`, `稍後`
(later), `左右` (about) - and then the characters that say when or join
them - `年 月 日 週 季`, `今 明 下 上 第 前 後`, the numerals, `在 到 的 之` -
leaves nothing. Words come out before characters, since `稍後` is `稍`,
which says nothing about time, and `後`. Traditional and Simplified are
both listed.

The lists stay short on purpose, for the reason above. `時` and `期` are not
on them, so `到期時` (when it expires) is an event; nor are `每` (every) and
`當` (when), as `every` is not; and `過年後` (after the new year) is read as
an event, a miss. `當第二個租戶簽約時`, `月結完成後` (after the month-end
close) and `年度稽核通過後` (after the annual audit passes) pass.

The default placeholders gain `待定`, `未定`, `待補` and `待確認` (to be
decided, undecided, to be filled in, to be confirmed), with their Simplified
forms, and a full-width colon ends a placeholder as a colon does:
`待定：等廠商回覆` is a placeholder, `待定事項列在下方` is not.

## Amended 2026-09-30: English only

The maintainer chose to read English only: a small team maintains one
language, and a heuristic in a second language is where false positives
come from. A brief may be written in any language; the words spec-brief
reads for a time and for a placeholder are English. The amendment above
stays as the history of what was tried.

A trigger is read as runs of letters and digits again, with no NFKC step
and no runs of Han characters, so `下個月`, `2026年10月` and full-width `Ｑ３`
are words on no list and read as events: a miss, which the rule accepts.
The default placeholders are English again, and a full-width colon after a
placeholder is not a colon. A repository may still list `待定` under
`placeholders`, and it is then read as any placeholder is.

## Amended 2026-09-30: the stop after a placeholder

A placeholder was followed by nothing, or by a space, a colon, a dash or a
period and then anything. So `TBD.` was a placeholder and `TBD!` and `TBD?`
were not, while `TODO.md lists the open work.` was one, though it says
something. Now any stop that ends a sentence - `.`, `!`, `?`, `;`, `…` -
ends a placeholder as a period did, and a note may follow a space, a colon
or a dash after it, `TBD. Ask the vendor.`; a stop that goes on into a
word, `TODO.md`, is part of that word, and the line is content.
`deferral-trigger` refuses `TBD.` as the placeholder it is, where it passed
as an event; a note after a placeholder there is still the event itself.
A hyphen is read as a stop is: before a space or at the end of the line it
ends a placeholder, `TBD -`, `TBD - later`, and run straight into a word it
is part of that word, so `TODO-driven work is out.` and `XXX-large` are
content. An em dash joins no words, and `TBD—ask the vendor` stays a
placeholder.

## Amended 2026-10-19: a configuration that is not a file

The configuration was read with whatever stood under its name. Measured on
2026-10-19 through 0.9.0's launcher in a Linux container (`node:24-slim`,
Node 24.21.0), each case in a tree of its own with ten seconds to answer:

- A named pipe at `.spec-brief.json`, at `spec-brief.json`, named by
  `--config`, below the directory the run started in, or named by a link,
  had `list`, `list --format json` and `lint` wait until the limit ended
  them. A tool that asks spec-brief before each write, as spec-harness
  does, waited with it.
- A socket at `.spec-brief.json` ended the run on Node's `ENXIO` and a
  stack, and `--config /dev/zero` on `RangeError: Invalid string length`,
  each exit 2; `--config /dev/null` was read as JSON that ends at once.
- A directory was said in a line already
  ([ADR-0001](0001-no-runtime-dependencies.md), amended 2026-10-09), a link
  to a file was read as the file, and `--no-config` looked for none.

**Only a file is read as a configuration.** The path found or named is
asked what it is, following a link, before it is opened, and anything but
a regular file is a configuration that does not load: exit 2, one line, in
the words spec-harness 0.19.0 has for its own,

    spec-brief: .spec-brief.json: is neither a file nor a directory, not a configuration file

and a directory as before. A pipe a shell hands to `--config <(...)` is
one too. It was read, and its directory, `/dev/fd`, was the root, where no
briefs are, so the run ended on `briefs/ does not exist`, exit 2; it is
refused now as the pipe it is. No run that answered is refused. A file
replaced by a pipe between the question and the read is not held off.

Left as they are, and measured the same day: a template that is a named
pipe has `new` wait without end; a pipe among the briefs is no file to the
listing, and is not read.

## Amended 2026-10-24: a template, a plugin and a file a move replaces

The 2026-10-19 amendment left the template a named pipe could hold. Every
other path spec-brief opens from a value a repository gives was measured
with it on 2026-10-24, through 0.10.0's launcher in a Linux container
(`node:24-slim`, Node 24.22.1), each case in a tree of its own with ten
seconds to answer, and on Windows 11 (Node 24.22.1) where the host can make
the case:

- **The template `new` fills.** A named pipe, a link to one, and a link to
  `/dev/zero` had `new` wait until the limit ended it. A link to `/dev/null`
  was read as a template of no bytes, and `new` wrote a brief of no bytes,
  exit 0. A directory, or a link or a junction to one, ended the run on
  Node's `EISDIR` and a stack, and a socket on `ENXIO` and a stack. On
  Windows a `template` of `NUL` or `CON` names no file, and is said not to
  exist, as it still is.
- **What stands where a brief moves.** `archive` and `unarchive` read back
  each file a plan touches before they write any (ADR-0004), and a plan is
  made from the files a listing names, which a pipe, a socket, a directory
  and a link are not: the plan cannot see what stands at the path it would
  write. A named pipe there, or a link to one, had the run wait without end;
  a directory or a socket ended it on a stack. A link to a file there is a
  file the plan did not see, refused as one that changed after the plan was
  made, and still is.
- **A plugin.** A named pipe as a plugin's module, or a link to one, as the
  `package.json` spec-brief reads to find a package, or as the file its
  `exports` or its `main` gives, had `lint` wait without end. A socket ended
  on `ENXIO`, and a directory on Node's words for a directory import, which
  name spec-brief's own `dist/plugins.js`, each in a line.
- **Not affected.** The briefs and the archive are read through a listing
  that names regular files alone, so a pipe, a socket or a link among the
  briefs was not read, and a pipe where the briefs or the archive would be
  listed reads as no directory. A link a brief holds and a path its scope
  names are matched against the files git or a walk lists; no command opens
  one. Each of these answers as it did.

**Only a file is read.** `NodeFileSystem.read` asks what a path is,
following a link, before it opens it, and refuses anything but a regular
file; the configuration's read is that read now, in the configuration's own
words. Each refusal is exit 2, one line, nothing written. The template is
named as the configuration names it, and what stands where a brief would
move by its path:

    spec-brief: the template tpl.md is neither a file nor a directory; point "template" at a file, or set it to null
    spec-brief: briefs/archive/001_a.md is neither a file nor a directory; nothing was written. Move it out of the way, then run the command again.
    spec-brief: ./plugin.mjs: could not be loaded: /repo/plugin.mjs is neither a file nor a directory; only a file is read

and `is a directory` for a directory. The transaction refuses it while it
reads back, before its first write, as it refuses a file that changed. A
plugin's module, and each `package.json` spec-brief reads to find one, are
asked the same before Node imports or spec-brief reads them.

A brief the listing has just named a file is read without the question,
whose answer the listing's types already gave. Asked of every read, it cost
`list --archived --format json` over 200 briefs 12 to 38 ms more on
Windows, medians of ten in each of five runs with the two builds taking
turns (228 to 262 ms under 0.10.0, `node -e 0` 58 to 65 ms). Left to the
listing, the two builds' medians differ by -34 to +28 ms over eight such
runs, as noise does, and `list` asks the disk what 0.10.0 asked: the
recorder of ADR-0002's 2026-10-19 amendment holds that only the
configuration is asked what it is. A file replaced by a pipe between the
listing, or the question, and the read is still not held off.

One run that answered now refuses: a template that is a link to
`/dev/null`, which wrote a brief of no bytes. Every other case that
answered gives the bytes it gave under 0.10.0 on stdout and stderr,
`list --format json` and its `inputs` among them.

Left as they are, measured the same day:

- **What Node reads to import a plugin.** Node's resolution algorithm
  looks up the package scope of a module whose name ends in none of `.mjs`,
  `.cjs`, `.json` and `.wasm`, the nearest directory above it that holds a
  `package.json`, and reads that file to learn the module's type
  ([nodejs.org/api/esm.html](https://nodejs.org/api/esm.html), *Resolution
  Algorithm Specification*, `ESM_FILE_FORMAT` and `LOOKUP_PACKAGE_SCOPE`,
  read 2026-10-24). A `.js` plugin below a `package.json` that is a named
  pipe still has `lint` wait; an `.mjs` one does not. That file is no path
  spec-brief names, and asking it would mean following Node's lookup, which
  turns on the module's extension. A plugin's code runs with the trust the
  repository gives it (ADR-0007, *Consequences*).
- **`archive --dry-run`** where a pipe stands at the brief's new path prints
  the plan and exits 0: the plan is made from the listing, and the run that
  writes refuses.
- **A template outside the repository**, `"template": "../tpl.md"`, ends the
  run on `"../tpl.md" is outside the repository` and a stack, exit 2, with
  nothing written and no wait.
- **A pipe under the briefs directory's name** has `init` and `new` end on
  `EEXIST` and a stack, and one under the archive's has `archive` end on
  `ENOTDIR` and a stack, each exit 2 with no wait.
