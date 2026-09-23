---
status: active
date: 2026-09-24
type: feature
wave: 1
affectedFiles: [src/markdown.ts, src/brief.ts, src/rules.ts, src/config.ts, schema.json, tests/**, README.md, docs/adr/**]
protectedFiles: [src/glob.ts, src/apply.ts, src/archive.ts]
---

# 001 - Sections marked by labels, so a brief with no headings can be described

## Intent

A repository whose briefs mark their parts with a bold or bracketed label on a
line of its own - `**Your Mission:**`, `[STANDING DIRECTIVES]`,
`[ARCHITECTURAL EMPOWERMENT]` - can be described by configuration, and lints
clean where its own checker passes. Measured on 2026-09-24, DescentVTT's
`specs/` holds 61 live briefs written this way and cannot be described by
0.1.0, which reads only headings
([ADR-0003](../docs/adr/0003-conventions-are-configuration.md)).

## Negative Scope

- No change to how headings are read: a repository described today lints the
  same after this round.
- No reading of waves or trees from a roadmap document. Waves stay in front
  matter ([ADR-0002](../docs/adr/0002-the-brief-is-the-record.md)).
- No regular expressions in configuration. A label is literal text, compared
  after the same normalisation a heading gets.

## Not Empowered

- The glob engine, the transaction and the archival planner: this round is
  about reading sections, and none of them read sections.
- No runtime dependency, and no Markdown parser from npm.

## Invariants

- [ ] `npm run lint`, `npm test`, `npm run build` and `npm run selfcheck` pass.
- [ ] Coverage stays above its floors and the mutation score above its `break`.
- [ ] A label inside a fenced block or a comment is not a section; a test says so.

## Acceptance Criteria

- [ ] A section rule can name a label instead of, or beside, a heading, and
      the section runs to the next label or heading at its level.
- [ ] A copy of DescentVTT's live briefs, under a configuration written for
      it, reports the same briefs missing an empowerment block as its own
      `empowerment` check, and no others.
- [ ] A new ADR at the next free number (`ls docs/adr`) records the decision,
      including what a label may not be.
