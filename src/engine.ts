/**
 * The engine: one repository's briefs, with the operations the CLI offers and
 * the same ones for a harness or an orchestrator that would rather call a
 * function than parse a terminal.
 *
 * This module and the CLI are where the pieces meet their implementations -
 * the real filesystem, the real git, the plugins a configuration names.
 * Everything they compose is a pure function that takes those as arguments,
 * so an engine can equally run over a `MemoryFileSystem` and no git at all.
 */

import { access } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { applyPlan } from './apply.js';
import { planArchive, type Plan, planUnarchive, type PullRequest, type UnarchiveRequest, type Unmeasured } from './archive.js';
import type { Brief } from './brief.js';
import { collisionFindings, collisions, type CollisionOptions, type CollisionReport } from './collisions.js';
import { type Config, DEFAULT_CONFIG, locateConfig, parseConfig } from './config.js';
import { buildCorpus, type Corpus, findBriefs, isReady, pendingDependencies, type SourceFile } from './corpus.js';
import { canonicalPath, type FileSystem, NodeFileSystem } from './fs.js';
import { type CommitInfo, type FileChange, type Git, NodeGit, pullRequestUrl } from './git.js';
import { matchGlob, parseGlob } from './glob.js';
import { normalisePath } from './links.js';
import { lint, type Plugin } from './lint.js';
import { loadPlugins } from './plugins.js';
import { fileNameFor, nextId, renderNewBrief } from './scaffold.js';
import type { Finding, Phase } from './types.js';

export class EngineError extends Error {
  readonly code: 'not-found' | 'ambiguous' | 'invalid' | 'refused' | 'exists';

