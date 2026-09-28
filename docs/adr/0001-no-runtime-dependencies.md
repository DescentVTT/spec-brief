---
status: accepted
date: 2026-09-24
---

# ADR-0001: No runtime dependencies

## Context

spec-brief runs in CI next to the credentials a pipeline holds, and in agent
harnesses that act on what a brief directory says. 2025 made the cost of a
dependency tree concrete: packages with billions of weekly downloads were
published with credential-stealing payloads, and a self-replicating worm
spread through maintainers' tokens. A tool that a security team has to audit
before it runs is a tool that does not get installed.

It needs four things a dependency would ordinarily provide: a front-matter
reader, a Markdown scanner, a glob matcher, and argument parsing.

## Decision

`dependencies` is empty, and `tests/source.test.ts` holds it empty and holds
every import in `src/` to a relative path or a `node:` module.

- **Front matter** is read by `src/frontmatter.ts`, a reader for the flat
  subset briefs use. Anything beyond it - nested mappings, block scalars,
  anchors - is reported as unsupported rather than guessed at. A YAML library
  would parse more and would not return the line of each value, which is what
  a finding needs, and what an edit that must leave every other line
  untouched needs.
- **Markdown** is scanned by `src/markdown.ts`, which is not a CommonMark
  parser. It must be exactly right about what is code and what is a comment,
  and is deliberately simple about the rest.
- **Globs** are matched by `src/glob.ts`, which also decides whether two globs
  can meet ([ADR-0005](0005-scopes-collide-by-intersection.md)). No matcher on
  npm does the second.
- **Arguments** are parsed by `node:util`'s `parseArgs`.

## Consequences

About 3,000 lines this repository owns and maintains instead of a dependency
list. The front-matter reader refuses YAML a general parser would accept; a
repository that writes nested front matter gets a finding, not a silent
misreading. The sibling tools `spec-graph` and `spec-guard` made the same
decision for the same reason, and their dialect decisions were read before
these were written.

## Amended 2026-09-26

The glob engine is spec-core's `pattern` module, with the `path` module it
imports, copied byte for byte into `src/vendor/spec-core/` (spec-core
ADR-0001). A copy is not a dependency: `dependencies` stays empty, every
import is still relative, and a test hashes each copied file against
`VENDOR.json`, so the copy changes only by a diff someone reviews. It is never
edited here; it changes in spec-core and is copied again. `src/glob.ts` keeps
what is spec-brief's own - the refusals, the reading of a literal from the
tree ([ADR-0005](0005-scopes-collide-by-intersection.md)) - and the 0.1
functions of the library, over the new engine.

## Amended 2026-09-26: Markdown and front matter

The Markdown scanner and the front-matter reader are spec-core's `markdown`
module, with the `text` module it imports, copied beside the glob engine at
spec-core 4f2826a and verified by hash in the same way. spec-core is exact,
as CommonMark is, about what is code and what is a comment - indented code,
raw-text HTML, code spans that close on a later line, a `<!--` that opens
nothing ([spec-core ADR-0004](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0004-markdown-structure.md)) -
and one scanner is one set of answers for the family. Its differential test
runs 0.1's scanner and reader beside it and names every difference.
`src/markdown.ts` and `src/frontmatter.ts` are adapters over it, in a brief's
0-based lines, and keep what is spec-brief's to decide:

- **A section is an ATX heading outside a block quote**, and so is the title.
  A setext underline is `---`, which briefs write as a rule between parts. Read
  as a renderer reads it, the prose above the rule becomes a heading and stops
  being content, a filled section reads as empty, and a section no author
  wrote is checked for order and duplicates. A heading in a block quote is
  quoted from another document, and as a section it would split the one it is
  quoted in. Both would be false positives, which cost more than the misses
  of a brief that really writes its sections that way.
- **A task is a list item outside a block quote with `[ ]`, `[x]` or `[X]`**,
  the boxes GFM renders. spec-core also reads `[~]`, `[?]`, `[-]` and others,
  which mean nothing to a reader of the rendered brief, and a quoted list is
  another document's, whose open box would refuse this brief's archival.
