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
