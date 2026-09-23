---
status: accepted
date: 2026-09-24
---

# ADR-0002: The brief is the record

## Context

The brief that commissioned this tool asked for a `specs/manifest.json` index
of every brief's status, updated on each archival, and for a roadmap table
rewritten in place. It also described a state machine with a persisted
`Archiving` state between `Active` and `Closed`.

Both repositories measured while designing it keep their state elsewhere. One
says in its brief directory's README, in as many words, "Do not add a status
file here": outcomes live in ADRs, the changelog and the code. The other keeps
its waves in a hand-written roadmap whose tables are argued over in prose.

And the index has a structural problem that the commissioning brief itself
names as the reason the tool exists: parallel rounds. Every round that
archives edits the one index. Two rounds merging in parallel conflict on it
every time, over a file whose every line is derivable from the briefs.

## Decision

**A brief and the directory it sits in are the only record.** Location decides
whether a brief is archived. A status field, where a repository keeps one,
must agree with the location, and `lint` reports when it does not.

**Indexes are computed, not stored.** `list --format json` is the manifest,
produced when asked. Nothing is written that could fall out of step.

**No persisted intermediate state.** Archival is a transaction
([ADR-0004](0004-archival-is-a-planned-transaction.md)). A file that says
"archiving" after a crash would be a second thing to recover; a transaction
that stops half-way is rolled back instead.

**No roadmap editing.** A roadmap is a document people write. Rewriting a
table inside it means owning its format, and a generated table beside a
hand-written one is two documents describing one plan.

## Consequences

A consumer in another language runs `spec-brief list --format json` instead of
reading a file. A repository that wants a committed index can write one from
that output in its own pipeline, and owns the conflicts that come with it.
