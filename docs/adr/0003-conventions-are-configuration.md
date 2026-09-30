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
