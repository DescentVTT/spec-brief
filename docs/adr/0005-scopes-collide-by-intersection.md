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

## Amended 2026-09-26

The engine is spec-core's now (its ADR-0001 and ADR-0003): the `path`
dialect, compiled to a Thompson automaton, with a breadth-first witness search
over the automata's product. It is copied into `src/vendor/spec-core/` and
verified by hash, and spec-brief, spec-graph and spec-guard read one pattern
the same way. The dynamic programme above, and its brute-force test, went with
it; spec-core checks its engine against an oracle, brute force and the three
engines it replaced. What this repository checks against brute force now is
the scope arithmetic below (`tests/scope.test.ts`). Four decisions change.

**A literal's reading comes from the tree.** The extension was a guess, and it
guessed wrong both ways: `Dockerfile` has none, so it was read as a directory
and collided with `**/x.ts` through a `Dockerfile/x.ts` nobody can create;
`docs/v1.2` has one, so it was read as a file and every collision inside it
was missed. Now a path the tree holds as a file is that file, one it holds as
a directory is everything beneath it, and a path it does not hold is a file
unless it is written with a trailing `/`. A file is the reading that invents
nothing: a directory read as a file can only miss a collision, and the author
is told. `literal-read-as-file`, a note, names a literal the tree does not hold
and whose name has no extension - `src/newmod` - and says to write
`src/newmod/` for a directory. The spelling still decides whether to say
something; it no longer decides what the pattern means. Without a tree - the
library called with no files - every literal is a file, for the same reason.

Archival matches the files a round changed, and reads a literal as either: its
own path and everything beneath it. The paths are real files, nothing lies
beneath a file, so the reading cannot invent a match; and the tree has changed
since the scope was written, by the round itself.

**A collision witness is a file.** A trailing `/**` is at least one segment, as
`.gitignore` reads it, and a trailing `/` means the same. `docs/adr/**` against
itself names `docs/adr/x`, never `docs/adr`, and `src/**` no longer matches
`src`.

**Protection wins.** What a brief may write is its `affectedFiles` less its
`protectedFiles`. "All of `src/` except the schema" was a contradiction, and is
now written `affectedFiles: [src/**]` with `protectedFiles: [src/db/schema.ts]`.
`scope-contradiction` fires only for an affected pattern the protections cover
entirely - nothing of it is writable - decided by `globCovers`, and reports
every such pattern in one finding per brief. Two briefs collide where their
writable scopes meet: `globWitness([a, b], [...protected of both])` for each
pair of affected patterns, so a file either brief protects is one it will not
write, and no collision.

**Undecided is an answer.** The search is exact but has a budget, 200,000 search
states, so that a pathological pair costs seconds and not a hang: `*a` followed
by fourteen `?` against itself reaches it in about four seconds on the
workstation of ADR-0009, where scope patterns decide in a fraction of a
millisecond. A pair the search cannot decide is `collision-undecided`, a
warning, and never a collision or a clean pair; a pattern whose protection it
cannot decide is a `scope-contradiction` warning rather than an error.
