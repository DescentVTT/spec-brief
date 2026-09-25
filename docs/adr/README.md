# Architecture decision records

One file per decision, numbered in order, never renumbered. A decision that
changes is superseded by a new record that says so; the old one keeps its text.

| ADR | Decision |
| --- | --- |
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies: the front-matter reader, the Markdown scanner and the glob engine are written here. |
| [0002](0002-the-brief-is-the-record.md) | The brief is the record: no status file, no manifest, no roadmap editing, no persisted intermediate state. |
| [0003](0003-conventions-are-configuration.md) | Conventions are configuration, measured against two repositories that keep briefs; amended with a status for deferred work and its observable trigger. |
| [0004](0004-archival-is-a-planned-transaction.md) | Archival is a planned transaction over files; git is read, never written. |
| [0005](0005-scopes-collide-by-intersection.md) | Scopes collide by glob intersection, with a witness; amended for spec-core's engine: a literal is read from the tree, a witness is a file, protection wins, and undecided is an answer. |
| [0006](0006-the-freeze-lives-in-the-file.md) | The freeze is a hash in the archived brief's own front matter, not a ledger. |
| [0007](0007-integrations-are-plugins.md) | Integrations are plugins, owned by the tools that define their formats. |
| [0008](0008-toolchain.md) | The toolchain, chosen by "latest is not newest", with the reason for each pin. |
| [0009](0009-mutation-testing.md) | Mutation testing in two sweeps; the core measured at 95.75 and gated at 93. |
| [0010](0010-releases-are-published-by-ci.md) | Releases are published by CI from a version tag, by trusted publishing, with provenance. |
| [0011](0011-waves-are-computed-not-guessed.md) | Waves are computed, not guessed: `schedule` places briefs by precedence-constrained greedy colouring, explains every move, and writes waves only when asked. |
