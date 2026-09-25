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
