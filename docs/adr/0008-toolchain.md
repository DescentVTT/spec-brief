---
status: accepted
date: 2026-09-24
---

# ADR-0008: The toolchain, and latest is not newest

## Context

"Use the latest" decays the week it is written. The rule followed here is the
organisation's: the current recommended production choice, which for a major
released a few weeks ago is deliberately not the highest version number. Each
row below was read from the npm registry or the action's tags on 2026-09-24.

## Decision

| Component | Chosen | Newest | Why |
| --- | --- | --- | --- |
| Node | `>=22` | 26 | 22 is in maintenance until April 2027 and 24 is the active LTS; CI runs 22, 24 and 26. |
| `@types/node` | `^22` | 26.6 | Types match the lowest runtime supported, so an API only 24 has fails to compile rather than failing on a user's machine. |
| TypeScript | `^7.0.2` | 7.0.2 | The native compiler, stable since 8 July and used by the sibling tools. Its missing programmatic API matters to tools built on it, and nothing here is. |
| Vitest | `^4.1.11` | 5.0.1 | 5.0 became `latest` on 15 September, nine days before this; 4.1 is the maintained line the sibling tools run. |
| Stryker | `^10.0.0` | 10.0.0 | Matches the sibling tools. Its TypeScript checker needs the API TypeScript 7 does not have, so it is not used. |
| Package manager | npm | pnpm 12 | Nothing is resolved at runtime and there are six devDependencies; npm needs no extra install and matches the siblings. |
| Lint | `tsc --noEmit`, strict | ESLint 10 | `typescript-eslint` peers TypeScript below 6.1. A second compiler for lint is a cost the siblings chose not to pay; a test holds `any` out of `src/`. |
| `actions/checkout` | v6.1.0, by commit | v7.0.1 | v7 is two months old, and v6 received the same-day patch. |
| `actions/setup-node` | v6.5.0, by commit | v7.0.0 | The same. |
| `actions/upload-artifact` | v7.0.1, by commit | v7.0.1 | v7 has been out since February. |

Every action is pinned to a commit with its tag beside it, because a tag can
be moved and a commit cannot.

## Consequences

Re-read this table when it is a quarter old, when Vitest 5 has had a release
line's worth of patches, or when TypeScript ships the programmatic API, which
is expected in 7.1. Moving a pin is an ordinary change with its reason in the
commit.
