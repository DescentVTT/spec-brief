---
status: accepted
date: 2026-09-24
---

# ADR-0002: The brief is the record

## Context

The brief that commissioned this tool asked for a `specs/manifest.json` index
of every brief's status, updated on each archival, and for a roadmap table
rewritten in place. It also described a state machine with a persisted
`Archiving` state between `Active` and `Closed`.

Both repositories measured while designing it keep their state elsewhere. One
says in its brief directory's README, in as many words, "Do not add a status
file here": outcomes live in ADRs, the changelog and the code. The other keeps
its waves in a hand-written roadmap whose tables are argued over in prose.

And the index has a structural problem that the commissioning brief itself
names as the reason the tool exists: parallel rounds. Every round that
archives edits the one index. Two rounds merging in parallel conflict on it
every time, over a file whose every line is derivable from the briefs.

## Decision

**A brief and the directory it sits in are the only record.** Location decides
whether a brief is archived. A status field, where a repository keeps one,
must agree with the location, and `lint` reports when it does not.

**Indexes are computed, not stored.** `list --format json` is the manifest,
produced when asked. Nothing is written that could fall out of step.

**No persisted intermediate state.** Archival is a transaction
([ADR-0004](0004-archival-is-a-planned-transaction.md)). A file that says
"archiving" after a crash would be a second thing to recover; a transaction
that stops half-way is rolled back instead.

**No roadmap editing.** A roadmap is a document people write. Rewriting a
table inside it means owning its format, and a generated table beside a
hand-written one is two documents describing one plan.

## Consequences

A consumer in another language runs `spec-brief list --format json` instead of
reading a file. A repository that wants a committed index can write one from
that output in its own pipeline, and owns the conflicts that come with it.

## Amended 2026-10-19: an answer that names what it was read from

spec-harness asks for `list --archived --format json` before each write it
checks, and on Windows a start of Node is most of what that costs. The
family contract now lets a tool give
another's answer again without starting it, where that answer named
everything it was read from and each input reads as listed
([spec-core ADR-0005](https://github.com/spec-family/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
*Findings and output*, amended 2026-10-19). The manifest is still computed
when asked, and nothing is written into the tree: the answer says what it
was made of, and a tool that keeps it keeps it as state of its own.

**`list --format json` names its inputs**, in one field beside the briefs
and the sections. `schemaVersion` stays 2, since a field is added and none
changes:

    "inputs": {
      "keep": true,
      "tool": "0.10.0",
      "files": [
        { "path": ".spec-brief.json", "sha256": "<hex>" },
        { "path": "briefs/042_x.md", "sha256": "<hex>" },
        { "path": "spec-brief.json", "sha256": null }
      ],
      "directories": [
        { "path": "briefs", "entries": ["042_x.md", "README.md"] },
        { "path": "briefs/archive", "entries": null }
      ],
      "git": null
    }

- **`files`**: each file read, with the SHA-256 of the bytes its text was
  decoded from, and each name a configuration was looked for under and was
  not there, with `null`. Both names are looked for in the directory where
  one is found, so a second configuration there is a run refused.
- **`directories`**: each directory the briefs were listed from, with the
  names of the regular files directly in it as `readdir` gives their types,
  sorted as JavaScript sorts strings. A link and a directory are no file to
  `list`, which reads neither. A file that is no brief is named though it
  is not read, since one renamed would be a brief. A directory looked for
  and not found, with nothing or a file under its name, is named with
  `null`: there must still be no directory there, as a file named with a
  `null` digest must still not be there. An archive not yet made is one,
  and one made with a brief in it changes what `list --archived` answers.
- **`tool`**: the version that read them.
- **`git`**: `null`. Measured through the launcher on 2026-10-19 under a
  recorder of every call to `node:fs` and every process started, 0.9.0's
  `list` asked git one thing, `rev-parse --show-toplevel`, and where a
  configuration file names the root that answer decided only which git a
  command that reads git would be given. `list` reads none, so it asks git
  nothing there now: a process fewer, 763 against 725 ms, medians of ten
  with the two taking turns, while `node -e 0` took 639. `GIT_DIR`,
  `GIT_WORK_TREE`, `core.excludesFile` and the index bear on what git lists,
  and `list` asks git for no list, so none of them is a case of its own.
  The member stays for a command that asks git which files there are, which
  would list the index and each ignore file git read for that answer.
- Paths are POSIX, from the root.

**`keep` is `false`, and the lists are empty, wherever spec-brief cannot
name every input of its answer.** A list that leaves one out would have
another tool give the answer again after that input changed:

- **A run that starts anywhere but its root**: below its configuration's
  directory, or with `--config` naming a file in another. The answer does
  not say where its root is, so a reader finds each path from the directory
  it ran spec-brief in, and only there are the two one.
- **A run with no configuration file**, found or named. With git, the root
  is the top of the work tree git finds, from what git reads to find it,
  which no list here names; without git, the configuration was looked for
  in every directory above the root as well. `--no-config --no-git` asks
  neither, and its answer is kept.
- **An engine a caller of the library made, or opened over a filesystem of
  its own**, which tells it nothing of what was read; and **one asked for
  the files git or a walk lists, or for its plugins**, which no list here
  names. `list` asks for neither. `BriefEngine.inputs()` answers for the
  library.

The list is held to what spec-brief read by a test that records every call
the process makes to `node:fs`, `node:fs/promises` and
`node:child_process` while `main` answers, by those modules and not by
spec-brief, and compares the record with the list both ways: a file read
or looked for and not listed with what it holds fails it, a directory
listed and not named with its files fails it, a process started fails it,
and so does a path listed and not read. It runs over a configuration of
each name, one named, none with `--no-config --no-git`, briefs at the
root, and an archive that is not there or is a file, which is held to
`entries: null`; the cases above are each held to `keep: false`.

No other command carries `inputs`. `lint`, `matrix` and `schedule` read the
files git lists, and `lint` the plugins a configuration names, whose code a
digest of one file does not name; `new`, `archive`, `unarchive` and
`schedule --write` write. The field is for an answer another tool asks for
before each write, and today that is `list`'s alone.
