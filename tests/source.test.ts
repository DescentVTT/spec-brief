import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { releaseOf } from '../scripts/release.js';
import { HELP } from '../src/cli.js';
import { initialConfig } from '../src/config.js';
import { matchGlob, parseGlob } from '../src/glob.js';
import { dirOf, isRelativeTarget, resolveFrom, splitTarget } from '../src/links.js';
import { ARCHIVE_RULES, COLLISION_RULES, RULES } from '../src/rules.js';
import { scanMarkdown } from '../src/vendor/spec-core/markdown/index.js';

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

/** A source file without its comments, which are prose and may name what the code does not do. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Every file the repository holds or is about to: tracked, or untracked and
 * not ignored. A list kept by hand missed the configuration files and the
 * briefs; git's does not. This suite is not the core one, so it may ask git.
 */
const everything = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '' && existsSync(path));

describe('the tree', () => {
  it('has LF line endings, no control characters but tabs, and nothing invisible', () => {
    for (const file of ['briefs/002_a-mutation-gate-on-pull-requests.md', 'tsconfig.json', 'vitest.core.config.ts', '.gitattributes', 'LICENSE']) {
      expect(everything, file).toContain(file);
    }
    const offenders = everything.filter((file) => {
      const text = readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if ((code < 32 && code !== 9 && code !== 10) || code === 127) return true;
        // A byte-order mark or a zero-width character reads as nothing; one a
        // test or a rewrite needs is written as an escape.
        if (code === 0xfeff || (code >= 0x200b && code <= 0x200d) || code === 0x2060) return true;
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

  it('builds no RegExp at run time', () => {
    // A pattern a user wrote, compiled to a backtracking RegExp, can take
    // seconds to fail on one long name. Globs run on spec-core's automata; a
    // RegExp here is a literal the author wrote and measured.
    const offenders = sources.filter((file) => file.endsWith('.ts') && /\bRegExp\s*\(/.test(code(file)));
    expect(offenders).toEqual([]);
    expect(sources).toContain('src/vendor/spec-core/pattern/glob.ts');
  });

  it('keeps I/O at the edges', () => {
    // The modules that meet the disk, git or the process. Everything else is
    // a pure function of its arguments, which is why the suite can hand it
    // corpora that never existed on disk. A comment may name the process,
    // as spec-core's display width names the Unicode version a host reports.
    const EDGES = ['src/cli.ts', 'src/engine.ts', 'src/fs.ts', 'src/git.ts', 'src/plugins.ts'];
    const io = /from 'node:(?:fs|fs\/promises|child_process|module|os|process)'/;
    const touching = sources.filter((file) => io.test(code(file)) || code(file).includes('process.'));
    expect(touching.sort()).toEqual(EDGES);
  });
});

/**
 * Whether a range admits a vitest 4 and nothing else, written as npm and
 * Dependabot write one: a caret, a tilde or an exact version.
 */
function onTheFourLine(range: unknown): boolean {
  return typeof range === 'string' && /^[~^]?4\.\d+\.\d+$/.test(range);
}

describe('the toolchain', () => {
  // On vitest 5, Stryker's runner (10.0.0) runs no test against a mutant a
  // test covers and scores it as survived, with every test green. No sweep
  // runs on a pull request here, so such a bump failed nothing until main's
  // sweep. It fails here instead, with its reason.
  const HELD = [
    'vitest is held on 4 until a released @stryker-mutator/vitest-runner reads vitest 5.',
    'On 5 the runner runs no test against a mutant a test covers, so every one survives and the sweep reads about 4%:',
    'https://github.com/stryker-mutator/stryker-js/issues/6210.',
    'docs/adr/0009-mutation-testing.md, amended 2026-10-07, has the measurement and where the steps that lift this are',
  ].join(' ');

  it.each(['vitest', '@vitest/coverage-v8'])('holds %s to the 4 line, the newest Stryker\'s runner measures on (ADR-0009)', (name) => {
    const { devDependencies } = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, unknown> };
    const range = devDependencies[name];
    expect(onTheFourLine(range), `package.json asks for ${name} "${String(range)}". ${HELD}`).toBe(true);
  });

  it('takes a range for the 4 line only when it admits no other', () => {
    // The minors and patches Dependabot still proposes must pass.
    for (const range of ['^4.1.11', '^4.1.12', '^4.2.0', '~4.1.11', '4.1.11']) expect(onTheFourLine(range), range).toBe(true);
    for (const range of ['^5.0.0', '5.0.3', '>=4.1.11', '>4', '^4.1.11 || ^5.0.0', '*', 'latest', '', undefined]) {
      expect(onTheFourLine(range), String(range)).toBe(false);
    }
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
    for (const command of ['init', 'new', 'lint', 'list', 'matrix', 'schedule', 'archive', 'unarchive']) {
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

  it('the documents the package ships link only to files it ships, or by URL to a file the repository holds', () => {
    // npm ships what `files` names, so a relative link to anything else is
    // dead on npmjs.com and in node_modules; such a file is linked on GitHub.
    const { files } = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    // `/README.md` is the root's README: npm reads a name with no slash at any
    // depth, and `README.md` packed spec-core's vendored README beside it.
    const ships = (path: string): boolean => files.some((entry) => path === entry.replace(/^\//, '') || path.startsWith(`${entry}/`));
    const documents = everything.filter((path) => path.endsWith('.md') && ships(path));
    expect(documents).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md']));
    expect(files).toContain('/README.md');
    expect(documents.filter((path) => path.startsWith('src/'))).toEqual([]);
    const REPOSITORY = 'https://github.com/DescentVTT/spec-brief/blob/main/';
    const dead: string[] = [];
    for (const document of documents) {
      for (const link of scanMarkdown(readFileSync(document, 'utf8')).links) {
        if (link.form !== 'inline' && link.form !== 'definition') continue;
        const { path } = splitTarget(link.target);
        if (link.target.startsWith(REPOSITORY)) {
          if (!everything.includes(path.slice(REPOSITORY.length))) dead.push(`${document}: ${link.target}`);
        } else if (isRelativeTarget(link.target)) {
          const resolved = resolveFrom(dirOf(document), decodeURIComponent(path));
          if (resolved === null || !ships(resolved) || !existsSync(resolved)) dead.push(`${document}: ${link.target}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('init points $schema where the README does, at the schema the package ships', () => {
    // A schema that moves with main, as init wrote before 0.2.1, judges a
    // configuration by rules the installed version may not have.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; files: string[] };
    const written = initialConfig('briefs', 'briefs/archive')['$schema'];
    expect(written).toBe(`./node_modules/${pkg.name}/schema.json`);
    expect(pkg.files).toContain('schema.json');
    expect(readme).toContain(`"$schema": "${String(written)}"`);
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
