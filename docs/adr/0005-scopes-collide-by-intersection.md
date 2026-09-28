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

## Amended 2026-09-26: two stars in a name, and parentheses

spec-core cbe2223 changed two readings, and the copy took them
([ADR-0001](0001-no-runtime-dependencies.md), amended).

**`**` inside a name is refused.** `docs/**.md` was read as `docs/*.md`, as
gitignore, bash and minimatch read it; the tools the family replaced read it
three ways, and the quiet one-level reading dropped every nested document from
a scope that used to include them. A scope that silently narrows misses
collisions, so the pattern is an error, `glob` in `lint`, with the two
spellings it could have meant.

**A group is an extended glob only when it holds a `|`.** `+(a|b)` is refused
as before, with `{a,b}` as the way to write it; `C++(notes).md` and
`report(2017).md` are names with parentheses in them, as ripgrep and
`.gitignore` read them, where they used to be refused.

## Amended 2026-09-28: a trailing slash inside braces

spec-core f9ce375 reads a trailing `/` on a brace alternative as it reads one
on the whole pattern, and the copy took it
([ADR-0001](0001-no-runtime-dependencies.md), amended). `{src/newmod/,lib}`
was the literals `src/newmod` and `lib`, each read from the tree, so a
directory the tree did not hold yet was a file: the scope matched a
`src/newmod` nobody will create, a collision with a brief writing
`src/newmod/index.ts` was missed, and `literal-read-as-file` told the author
to write the trailing `/` they had written. Now the alternative is
`src/newmod/`, the directory's contents whatever the tree holds, never the
directory itself and never asked about - the decision above, that a trailing
`/` always means a directory, held inside braces too. A directory the tree
holds reads as it did, everything beneath it.

`literal-read-as-file` names the bare names alone, `lib` here, and a pattern
left with none the tree cannot place is `glob-matches-nothing`'s when it
matches nothing, as `src/newmod/` alone is. Archival, which reads a literal as
either, no longer takes a changed file at `src/newmod` itself as inside
`{src/newmod/,lib}`, as it never took one inside `src/newmod/`. The
alternative's base, which `shared-directory` compares, is `src/newmod`
whatever the tree holds, where it was `src` while the tree did not hold the
directory.

## Amended 2026-09-29: the note's advice inside braces

`literal-read-as-file` told the author of a bare name inside braces to write
a directory with a trailing `/`, in an entry of its own: the only way to say
one until the amendment above. Now its advice is the pattern as written with a `/`
ending each alternative it names, or each such alternative in an entry of
its own: for `lib/{util,new}` in a tree holding `lib/util` and not
`lib/new`, `lib/{util,new/}` for a directory, or `lib/new/`. It is built
from what was written, escapes and nested braces included, as spec-core
builds its advice for `**` inside a name, and the places a `/` goes are
checked against spec-core over a generated corpus: written where an
alternative ends, it changes that alternative alone.

Where more of the pattern follows braces, `{a,b}/new`, no `/` written inside
them ends one alternative alone, and the advice is an entry of its own,
`a/new/`. A pattern with a class is advised the same way: a class may hold a
brace or a comma, and spec-brief does not read classes to place a `/`. What
the note fires on is unchanged.

## Amended 2026-09-29: an alternative that names no path

spec-core 56c7e54 refuses a brace alternative that names no path, as it
refuses the same text written alone, and the copy took it
([ADR-0001](0001-no-runtime-dependencies.md), amended). Since the amendment
above, a trailing `/` on an alternative is the directory's contents, and
`{./,src}` read its `./` as the contents of `.`: every path, where `./`
alone is refused as naming the root. A scope that is every path collides with
everything; in `protectedFiles` it made each affected pattern entirely
protected, so `scope-contradiction` said nothing of the brief was writable
and pointed at the affected patterns, not at the protection. It is now `glob`'s error, `the braces expand to "./",
which names no path`, with `{src,./}`, `{.,src}/` and `.{/,src}`, which the
braces expand the same way. A refusal the glob already made names the
alternative: `{.,src}` is `"."`, and `{,src}` an empty pattern. An
alternative with a name in it reads as it did: `src/{./,a}` is `src/` or
`src/a`, and `{./a,b}` is `a` or `b`.

`writtenAlternatives`, which places the `/` of the note's advice, is checked
against spec-core again over a corpus with `.` and `./` among its atoms. At
f9ce375 it met patterns such as `{./a/,./}`, whose alternatives written alone
did not read as the pattern, since `./` alone was refused; spec-core refuses
them now, and on each pattern of the corpus it accepts the two agree.
