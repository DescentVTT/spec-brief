/**
 * Checks a release tag against the package and the changelog, before anything
 * is built, and hands the release workflow what it needs: the version, the
 * npm dist-tag and the notes.
 *
 *   node scripts/release.ts v0.2.0 [notes-file]
 *
 * Exits 1 when the tag does not name the package's version or the changelog
 * does not describe it, and 2 on bad arguments. Inside GitHub Actions the
 * outputs go to $GITHUB_OUTPUT; elsewhere they are printed.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Release {
  version: string;
  /** `latest`, or `next` for a prerelease, which must never become the default install. */
  distTag: string;
  notes: string;
}

export function releaseOf(tag: string, version: string, changelog: string): Release | string {
  if (tag !== `v${version}`) {
    return `the tag ${tag} does not name the package's version ${version}: tag v${version}, or change the version`;
  }
  const notes = changelogSection(changelog, version);
  if (notes === null) return `CHANGELOG.md has no "## ${version}" section with text in it; describe the release before tagging it`;
  return { version, distTag: version.includes('-') ? 'next' : 'latest', notes };
}

/**
 * The text under the `## <version>` heading, up to the next heading of that
 * level or above, or `null` when there is no such section or it is empty. The
 * heading may bracket the version and follow it with a date, as Keep a
 * Changelog does.
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => headingVersion(line) === version);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end] as string)) end += 1;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : body;
}

function headingVersion(line: string): string | null {
  if (!line.startsWith('## ')) return null;
  const name = line.slice(3).trim().split(/\s/)[0] as string;
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
}

function main(argv: readonly string[]): number {
  const [tag, notesFile] = argv;
  if (tag === undefined || argv.length > 2) {
    console.error('usage: node scripts/release.ts <tag> [notes-file]');
    return 2;
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const release = releaseOf(tag, manifest.version, readFileSync('CHANGELOG.md', 'utf8'));
  if (typeof release === 'string') {
    console.error(release);
    return 1;
  }
  if (notesFile !== undefined) writeFileSync(notesFile, `${release.notes}\n`);
  const outputs = `version=${release.version}\ndist-tag=${release.distTag}\n`;
  const target = process.env.GITHUB_OUTPUT;
  if (target === undefined) process.stdout.write(outputs);
  else appendFileSync(target, outputs);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