- **The links archival rewrites are the ones that write a destination**:
  inline links and images, and definitions, rewritten between their
  `targetStart` and `targetEnd`. A reference is rewritten through its
  definition, once. A link inside a link's text is the link, as CommonMark
  reads it: in `[a [b](b.md)](c.md)` archival rewrites `b.md` and leaves
  `(c.md)`, which a renderer shows as text. An image inside a link's text,
  `[![d](d.png)](d.md)`, is a destination too, and spec-core lists it after
  the link. spec-core reads nothing in an image's alt text or a wiki link's
  text, so the adapter reads those two again for their links and images,
  and finds each destination once. A definition is one CommonMark reads: it
  opens a paragraph or follows another, and its label holds no unescaped
  bracket. The shape of one under a paragraph's text is that text, and so is
  the shape of one in alt text or a wiki link's text, which the adapter,
  reading that text on its own, would take for a definition opening a
  document. The round trip - archive, then unarchive, gives the bytes back -
  stays the oracle. *Amended 2026-09-27*: spec-core took the outer pair of a
  link inside a link as the link, and the adapter read every link's text
  again to find the inner one, so archival rewrote both destinations.
  *Amended 2026-09-28*: spec-core read a definition at the start of any line
  and under any label, and the adapter kept one it found in alt text read
  again, so archival rewrote text a renderer shows as written.
- **A brief's lines end at LF and CRLF only.** The freeze hash is taken over
  them, and a sealed brief must keep its hash. spec-core also ends a line at a
  lone CR, so the adapters hand it one as a space, and every line and column
  it reports is the brief's.
- **Front matter is written only when it is YAML and closed.** spec-core
  recognises TOML between `+++` lines and reports it as a problem; `schedule
  --write`, `archive` and `unarchive` refuse, as `front-matter`, to write into
  TOML or into a block never closed, instead of prepending a second block or
  stopping with an error.

Everything else follows the scanner, and the changelog lists each change a
user can see. Measured on the day, `lint --format json` and `list --format
json` are unchanged on this repository's briefs and on 149 Markdown documents
from the five spec-* repositories read as briefs, and archiving then
reopening each of those rewrites the same links and returns the same text as
0.1 did; the differences appear on the inputs written to show them. The two
modules went from 673 lines to 184.

## Amended 2026-09-26: copied again at cbe2223

The copy was taken again at spec-core cbe2223, with spec-core's `LICENSE`.
The package carries the compiled copies under `dist/vendor/spec-core/`, which
are spec-core's code under MIT, so its notice ships too: `files` names it, and
`tests/vendor.test.ts` and spec-core's `vendor.mjs --check` both require it.
Two of the changes are about globs ([ADR-0005](0005-scopes-collide-by-intersection.md),
amended). The third is the scanner's: a list item's text starts at its content
column, and indented code inside an item starts four columns past it, where
four columns anywhere in a list used to be the item's text. A fence line that
deep is code, or paragraph text, and opens no fence that would hide the rest
of the brief.

## Amended 2026-09-27: copied again at 119345e

The copy was taken again at spec-core 119345e. Two of its changes reach a
user. A link inside a link's text is read as CommonMark reads it, the inner
pair the link and the brackets around it text, so archival rewrites the
inner destination and leaves the outer one as written, and the adapter no
longer reads a link's text again (the note on links above). The refusal of
`**` inside a name writes its advice from the pattern written: `docs/**.md`
is told `docs/**/*.md` or `docs/*.md`, where every such pattern was told
`docs/**/*.md` or `*.md`. The scan's new `unclosedFrontMatter` and
`Block.tag` are not read: the front-matter reader already reports a block
never closed, which is what `front-matter` refuses to write into.

## Amended 2026-09-28: copied again at 65ef842

The copy was taken again at spec-core 65ef842, which reads a link reference
definition where CommonMark does (the note on links above). A definition
cannot interrupt a paragraph: `[r]: r.md` on the line under a paragraph's
text is that text, and archival leaves it as written. A label holds no
unescaped bracket and at most 999 characters: `[[r]: r.md](z.md)` is a link,
and archival rewrites `z.md`, where it rewrote `r.md](z.md)` as the
destination of a definition; `[a\]b]: x.md` is a definition now, and `x.md`
moves with the brief. References follow the definitions, so the brackets
around them read as a renderer shows them.

The adapter drops a definition it finds in alt text or a wiki link's text
read again, and with it the map that kept a destination found twice. The
one such destination was a definition spec-core listed inside alt text
written over lines, and spec-core lists none there now, since no bracket
pairs across a definition's line. Side by side over 600,000 random
documents, the destinations archival rewrites differ from 0.2.3's by these
readings and the brackets around them alone, and none is found twice.

## Amended 2026-09-28: copied again at f9ce375

The copy was taken again at spec-core f9ce375, and two of its changes are
about globs. A trailing `/` on a brace alternative means that directory's
contents, as one on the whole pattern does, so `{src/newmod/,lib}` reads as
`src/newmod/` and `lib` each read alone
([ADR-0005](0005-scopes-collide-by-intersection.md), amended). A pattern that
compiles to more than 65,536 states is a refusal spec-core returns, where it
threw `AutomatonTooLarge` and `src/glob.ts` caught it; the catch went, and
the `glob` finding reads as it did, since the reason is the message the
exception carried. Every other change in the copy is a comment.
