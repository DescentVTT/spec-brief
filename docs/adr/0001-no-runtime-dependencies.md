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
  definition, once. An image inside a link's text, `[![d](d.png)](d.md)`, is
  a destination too; spec-core reads the link and resumes after it, so the
  adapter reads the link's text again until spec-core reports it. The round
  trip - archive, then unarchive, gives the bytes back - stays the oracle.
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
