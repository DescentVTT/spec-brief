---
status: accepted
date: 2026-09-24
---

# ADR-0010: Releases are published by CI, with provenance

## Context

0.1.0 was published from a workstation, with `npm publish` and a one-time
password. It worked, and it asked users to trust three things they cannot
check: that the workstation's `dist/` was built from the tagged commit, that a
person ran every check before publishing, and, for any automation, a
long-lived token able to publish anything the account owns. The registry
records nothing that ties the tarball to a commit.

npm's trusted publishing, generally available since July 2025, accepts a
publish from a named workflow in a named repository on the strength of the
OIDC token GitHub issues to that run. No secret exists to leak. A version
published this way carries a provenance attestation, signed through Sigstore,
that names the repository, the commit and the run; `npm audit signatures`
verifies it.

## Decision

**A version tag publishes, and nothing else does.** On a `v*` tag,
`.github/workflows/release.yml` runs four jobs, each with only the access it
needs.

1. **CI, again**, the whole matrix on the tagged commit: `ci.yml` is callable.
   CI on main cancels a run when a newer push arrives, so a tagged commit may
   never have finished one.
2. **`pack`**, with read access alone. The commit must be on main, the tag
   must be `v` followed by the version in `package.json`, and `CHANGELOG.md`
   must have a section for that version (`scripts/release.ts`). It builds from
   clean, packs, and uploads the tarball with the notes.
3. **`publish`**, the one job with `id-token: write`, in the `npm`
   environment. It checks out nothing and installs nothing: it downloads the
   tarball and npm publishes it. A compromised development dependency runs in
   `pack`, where there is no token to take.
4. **`github-release`**, with `contents: write` alone: the changelog section as
   the notes, and the tarball npm has as an asset.

A prerelease version, one with a `-`, goes out under the `next` dist-tag and
never becomes `latest`.

Run by hand from main, the workflow rehearses: every job but the GitHub
release, with `npm publish --dry-run`. npm refuses even a dry run over a
version it already has, so a rehearsal of a published version stops before
the upload and says so. The OIDC exchange is the one step a rehearsal cannot
try.

*Amended 2026-09-26.* `publish` stages the version rather than publishing
it. 0.2.0, the first tag, passed every job and was refused at the upload,
`OIDC permission denied`: a trusted publisher configured after 2026-09-03
permits `npm stage publish` by default, and a direct publish only where the
package opts in. Staging is the better of the two answers. The version waits on
npmjs.com, installable by nobody, until a maintainer runs `npm stage approve`
with a second factor, so a person decides that each version goes out, and a
run that is not the maintainer's can at most queue one. The job installs an npm
new enough to stage, 11.15 or later inside 11.x. spec-guard releases the same
way.

## Consequences

- A maintainer sets up npmjs.com once. In the package's settings, add a
  trusted publisher: GitHub Actions, repository `DescentVTT/spec-brief`,
  workflow `release.yml`, environment `npm`. Then set publishing access to
  require two-factor authentication and disallow tokens, which leaves this
  workflow and a person with a second factor as the only ways to publish.
- **A maintainer approves each release.** The tag's run ends with the version
  staged, and its summary names the commands: `npm stage list
  @descent-vtt/spec-brief`, `npm stage view <id>`, then `npm stage approve <id>`
  with a second factor, or the Staged Packages tab on npmjs.com.
- The `npm` environment in the repository's settings is where a required
  reviewer goes, if a release should wait for one.
- The changelog check also runs in the unit suite, so the pull request that
  bumps the version fails without its notes, before anyone tags it.
- 0.1.0 has no provenance. Every later version does.
- The actions stay pinned by commit (ADR-0008). `actions/download-artifact` is
  pinned at v8.0.1, whose digest check fails a download that does not match
  the upload.
