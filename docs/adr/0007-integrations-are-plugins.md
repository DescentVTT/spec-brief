---
status: accepted
date: 2026-09-24
---

# ADR-0007: Integrations are plugins

## Context

The commissioning brief asked for built-in switches that validate
cryptographic departure signatures (`spec-escalate`), verified reproducer logs
(`spec-probe`) and AST blast radiuses (`spec-code-graph`). None of those tools
is in the organisation's repositories today, so none of their formats is
defined. A verifier for a format nobody has written is an invention, and the
tool that later defines the format would have to match a guess.

## Decision

A plugin is a module that exports `{ name, rules }`, or a function of its
configured options that returns one. Its rules receive the brief, the corpus,
the configuration, the tracked files and their options, and return findings
with lines. They run inside `lint` as `<name>/<rule>`, with severities set in
configuration like any built-in rule. A plugin whose export has the wrong
shape stops the run, as a configuration that does not load does.

## Consequences

The tool that defines a format ships the check for it, and upgrades the two
together. spec-brief carries no copy of formats it does not own. Loading a
plugin runs its code; the configuration belongs to the repository, and so does
that trust, as with a linter's configuration.
