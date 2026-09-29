# Security

## Supported versions

The latest minor release of `@descent-vtt/spec-brief` on npm gets security
fixes, as a patch release of that minor. Older minors do not: before 1.0 a
tool keeps no support window
([spec-core's ADR-0009](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0009-versions-before-1-0.md)),
so a fix reaches you by upgrading to the latest minor.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: on the
repository's **Security** tab, choose **Report a vulnerability**. Only the
maintainers see the report.

Do not open a public issue, pull request or discussion for a vulnerability: it
tells everyone before there is a fix.

## What happens next

1. The report is acknowledged.
2. A fix is released as a patch of the latest minor, and a GitHub security
   advisory says which versions the vulnerability affects and which fixes it.
3. The advisory credits you, if you want it to.
