# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org).

## Unreleased

- Versions are published by CI through npm's trusted publishing, with
  provenance that names the commit and the run (ADR-0010).
- `archive` no longer passes a scope it never measured. With no `--commit`,
  `--base` or `archiving.base`, without git, or with a commit already in the
  base branch - where the diff from the merge base is empty - a brief that
  declares `affectedFiles` or `protectedFiles` gets `scope-unmeasured`, a
  warning that names the next step, and a refusal under `--strict`. It is the
  first archive rule, and configuration sets its severity like any other.
- An open box is closed only by a note under it that starts with a
  disposition marker. A marker anywhere in the item used to count, the box's
  own text included, so `- [ ] Explain why the **Rejected** designs failed`
  archived as dispositioned.
- `archiving.rewriteLinks: false` now holds for the links other briefs hold
  to a moving brief, which were rewritten regardless. Those left pointing at
  the old path are reported as `stale-link`, a warning naming each file and
  line, on `archive` and `unarchive` alike; `unarchive --strict` refuses on
  it, as `archive --strict` does.
- `matrix` reports two briefs whose scopes meet once, however many pairs of
  their patterns meet, and the finding lists every pair with a path both
  cover. A pair writing into several shared directories is likewise one
  `shared-directory` finding.
- JSON documents are `schemaVersion: 2`. In `matrix --format json` a
  collision carries `overlaps`, a list of `{ patterns, witness }`, in place of
  `patterns` and `witness`, and a `sharedDirectories` entry carries
  `directories` in place of `directory`.
- A plugin package whose `exports` offer only the `import` condition loads.
  Packages were resolved with `require.resolve`, which reads `exports` under
  the require conditions, so an ESM-only plugin could not be found.

## 0.1.0

The first release.

- `init`, `new`, `lint`, `list`, `matrix`, `archive` and `unarchive`.
- Configurable conventions: directories, file names, ids, status words,
  sections with aliases, order and required text, brief types, archival
  dispositions and the banner template. A configuration that does not load
  stops the run with exit 2.
- 22 lint rules and 3 collision rules, with severities set in configuration.
- Scope collisions by glob intersection, with a path both scopes cover.
- Archival as a planned transaction: preflight, banner, link rewriting in both
  directions, freeze hash, rollback on failure. Git is read, never written.
- Pretty, JSON, SARIF 2.1.0 and GitHub workflow-command output.
- Rule plugins, and a library API over a real or an in-memory filesystem.
- No runtime dependencies.
- Mutation testing in two sweeps: the core measured at 95.75% and gated at 93
  (ADR-0009); coverage 100% of lines.
