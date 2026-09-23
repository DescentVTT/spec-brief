import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseBrief, type Brief } from '../src/brief.js';
import { type Config, DEFAULT_CONFIG, resolveConfig } from '../src/config.js';
import { buildCorpus, type Corpus } from '../src/corpus.js';
import type { Phase } from '../src/types.js';

export function config(overrides: Record<string, unknown> = {}): Config {
  return Object.keys(overrides).length === 0 ? DEFAULT_CONFIG : resolveConfig(overrides);
}

export function brief(text: string, file = 'briefs/001_x.md', phase: Phase = 'live', cfg: Config = DEFAULT_CONFIG): Brief {
  return parseBrief(file, text, cfg, phase);
}

/** A corpus from `{ path: text }`; paths under the archive directory are archived. */
export function corpusOf(files: Readonly<Record<string, string>>, cfg: Config = DEFAULT_CONFIG): Corpus {
  return buildCorpus(
    Object.entries(files).map(([path, text]) => ({
      path,
      text,
      phase: path.startsWith(`${cfg.archive}/`) ? 'archived' : 'live',
    })),
    cfg,
  );
}

/** A complete live brief under the default configuration, with front matter overridden per test. */
export function goodBrief(front: Record<string, string> = {}, body = ''): string {
  const fields = { status: 'active', ...front };
  const lines = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', '# A brief', ''];
  lines.push(
    '## Intent',
    '',
    'The tree is better.',
    '',
    '## Negative Scope',
    '',
    '- Nothing else changes.',
    '',
    '## Invariants',
    '',
    '- [x] the tests pass',
    '',
  );
  return `${lines.join('\n')}${body}`;
}

let counter = 0;

/**
 * A directory for one test, named for this process: Stryker runs a test file
 * in several workers at once, and a fixed path is one they would delete under
 * each other. It lives outside this repository, so a test that wants no git
 * gets none, and one that wants git makes its own.
 */
export function tempDir(name: string): string {
  counter += 1;
  // Native, which expands Windows short names (`RUNNER~1` on hosted runners) as git does.
  const dir = join(realpathSync.native(tmpdir()), 'spec-brief-tests', `${name}-${process.pid}-${counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A repository with one identity and no line-ending conversion, so bytes stay
 * bytes. The settings are written into its config file rather than set with
 * four more processes: on some hosts a git process costs a second.
 */
export function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  const settings = ['[user]', 'email = tester@example.com', 'name = Tester', '[core]', 'autocrlf = false', '[commit]', 'gpgsign = false'];
  appendFileSync(join(root, '.git', 'config'), `${settings.join('\n')}\n`);
}

export function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

export function head(root: string): string {
  return git(root, 'rev-parse', 'HEAD').trim();
}

export class Sink {
  text = '';
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}