  constructor(code: EngineError['code'], message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface EngineSetup {
  /** Absolute root: the directory holding the configuration. */
  readonly root: string;
  readonly config: Config;
  /** Repository-relative configuration path, or `null` when the defaults apply. */
  readonly configFile: string | null;
  readonly fs: FileSystem;
  readonly git: Git | null;
  readonly plugins?: readonly Plugin[];
}

export interface OpenOptions {
  /** Where discovery starts. Defaults to the process's directory. */
  readonly cwd?: string;
  /** An explicit configuration file; discovery is skipped. */
  readonly config?: string;
  /** Use the defaults even where a configuration file exists. */
  readonly noConfig?: boolean;
  /** `null` runs without git. Defaults to git when the root is inside a working tree. */
  readonly git?: Git | null;
  readonly fs?: FileSystem;
}

export interface ArchiveOptions {
  readonly pr?: number | undefined;
  /** The commit the round landed as. */
  readonly commit?: string | undefined;
  /** The branch the round started from; the diff runs from its merge base. */
  readonly base?: string | undefined;
  readonly summary?: string | undefined;
  readonly date?: string | undefined;
  readonly allowDirty?: boolean | undefined;
  readonly strict?: boolean | undefined;
  /** Leave git out, even where there is a repository. */
  readonly noGit?: boolean | undefined;
}

export interface NewOptions {
  readonly title: string;
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly wave?: number | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly date?: string | undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Today, in UTC. `SOURCE_DATE_EPOCH` wins where it is set, which is what makes
 * a banner written in a reproducible pipeline reproducible.
 */
export function today(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const epoch = env['SOURCE_DATE_EPOCH'];
  const when = epoch !== undefined && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
  return when.toISOString().slice(0, 10);
}

export function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export class BriefEngine {
  readonly root: string;
  readonly config: Config;
  readonly configFile: string | null;
  readonly fs: FileSystem;
  readonly git: Git | null;
  private plugins: readonly Plugin[] | undefined;
  private loaded: Corpus | undefined;
  private missingBriefs = false;

  constructor(setup: EngineSetup) {
    this.root = setup.root;
    this.config = setup.config;
    this.configFile = setup.configFile;
    this.fs = setup.fs;
    this.git = setup.git;
    this.plugins = setup.plugins;
  }

  /**
   * Finds the configuration, the root it defines and the repository around it,
   * and reads every brief. The root is the directory holding the
   * configuration; without one it is the working tree's top, or `cwd`.
   */
  static async open(options: OpenOptions = {}): Promise<BriefEngine> {
    // Named as git names them, so the root and the work tree compare.
    const cwd = await canonicalPath(resolve(options.cwd ?? process.cwd()));
    const explicit = options.config === undefined ? undefined : await canonicalPath(resolve(cwd, options.config));
    const configPath = options.noConfig === true ? undefined : (explicit ?? (await locateConfig(cwd, exists)));
    // Asking git costs a process; without git there is nothing to ask.
    const toplevel = options.git === null ? null : await NodeGit.toplevel(cwd);
    const root = configPath === undefined ? (toplevel ?? cwd) : dirname(configPath);
    let config = DEFAULT_CONFIG;
    if (configPath !== undefined) {
      const fs = new NodeFileSystem(dirname(configPath));
      const name = configPath.slice(dirname(configPath).length + 1);
      const text = await fs.read(name);
      if (text === null) throw new EngineError('not-found', `${configPath} does not exist`);
      config = parseConfig(text, relative(cwd, configPath));
    }
    const inTree = toplevel !== null && !relative(toplevel, root).startsWith('..');
    const engine = new BriefEngine({
      root,
      config,
      configFile: configPath === undefined ? null : relative(root, configPath).split(sep).join('/'),
      fs: options.fs ?? new NodeFileSystem(root),
      git: options.git === undefined ? (inTree ? new NodeGit(root) : null) : options.git,
    });
    await engine.load();
    return engine;
  }

  get corpus(): Corpus {
    if (this.loaded === undefined) throw new Error('the engine has not loaded its briefs; call load() first');
    return this.loaded;
  }

  /** Reads every brief again, as after an archival. */
  async load(): Promise<Corpus> {
    const files: SourceFile[] = [];
    const accept = parseGlob(this.config.files);
    const reject = this.config.exclude.map((pattern) => parseGlob(pattern));
    const isBrief = (name: string): boolean =>
      accept.ok && matchGlob(accept.glob, name) && !reject.some((r) => r.ok && matchGlob(r.glob, name));
    const read = async (directory: string, phase: Phase): Promise<boolean> => {
      const dir = normalisePath(directory);
      const names = await this.fs.list(dir);
      for (const name of names ?? []) {
        if (!isBrief(name)) continue;
        const path = dir === '' ? name : `${dir}/${name}`;
        const text = await this.fs.read(path);
        // A file listed a moment ago and gone now was removed under the run; there is nothing to read.
        /* v8 ignore next */
        if (text !== null) files.push({ path, text, phase });
      }
      return names !== null;
    };
    this.missingBriefs = !(await read(this.config.briefs, 'live'));
    await read(this.config.archive, 'archived');
    this.loaded = buildCorpus(files, this.config);
    return this.loaded;
  }

  /**
   * Refuses to report on a briefs directory that does not exist. A check over
   * nothing looks exactly like a clean one, and the likelier cause is a
   * configuration pointing at the wrong place.
   */
  requireBriefs(): void {
    if (this.missingBriefs) {
      throw new EngineError('not-found', `${normalisePath(this.config.briefs)}/ does not exist; run "spec-brief init", or set "briefs" in the configuration`);
    }
  }

  /** The plugins the configuration names, loaded once. */
  async loadedPlugins(): Promise<readonly Plugin[]> {
    this.plugins ??= await loadPlugins(this.config.plugins, this.root);
    return this.plugins;
  }

  /** The one brief a reference names: an id, a file name or a path. */
  find(reference: string): Brief {
    const found = findBriefs(this.corpus, reference);
    if (found.length === 0) throw new EngineError('not-found', `no brief is named "${reference}"`);
    if (found.length > 1) {
      throw new EngineError('ambiguous', `"${reference}" names ${found.length} briefs: ${found.map((b) => b.file).join(', ')}`);
    }
    return found[0] as Brief;
  }

  /** The files git sees, or every file when there is no git; `null` when neither can be read. */
  async repoFiles(): Promise<string[] | null> {
    try {
      return this.git === null ? await this.fs.walk() : await this.git.files();
    } catch {
      return null;
    }
  }

  async lint(references: readonly string[] = []): Promise<Finding[]> {
    const only = references.length === 0 ? undefined : references.map((r) => this.find(r));
    return lint(this.corpus, { plugins: await this.loadedPlugins(), repoFiles: await this.repoFiles(), ...(only ? { only } : {}) });
  }

  async collisions(options: CollisionOptions = {}): Promise<{ report: CollisionReport; findings: Finding[] }> {
    const report = collisions(this.corpus, { repoFiles: await this.repoFiles(), ...options });
    return { report, findings: collisionFindings(this.corpus, report) };
  }

  /** Live briefs that can run now: not drafts, every dependency archived. */
  ready(): Brief[] {
    return this.corpus.live.filter((b) => isReady(this.corpus, b));
  }

  /** The live dependencies holding a brief back. */
  waitingOn(brief: Brief): string[] {
    return pendingDependencies(this.corpus, brief);
  }

  async planArchive(reference: string, options: ArchiveOptions = {}): Promise<Plan> {
    const brief = this.find(reference);
    const date = options.date ?? today();
    if (!isDate(date)) throw new EngineError('invalid', `"${date}" is not a date written YYYY-MM-DD`);
    if (options.noGit === true && (options.commit !== undefined || options.base !== undefined)) {
      throw new EngineError('invalid', 'a commit or a base needs git; drop --no-git, or drop --commit and --base');
    }
    const git = options.noGit === true ? null : this.git;
    const base = options.base ?? this.config.archiving.base ?? undefined;
    const findings = await this.lint();

    let commit: CommitInfo | undefined;
    let changes: FileChange[] | undefined;
    let unmeasured: Unmeasured | undefined;
    let dirty: string[] | undefined;
    let pr: PullRequest | undefined;
    if (git !== null) {
      const revision = options.commit ?? (base === undefined ? undefined : 'HEAD');
      if (revision !== undefined) {
        commit = (await git.commit(revision)) ?? undefined;
        if (commit === undefined) throw new EngineError('not-found', `"${revision}" names no commit`);
        let from: string | null = null;
        if (base !== undefined) {
          from = await git.mergeBase(base, commit.sha);
          // No merge base: a base with a history of its own is diffed from
          // directly, and one that names nothing is a typo to report, not a
          // diff for git to fail.
          if (from === null) {
            if ((await git.commit(base)) === null) {
              throw new EngineError('not-found', `the base "${base}" names no commit; check --base and "archiving.base"`);
            }
            from = base;
          }
        }
        // A commit that is its own merge base with the base branch is already
        // in it: the diff is empty whatever the round changed, and an empty
        // diff would pass every scope check without measuring one.
        if (from === commit.sha) unmeasured = { reason: 'merged', base: base as string, commit: commit.sha };
        else changes = await git.changes(from, commit.sha);
      } else {
        unmeasured = { reason: 'revision' };
      }
      dirty = await git.dirty();
    } else {
      unmeasured = { reason: 'git' };
    }
    if (options.pr !== undefined) {
      pr = { number: options.pr, url: git === null ? null : pullRequestUrl(await git.remoteUrl('origin'), options.pr) };
    }
    return planArchive(this.corpus, brief, {
      date,
      summary: options.summary,
      pr,
      commit,
      changes,
      unmeasured,
      dirty,
      allowDirty: options.allowDirty,
      strict: options.strict,
      findings,
    });
  }

  planUnarchive(reference: string, options: UnarchiveRequest = {}): Plan {
    return planUnarchive(this.corpus, this.find(reference), options);
  }

  /** Executes a plan and reads the briefs again. A refused plan is never applied. */
  async apply(plan: Plan): Promise<void> {
    if (plan.blocking.length > 0) {
      throw new EngineError('refused', `${plan.action} of ${plan.brief.file} is refused: ${(plan.blocking[0] as Finding).message}`);
    }
    if (plan.done) return;
    await applyPlan(this.fs, plan.ops);
    await this.load();
  }

  /** Scaffolds a brief and writes it; the file is new, or nothing is written. */
  async create(options: NewOptions): Promise<{ file: string; content: string }> {
    const title = options.title.trim();
    if (title === '') throw new EngineError('invalid', 'a brief needs a title');
    const id = options.id ?? nextId(this.corpus);
    if (id === null) throw new EngineError('invalid', 'the ids here are not numbers, so there is no next one; pass --id');
    if (/[\s/\\]/.test(id) || id.includes(this.config.id.separator)) {
      throw new EngineError('invalid', `"${id}" cannot be an id: no whitespace, slashes or "${this.config.id.separator}"`);
    }
    if (findBriefs(this.corpus, id).some((b) => b.id !== null)) throw new EngineError('exists', `the id "${id}" is taken`);
    if (options.type !== undefined && this.config.types[options.type] === undefined) {
      const names = Object.keys(this.config.types);
      throw new EngineError('invalid', `"${options.type}" is not a brief type here; use one of ${names.join(', ') || '(none)'}`);
    }
    const date = options.date ?? today();
    if (!isDate(date)) throw new EngineError('invalid', `"${date}" is not a date written YYYY-MM-DD`);
    const template = this.config.template === null ? null : await this.fs.read(this.config.template);
    if (this.config.template !== null && template === null) {
      throw new EngineError('not-found', `the template ${this.config.template} does not exist`);
    }
    const content = renderNewBrief(
      this.config,
      { id, title, date, type: options.type, wave: options.wave, dependsOn: options.dependsOn },
      template,
    );
    const dir = normalisePath(this.config.briefs);
    const file = `${dir}/${fileNameFor(this.config, id, title)}`;
    if (await this.fs.exists(file)) throw new EngineError('exists', `${file} already exists`);
    await this.fs.write(file, content);
    await this.load();
    return { file, content };
  }
}
