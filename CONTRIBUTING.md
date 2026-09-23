# Contributing

## Getting started

```bash
npm install
npm test          # vitest
npm run lint      # tsc --noEmit, strict
npm run build     # emits dist/
npm run selfcheck # spec-brief lints its own briefs
```

Node 22 or later. There are no runtime dependencies and no build step for the
tests: Vitest reads `src/` directly.

## The pipeline

```text
files -> brief.ts -> corpus.ts -> rules.ts / collisions.ts / archive.ts -> report.ts
         one file    all files    findings, the matrix, a plan              render
```

| Module | Responsibility |
| --- | --- |
| `text.ts` | Lines, line endings, section-name normalisation, slugs, templates. |
| `frontmatter.ts` | The flat YAML subset: read with lines, edit one key without touching the rest. |
| `markdown.ts` | What is code or a comment; headings, sections, task items and their continuations, link destinations. |
| `glob.ts` | Parsing, matching and intersecting globs, by dynamic programming. |
| `links.ts` | Relative paths, and rewriting links when a file moves. |
| `schema.ts` | A small schema language that validates and renders JSON Schema. |
| `config.ts` | What configuration may say, the defaults, and loading. |
| `brief.ts` | One brief: id, status, fields, sections, tasks, banner. |
| `corpus.ts` | Every brief; finding one; dependencies, readiness, cycles. |
| `rules.ts` | The built-in rules. |
| `lint.ts` | Running rules and plugins with configured severities. |
| `collisions.ts` | The collision matrix. |
| `integrity.ts` | The freeze hash. |
| `archive.ts` | Planning archival and its reverse. |
| `apply.ts` | Executing a plan as a transaction. |
| `scaffold.ts` | New briefs and the next id. |
| `report.ts` | Pretty, JSON, SARIF and GitHub output. |
| `fs.ts`, `git.ts`, `plugins.ts` | The edges: the disk, git, and loading plugins. |
| `engine.ts` | The pieces composed over a real or an in-memory repository. |
| `cli.ts` | Arguments, dispatch, exit codes. |

## Adding a rule

Add it to `RULES` in `src/rules.ts` with an id, a default severity and a
description, add a row to the table between the markers in `README.md`
(a test checks the two agree), and add a test for the case that fires and the
case that must not.

## Commits

Conventional Commits, with a body that says why. Never commit on `main`
directly once the repository takes pull requests.
