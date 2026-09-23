---
status: accepted
date: 2026-09-24
---

# ADR-0005: Scopes collide by intersection

## Context

Two briefs in one wave collide when both can write one file. Scopes are
globs. Comparing them as strings, or by shared prefix, misses the collision
that matters: `src/auth/**` and `src/**/session.ts` share nothing a string
comparison sees and both cover `src/auth/session.ts`. One measured repository
keeps a "trees" column in its roadmap for exactly this question; 29 of its 61
live briefs were checkable from it at all.

## Decision

**Two globs are intersected.** A dynamic programme over segments, where `**`
absorbs zero or more of them, and within a segment over characters, where `*`
absorbs zero or more. It answers exactly, for the supported dialect, whether
some path matches both, and it returns one: a witness a reader can check by
eye. Completeness follows from a shortest-witness argument written at the
function, and the suite checks it against brute-force enumeration over a
seeded corpus of pattern pairs.

**Nothing compiles to a `RegExp`.** Matching and intersection cost the product
of their inputs' lengths. `*a*a*a*a*b` against a long name cannot backtrack
into an exponent - the hazard the sibling `spec-graph` measured in its
ADR-0017.

**A literal path names a directory, unless it names a file.** `src/auth`
covers everything beneath it. A path the tree tracks as a file, or one with an
extension, matches only itself: otherwise `src/a.ts` would collide with
`**/session.ts` through a `src/a.ts/session.ts` nobody can create. The first
version of the matrix did exactly that, on the suite's own corpus. A trailing
`/` always means a directory. False positives cost more than misses; a
collision report that cries wolf gets switched off.

**An unscoped brief is not a safe brief.** A brief in a shared wave with no
`affectedFiles` is reported as unscoped, a note, because it cannot be proved
apart from anything.

## Consequences

Negation (`!pattern`) and extended globs are refused rather than
approximated. A shared directory without a shared file is a separate rule, off
by default: it hints at semantic overlap and is not a merge conflict.
