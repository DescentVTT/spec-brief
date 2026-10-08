# Architecture decision records

One file per decision, numbered in order, never renumbered. A decision that
changes is superseded by a new record that says so; the old one keeps its text.

| ADR | Decision |
| --- | --- |
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies: the front-matter reader and the Markdown scanner are written here; amended as the glob engine, then the scanner and the reader, became spec-core's, copied and verified by hash, with the dialect a brief is read in kept here; amended so that an input that names nothing - an option given an empty value, a list of only commas, an argument a command does not take, a root that is no directory - is refused, not read as if it were not there. |
| [0002](0002-the-brief-is-the-record.md) | The brief is the record: no status file, no manifest, no roadmap editing, no persisted intermediate state. |
| [0003](0003-conventions-are-configuration.md) | Conventions are configuration, measured against two repositories that keep briefs; amended with a status for deferred work and its observable trigger, then for a trigger written in Chinese, for English only again, and for the stop after a placeholder. |
| [0004](0004-archival-is-a-planned-transaction.md) | Archival is a planned transaction over files; git is read, never written; amended so that the date is `--date`'s, `SOURCE_DATE_EPOCH`'s or the clock's, and a variable that cannot be read as a date is refused where one is to be written. |
| [0005](0005-scopes-collide-by-intersection.md) | Scopes collide by glob intersection, with a witness; amended for spec-core's engine: a literal is read from the tree, a witness is a file, protection wins, and undecided is an answer; amended so the witness is a file of the tree where one exists, and such a file decides a pair the search could not; amended so the grid marks what the run reports, and a rule that is off marks nothing. |
| [0006](0006-the-freeze-lives-in-the-file.md) | The freeze is a hash in the archived brief's own front matter, not a ledger. |
| [0007](0007-integrations-are-plugins.md) | Integrations are plugins, owned by the tools that define their formats; amended so a plugin may waive a protected-file or out-of-scope refusal its own check allows. |
| [0008](0008-toolchain.md) | The toolchain, chosen by "latest is not newest", with the reason for each pin. |
| [0009](0009-mutation-testing.md) | Mutation testing in two sweeps; the core measured at 95.75, then 97.83 with 112 survivors, and gated at 93, then at 97 once every survivor had been read (99.31% in full); amended to hold vitest on 4 until Stryker's runner reads vitest 5. |
| [0010](0010-releases-are-published-by-ci.md) | Releases are published by CI from a version tag, by trusted publishing, with provenance. |
| [0011](0011-waves-are-computed-not-guessed.md) | Waves are computed, not guessed: `schedule` places briefs by precedence-constrained greedy colouring, explains every move, and writes waves only when asked. |
