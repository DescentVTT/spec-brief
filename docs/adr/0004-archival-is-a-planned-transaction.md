---
status: accepted
date: 2026-09-24
---

# ADR-0004: Archival is a planned transaction

## Context

Archiving a brief by hand is several steps across several files: move it, set
its status, write the banner, disposition the open boxes, rewrite its relative
links so they still resolve one directory down, fix the links other briefs
hold to it. Both measured repositories do this by hand, and one of them
records brief references that broke when three briefs were archived. Half
done, the tree holds two copies of a brief, or a brief whose links point at
nothing.

## Decision

**Plan, then apply.** `planArchive` is a pure function of the corpus and a
request. It returns why the archival is refused, the full text of every file
it would write, and the operations. `--dry-run` prints a plan; `apply` runs
one.

**Apply is a transaction over files.** Every file the plan read is read again
and compared, so an edit made in the meantime stops the run before anything
changes. The new file is written first and the old one removed last; each
write is a rename over the target, so no reader sees half a file. If any
operation fails, the completed ones are undone in reverse from the contents
the plan already holds. A process killed inside that window leaves two briefs
with one id, which `lint` names.

**Git is read, never written.** The commit a round landed as, the files it
changed, and whether the tree holds uncommitted work are read. Staging and
committing stay with whoever does them. The commissioning brief's
"all-or-nothing on disk and in git status" would mean reversing a repository
state spec-brief did not create.

**The preflight is what "done" means.** An open box refuses the archival
unless a note under it disposes of it. A change to a protected file refuses
it. A change outside the declared scope is a warning, an error under
`--strict`, and a protected file is reported once, as protected. Uncommitted
work outside the brief directories refuses it, since the recorded commit would
not hold the round; work inside them does not, since ticking the boxes is the
last edit before archiving. Nothing prompts: an agent cannot answer a prompt,
so a refusal says what to do instead.

**Links are rewritten, both ways.** The moved brief's relative links are
recomputed for its new directory, and live briefs that link to it are pointed
at its new path. A link that still resolves keeps its spelling. Archived
briefs that link to it are frozen, and are reported rather than edited.

**The banner is a template.** The facts spec-brief knows - date, pull request,
commit, the diffstat, how many links it rewrote - fill placeholders. What the
round did is a person's sentence, passed as `--summary`. A template line with
an empty placeholder is left out, so a round with no pull request has no
sentence with a hole in it, and a misspelt placeholder is a configuration
error rather than a line that silently never appears.

## Consequences

The ceremony runs in one command and can be previewed. Reopening a brief is
the same machinery run the other way. It restores the body, the blank lines
around the banner and the presence or absence of a final newline exactly,
which the suite checks. It does not restore two spellings: the status line
comes back plain, without the quotes or comment it may have had, and a
relative link that was rewritten comes back in its shortest form. Both
resolve as they did; recording the original spelling to restore it would be
a second copy of the brief to keep in step. A repository that wants the move
staged runs `git add` afterwards.

A review before release found seven defects, each now held by a test in
`tests/regressions.test.ts`. Three bear on this decision: banner markers
quoted in a code block were taken for a banner and deleted; a note under a
nested box closed its parent; and with the briefs at the root, every path
counted as bookkeeping, which silenced the tree and scope checks. The last is
why bookkeeping is now "a file the configuration takes for a brief" rather
than "anything in the brief directories".

## Amended 2026-09-26

A review after 0.1.0 found two gaps in the preflight and one in the links.

**A scope is never passed by a check that measured nothing.** The diff was
read only when a commit was named or `archiving.base` set, so without either
the protected-file and out-of-scope checks did not run, and said nothing. With
a base configured and the archival run on that branch after the merge, the
merge base was the commit itself and the empty diff passed every check. A brief
with a scope whose round's changes are unknown now gets `scope-unmeasured`: a
warning, a refusal under `--strict`, and a hint naming what to pass.

**A disposition is a note that starts with a marker**, on a line under the
box and within its item that starts a note: a bullet, a paragraph after a
blank line, or a line after one that ends a sentence. A marker anywhere in
the item used to count, the box's own text included. A line that continues a
sentence is not a note: `- [ ] Explain why the` over `  **Rejected** designs
failed` is the box's sentence wrapping. CommonMark cannot tell that from
`- [ ] Add a cache.` over `  **Rejected** by 012` - both are one paragraph -
but the stop can: the measured repository writes every note as the line after
a finished sentence, under the box's text or a paragraph of context, and a
sentence wrapped before a marker has not finished. What that misses is a note
under a box whose text has no stop, `- [ ] Add a cache` over
`  **Rejected** by 012`; it refuses, and the hint says to make the note a
bullet or put a blank line above it. A refusal names the box and the fix; an
archival that passed over a wrapped task would have said nothing.

