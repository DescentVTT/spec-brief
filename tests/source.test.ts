import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { releaseOf } from '../scripts/release.js';
import { HELP } from '../src/cli.js';
import { matchGlob, parseGlob } from '../src/glob.js';
import { ARCHIVE_RULES, COLLISION_RULES, RULES } from '../src/rules.js';

/**
 * Claims the repository makes about itself, checked rather than trusted: a
 * tool whose premise is that documents drift has no business shipping
 * documents that drifted from its own code.
 */

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.name.startsWith('.tmp')) continue;
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|js|mjs|json|md|yml)$/.test(entry.name)) yield path;
  }
}

const sources = [...walk('src')];
const everything = [
  ...sources,
  ...walk('tests'),
  ...walk('bin'),
  ...walk('scripts'),
  ...walk('docs'),
  ...walk('.github'),
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'package.json',
  'schema.json',
  'stryker.config.mjs',
];

describe('the tree', () => {
  it('has LF line endings and no control characters but tabs', () => {
    const offenders = everything.filter((file) => {
      const text = readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if ((code < 32 && code !== 9 && code !== 10) || code === 127) return true;
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
    expect(pkg['dependencies'] ?? {}).toEqual({});
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
    const imports = sources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1] as string));
    expect(imports.filter((s) => !s.startsWith('.') && !s.startsWith('node:'))).toEqual([]);
  });

  it('writes no `any` in the source', () => {
    // Comments are prose, and prose may say "any".
    const code = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const offenders = sources.filter((file) => /(?::\s*any\b|\bas any\b|<any>|any\[\])/.test(code(file)));
    expect(offenders).toEqual([]);
    expect(/:\s*any\b/.test(code('src/lint.ts'))).toBe(false);
  });

  it('type-checks every configuration file', () => {
    // A configuration left out of tsconfig.json is never type-checked, and a
    // misspelt option in it is read as absent.
    const { include } = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as { include: string[] };
    const globs = include.map((pattern) => parseGlob(pattern)).flatMap((parsed) => (parsed.ok ? [parsed.glob] : []));
    expect(globs).toHaveLength(include.length);
    const configs = readdirSync('.').filter((name) => /\.config\.(?:ts|mjs)$/.test(name));
    expect(configs.sort()).toEqual(['stryker.config.mjs', 'stryker.core.config.mjs', 'vitest.config.ts', 'vitest.core.config.ts', 'vitest.mutation.config.ts']);
    expect(configs.filter((name) => !globs.some((glob) => matchGlob(glob, name)))).toEqual([]);
  });

  it('keeps I/O at the edges', () => {
    // The modules that meet the disk, git or the process. Everything else is
    // a pure function of its arguments, which is why the suite can hand it
    // corpora that never existed on disk.
    const EDGES = ['src/cli.ts', 'src/engine.ts', 'src/fs.ts', 'src/git.ts', 'src/plugins.ts'];
    const io = /from 'node:(?:fs|fs\/promises|child_process|module|os|process)'/;
    const touching = sources.filter((file) => io.test(readFileSync(file, 'utf8')) || readFileSync(file, 'utf8').includes('process.'));
    expect(touching.sort()).toEqual(EDGES);
  });
});

describe('the documents', () => {
  const readme = readFileSync('README.md', 'utf8');

  it('the README names every rule, and no rule that does not exist', () => {
    const ids = [...RULES, ...COLLISION_RULES, ...ARCHIVE_RULES].map((r) => r.id);
    const missing = ids.filter((id) => !readme.includes(`\`${id}\``));
    expect(missing).toEqual([]);
    const table = readme.slice(readme.indexOf('<!-- rules:start -->'), readme.indexOf('<!-- rules:end -->'));
    const named = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1] as string);
    expect(named.sort()).toEqual([...ids].sort());
  });

  it('the README names every command and option the CLI accepts', () => {
    const options = [...HELP.matchAll(/--([a-z-]+)/g)].map((m) => `--${m[1] as string}`);
    const missing = [...new Set(options)].filter((o) => !readme.includes(o));
    expect(missing).toEqual([]);
    for (const command of ['init', 'new', 'lint', 'list', 'matrix', 'archive', 'unarchive']) {
      expect(readme.includes(`spec-brief ${command}`), command).toBe(true);
    }
  });

  it('the changelog counts the rules there are', () => {
    // A count in prose is a fact with an expiry date; this one is checked.
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    const match = /(\d+) lint rules and (\d+) collision rules/.exec(changelog);
    expect(match?.slice(1).map(Number)).toEqual([RULES.length, COLLISION_RULES.length]);
  });

  it('the changelog describes the version package.json names', () => {
    // The release workflow refuses a tag without notes; this says so on the
    // pull request that bumps the version, before anyone tags it.
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(releaseOf(`v${version}`, version, readFileSync('CHANGELOG.md', 'utf8'))).toMatchObject({ version });
  });

  it('every ADR has a status and a date, and the index lists them all', () => {
    const adrs = readdirSync('docs/adr').filter((f) => /^\d{4}-.+\.md$/.test(f));
    expect(adrs.length).toBeGreaterThan(0);
    const index = readFileSync('docs/adr/README.md', 'utf8');
    for (const adr of adrs) {
      const text = readFileSync(`docs/adr/${adr}`, 'utf8');
      expect(text, adr).toMatch(/^---\nstatus: (proposed|accepted|superseded)\ndate: \d{4}-\d{2}-\d{2}\n---\n/);
      expect(index.includes(adr), adr).toBe(true);
    }
  });
});
