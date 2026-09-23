---
status: accepted
date: 2026-09-24
---

# ADR-0006: The freeze lives in the file

## Context

An archived brief is a frozen record of the tree before a round. Editing it -
"fixing" a sentence that has gone stale - rewrites a record the ADRs and the
code already answer. One measured repository holds the freeze with a ledger of
hashes in a separate file, which each archival appends to.

## Decision

Archival writes `integrity: sha256-<hex>` into the brief's own front matter:
the hash of every line but that one, with CRLF and a byte-order mark
normalised away. `lint` reports an archived brief whose hash no longer
matches. Unarchiving removes it.

## Consequences

There is no shared ledger, so two rounds archiving in parallel edit disjoint
files. A checkout that converts line endings reads as unchanged; an edited
word does not. The hash stops accidents, not intent: whoever edits the text
can recompute it, and review is where intent is caught. A repository that does
not want the key turns `archiving.freeze` off.