**A front matter block archival created goes when the brief reopens.** A
brief with no front matter, in a repository with no status field, is given a
block to hold its integrity hash, and reopening took the hash out and left
`---` over `---` behind. Reopening now removes a block it leaves empty. A
block that was empty before archival reads the same once the hash is in it,
so it goes too: a third spelling not restored, beside the status line and the
shortest link, and far rarer than a brief with no front matter at all.

**`archiving.rewriteLinks` governs both directions.** The links live briefs
hold to the moving brief were rewritten whatever the switch said. Off, no other
brief is written, and the links they are left holding are reported as
`stale-link`, a warning with every file and line.

## Amended 2026-10-09: the date the environment gives is read, or refused

The date in the banner, and the one `new` writes into a front matter, is the
one `--date` gives, else the day `SOURCE_DATE_EPOCH` names, else the clock's,
in UTC. The variable is how a pipeline has a tool write the same bytes on
every run
([its specification](https://reproducible-builds.org/specs/source-date-epoch/)).
spec-brief has read it since 0.1.0, and the README named it only among the
errors, and only since 0.6.1.

**A value that cannot be read is refused, not read as unset.** The variable
was taken when it was all digits and passed over otherwise, so `tomorrow`,
`1.5`, `-1`, a value with a space beside its digits and an empty one each
had the clock's date written, exit 0. The pipeline that set the variable to
fix the date, and mistyped it, got another date and no word: the fall back
to a default that the family contract rules out
([spec-core ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
The specification has the value be "an ASCII representation of an integer
with no fractional component, identical to the output format of `date +%s`",
and says of a malformed one that the build process "SHOULD exit with a
non-zero error code". So a variable that is set and is not whole seconds in
digits alone ends the run with exit 2 and one line that names it, shows what
it holds - quoted as JSON, so that a space or a newline is seen and the line
stays one line - and says to set it in digits or unset it.

**The last second is 253402300799**, the end of 9999-12-31, since a date
here is written YYYY-MM-DD. Measured on 0.6.1: a later time, up to the
8640000000000 seconds a JavaScript date can hold, made the text
`+010000-01`, which `new` and `archive` refused as `"+010000-01" is not a
date written YYYY-MM-DD` with no word of the variable; past that it was
refused by name. Both are one refusal now, which names the variable and the
limit. GCC and Clang, which write a four-digit year too, stop at the same
second.

**A sign, a fraction and a space are refused**, though `-1` is a time, and
`date +%s` prints one for a day before 1970. `-1` is also what a call that
failed returns, both compilers refuse a negative value, and the values taken
are then exactly the ones 0.6.1 read as a date, less the years past 9999.
Nothing that was passed over is read as a date now, which would have changed
what is written without a word.

**Set and empty is refused too.** The specification does not speak of it,
and the variable's readers give three answers, read on 2026-10-09. For
unset: a shell's `${SOURCE_DATE_EPOCH:-$(date +%s)}` and Perl's `||`, as the
reproducible-builds examples write them, and CMake. Refused: GCC, Clang's
parse of it, and Python's `int('')`. The year 1970: `Number('')`, which is
0, in the same page's example for Node.js. By the specification's words an
empty value is no integer, so it is malformed. It is also what
`export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` leaves where git
failed - under `set -e` as well, since the `export` succeeds - and what a
workflow expression that names an output no step set expands to: the
mistyped pipeline this refusal is for. The cost falls on a pipeline that
passes an empty value to mean none, which must leave the variable unset,
and the line says so. Where readers give three answers, a refusal is the
one that cannot write the wrong date.

**Only a run that would use the date is stopped.** The date was read before
any command started, so on 0.6.1 a variable past the last date stopped
`lint`, `list`, `matrix`, `schedule`, `init` and `unarchive`, which write no
date, and `new` and `archive` under `--date`, which were told theirs. Exit 2
says a result cannot be trusted, and nothing those runs answer depends on
the variable: a pipeline that exports a mistyped one for another tool and
runs `spec-brief lint` has a lint it can trust, and a job turned red over a
value the command never reads is a false positive. The date is now asked
for where it is used, by `new` and `archive` without `--date`, a dry run
included, before either writes anything. `--version` and `--help` never read
it, and are how a person finds out what to set. GCC reads the variable the
same way, when a date is first asked for.

An archival of a brief already archived, which writes nothing, is stopped
with the rest: the date is asked for before the brief is found. Telling the
two apart would mean handing the engine a way to ask for the date in place
of a date, for a case whose answer is to fix the variable either way.
