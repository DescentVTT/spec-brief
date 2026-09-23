# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org).

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
