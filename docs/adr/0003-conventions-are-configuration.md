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
