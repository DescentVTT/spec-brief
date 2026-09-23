/**
 * Configuration: what it may say, what it says when it says nothing, and how a
 * file becomes a `Config`.
 *
 * Every repository that already keeps briefs keeps them its own way - where
 * they live, what the sections are called, which word means "done" - so the
 * conventions are data here rather than code. The defaults describe a brief
 * with the four parts every round needs: an intent, a negative scope, what the
 * round is not empowered to touch, and the invariants that prove it is done.
 *
 * A configuration that does not load stops the run. A typo that silently
 * falls back to defaults produces a clean-looking report about the wrong
 * rules, which is worse than no report.
 */

import { dirname, join } from 'node:path';

import { parseGlob } from './glob.js';
import { type Schema, toJsonSchema, validate } from './schema.js';
import { templateHoles } from './text.js';
import type { SeveritySetting } from './types.js';

export interface SectionRule {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Literal text the section must contain, compared exactly. */
  readonly mustContain: readonly string[];
  /** The section must hold at least one task item. */
  readonly checklist: boolean;
  readonly optional: boolean;
}

export interface PluginReference {
  readonly module: string;
  readonly options: unknown;
}

export interface Config {
  /** Directory of live briefs, relative to the root. */
  readonly briefs: string;
  /** Directory of archived briefs, relative to the root. */
  readonly archive: string;
  /** Glob a file name must match to be a brief. */
  readonly files: string;
  /** File-name globs that are never briefs, such as an index. */
  readonly exclude: readonly string[];
  /** A template for `new`, relative to the root; `null` builds one from `sections`. */
  readonly template: string | null;
  readonly id: {
    readonly source: 'filename' | 'frontmatter';
    readonly separator: string;
    readonly digits: number;
  };
  readonly status: {
    readonly field: string | null;
    readonly draft: string | null;
    readonly active: string;
    readonly archived: string;
  };
  readonly sections: readonly SectionRule[];
  readonly sectionOrder: boolean;
  readonly types: Readonly<Record<string, readonly SectionRule[]>>;
  readonly placeholders: readonly string[];
  readonly fields: readonly string[];
  readonly archiving: {
    readonly tasks: 'all' | readonly string[];
    readonly dispositions: readonly string[];
    readonly banner: readonly string[];
    readonly rewriteLinks: boolean;
    readonly freeze: boolean;
    readonly base: string | null;
  };
  readonly rules: Readonly<Record<string, SeveritySetting>>;
  readonly plugins: readonly PluginReference[];
}

export const CONFIG_FILES: readonly string[] = ['.spec-brief.json', 'spec-brief.json'];

/** The holes a banner line may use. */
export const BANNER_PLACEHOLDERS: readonly string[] = [
  'date',
  'summary',
  'pr',
  'commit',
  'diffstat',
  'links',
  'id',
  'title',
  'author',
];

export const SCHEMA_URL = 'https://raw.githubusercontent.com/DescentVTT/spec-brief/main/schema.json';

const SEVERITY: Schema = { type: 'string', enum: ['off', 'note', 'warning', 'error'] };
const STRINGS: Schema = { type: 'array', items: { type: 'string', minLength: 1 } };

const SECTION: Schema = {
  type: 'anyOf',
  description: 'A section name, or a section with aliases and content rules.',
  options: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, description: 'The heading text, compared without case or punctuation.' },
        aliases: { ...STRINGS, description: 'Other headings that fill this section.' },
        mustContain: { ...STRINGS, description: 'Literal text the section must contain.' },
        checklist: { type: 'boolean', description: 'The section must hold at least one "- [ ]" task item.' },
        optional: { type: 'boolean', description: 'Checked when present, not required.' },
      },
    },
  ],
};

export const CONFIG_SCHEMA: Schema = {
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    briefs: { type: 'string', minLength: 1, description: 'Directory of live briefs, relative to this file.' },
    archive: { type: 'string', minLength: 1, description: 'Directory of archived briefs, relative to this file.' },
    files: { type: 'string', minLength: 1, description: 'Glob a file name must match to be a brief.' },
    exclude: { ...STRINGS, description: 'File-name globs that are never briefs.' },
    template: { type: 'string', nullable: true, description: 'Template file for "new"; null builds one from the sections.' },
    id: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['filename', 'frontmatter'], description: 'Where a brief id comes from.' },
        separator: { type: 'string', minLength: 1, description: 'Separates the id from the slug in a file name.' },
        digits: { type: 'integer', minimum: 1, maximum: 12, description: 'Width of an allocated numeric id.' },
      },
    },
    status: {
      type: 'object',
      properties: {
        field: { type: 'string', nullable: true, description: 'Front-matter key holding the status; null uses location only.' },
        draft: { type: 'string', nullable: true, description: 'The word for a brief still being written, or null.' },
        active: { type: 'string', minLength: 1, description: 'The word for a live brief.' },
        archived: { type: 'string', minLength: 1, description: 'The word for an archived brief.' },
      },
    },
    sections: { type: 'array', items: SECTION, description: 'Sections every live brief carries.' },
    sectionOrder: { type: 'boolean', description: 'Sections must appear in the order listed.' },
    types: {
      type: 'map',
      description: 'Brief types, each with the sections it adds.',
      values: { type: 'object', properties: { sections: { type: 'array', items: SECTION } } },
    },
    placeholders: { ...STRINGS, description: 'Words that mark a section as unwritten.' },
    fields: { ...STRINGS, description: 'Front-matter keys this repository uses beyond the built-in ones.' },
    archiving: {
      type: 'object',
      properties: {
        tasks: {
          type: 'anyOf',
          description: '"all", or the sections whose task items must be closed before archiving.',
          options: [{ type: 'string', enum: ['all'] }, STRINGS],
        },
        dispositions: { ...STRINGS, description: 'Text under an open box that closes it without a tick.' },
        banner: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lines of the frozen banner; a line with an empty {placeholder} is left out, and an empty line separates paragraphs.',
        },
        rewriteLinks: { type: 'boolean', description: 'Rewrite relative links so they resolve from the new directory.' },
        freeze: { type: 'boolean', description: 'Record a content hash so later edits are caught.' },
        base: { type: 'string', nullable: true, description: 'Branch the diff is measured from, such as "main".' },
      },
    },
    rules: { type: 'map', values: SEVERITY, description: 'Severity per rule id.' },
    plugins: {
      type: 'array',
      description: 'Modules that contribute rules.',
      items: {
        type: 'anyOf',
        options: [
          { type: 'string', minLength: 1 },
          {
            type: 'object',
            required: ['module'],
            properties: { module: { type: 'string', minLength: 1 }, options: { type: 'any' } },
          },
        ],
      },
    },
  },
};

function section(name: string, extra: Partial<Omit<SectionRule, 'name'>> = {}): SectionRule {
  return { name, aliases: [], mustContain: [], checklist: false, optional: false, ...extra };
}

export const DEFAULT_CONFIG: Config = {
  briefs: 'briefs',
  archive: 'briefs/archive',
  files: '[0-9]*.md',
  exclude: [],
  template: null,
  id: { source: 'filename', separator: '_', digits: 3 },
  status: { field: 'status', draft: 'draft', active: 'active', archived: 'archived' },
  sections: [
    section('Intent', { aliases: ["Commander's Intent", 'Mission', 'Objective'] }),
    section('Negative Scope', {
      aliases: ['Out of Scope', 'Non-Goals', 'Not in Scope', 'What this round is NOT', 'What this brief does NOT do'],
    }),
    section('Not Empowered', { aliases: ['Non-Empowerment', 'Non-Empowerment List'], optional: true }),
    section('Invariants', { aliases: ['Invariant Checklist', 'Definition of Done'], checklist: true }),
  ],
  sectionOrder: false,
  types: {
    feature: [section('Acceptance Criteria', { checklist: true })],
    defect: [section('The Defect, Measured', { aliases: ['Reproduction'] })],
    refactor: [],
    chore: [],
  },
  placeholders: ['TBD', 'TBA', 'TODO', 'FIXME', 'XXX', '???', '...', '\u2026'],
  fields: [],
  archiving: {
    tasks: 'all',
    dispositions: ['**Delegated', '**Accepted debt', '**Rejected'],
    banner: [
      '**Archived {date}.**',
      '{summary}',
      'Merged in pull request {pr}.',
      'Recorded at commit `{commit}`: {diffstat}.',
      '{links}',
      'The body below describes the tree before execution and is not maintained.',
    ],
    rewriteLinks: true,
    freeze: true,
    base: null,
  },
  rules: {},
  plugins: [],
};

type Raw = Record<string, unknown>;

function sectionFrom(raw: unknown): SectionRule {
  if (typeof raw === 'string') return section(raw);
  const r = raw as Raw;
  return section(r['name'] as string, {
    aliases: (r['aliases'] as string[] | undefined) ?? [],
    mustContain: (r['mustContain'] as string[] | undefined) ?? [],
    checklist: (r['checklist'] as boolean | undefined) ?? false,
    optional: (r['optional'] as boolean | undefined) ?? false,
  });
}

function pluginFrom(raw: unknown): PluginReference {
  if (typeof raw === 'string') return { module: raw, options: undefined };
  const r = raw as Raw;
  return { module: r['module'] as string, options: r['options'] };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(file: string, problems: readonly string[]) {
    super(`${file}: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Builds a configuration from parsed JSON. Objects merge one level deep over
 * the defaults; lists and `types` replace them, because a repository that
 * names its own sections means those sections and not the defaults as well.
 */
export function resolveConfig(raw: unknown, file = 'configuration'): Config {
  const problems = validate(CONFIG_SCHEMA, raw);
  if (problems.length > 0) throw new ConfigError(file, problems);
  const r = raw as Raw;
  const d = DEFAULT_CONFIG;
  const merged = <T extends object>(key: string, base: T): T => ({ ...base, ...((r[key] as Partial<T>) ?? {}) });
  const archiving = merged('archiving', d.archiving);
  const config: Config = {
    briefs: (r['briefs'] as string | undefined) ?? d.briefs,
    archive: (r['archive'] as string | undefined) ?? (r['briefs'] === undefined ? d.archive : `${r['briefs'] as string}/archive`),
    files: (r['files'] as string | undefined) ?? d.files,
    exclude: (r['exclude'] as string[] | undefined) ?? d.exclude,
    template: r['template'] === undefined ? d.template : (r['template'] as string | null),
    id: merged('id', d.id),
    status: merged('status', d.status),
    sections: r['sections'] === undefined ? d.sections : (r['sections'] as unknown[]).map(sectionFrom),
    sectionOrder: (r['sectionOrder'] as boolean | undefined) ?? d.sectionOrder,
    types:
      r['types'] === undefined
        ? d.types
        : Object.fromEntries(
            Object.entries(r['types'] as Record<string, Raw>).map(([name, type]) => [
              name,
              ((type['sections'] as unknown[] | undefined) ?? []).map(sectionFrom),
            ]),
          ),
    placeholders: (r['placeholders'] as string[] | undefined) ?? d.placeholders,
    fields: (r['fields'] as string[] | undefined) ?? d.fields,
    archiving,
    rules: { ...d.rules, ...((r['rules'] as Record<string, SeveritySetting> | undefined) ?? {}) },
    plugins: ((r['plugins'] as unknown[] | undefined) ?? []).map(pluginFrom),
  };
  const semantic = checkConfig(config);
  if (semantic.length > 0) throw new ConfigError(file, semantic);
  return config;
}

/** What the schema cannot say: relationships between values. */
function checkConfig(config: Config): string[] {
  const problems: string[] = [];
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (norm(config.briefs) === norm(config.archive)) problems.push('"briefs" and "archive" must be different directories');
  const words = [config.status.draft, config.status.active, config.status.archived].filter((w) => w !== null);
  if (new Set(words.map((w) => w.toLowerCase())).size !== words.length) {
    problems.push('the status words for draft, active and archived must differ');
  }
  // A pattern that does not parse would match nothing, and a run over no briefs reads as clean.
  for (const [key, pattern] of [['files', config.files], ...config.exclude.map((e) => ['exclude', e] as const)] as const) {
    const parsed = parseGlob(pattern);
    if (!parsed.ok) problems.push(`"${key}" pattern "${pattern}": ${parsed.error}`);
  }
  // An unknown hole is never filled, and a line with an unfilled hole is left
  // out: a misspelt placeholder would silently drop its whole line.
  for (const line of config.archiving.banner) {
    for (const hole of templateHoles(line)) {
      if (!BANNER_PLACEHOLDERS.includes(hole)) {
        problems.push(`"archiving.banner" uses {${hole}}; the placeholders are ${BANNER_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`);
      }
    }
  }
  return problems;
}

/** Parses the text of a configuration file. */
export function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new ConfigError(file, [`is not valid JSON (${(error as Error).message})`]);
  }
  return resolveConfig(raw, file);
}

/**
 * The configuration file for a directory: the nearest one at or above it.
 * `exists` is injected so discovery needs no filesystem of its own.
 */
export async function locateConfig(
  start: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  let directory = start;
  // Bounded by the depth of the path: each pass moves one directory up.
  for (let depth = 0; depth < 256; depth += 1) {
    const found: string[] = [];
    for (const name of CONFIG_FILES) {
      const candidate = join(directory, name);
      if (await exists(candidate)) found.push(candidate);
    }
    if (found.length > 1) {
      throw new ConfigError(directory, [`holds both ${CONFIG_FILES.join(' and ')}; keep one`]);
    }
    if (found[0] !== undefined) return found[0];
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  /* v8 ignore next -- no path is 256 directories deep; the bound exists so the loop ends by construction. */
  return undefined;
}

/** The JSON Schema published as `schema.json`. */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_URL,
    title: 'spec-brief configuration',
    ...toJsonSchema(CONFIG_SCHEMA),
  };
}

/** The configuration `init` writes: every default spelled out, so it can be edited rather than looked up. */
export function initialConfig(briefs: string, archive: string): Record<string, unknown> {
  const d = DEFAULT_CONFIG;
  const sectionJson = (s: SectionRule): unknown => {
    const out: Record<string, unknown> = { name: s.name };
    if (s.aliases.length > 0) out['aliases'] = s.aliases;
    if (s.mustContain.length > 0) out['mustContain'] = s.mustContain;
    if (s.checklist) out['checklist'] = true;
    if (s.optional) out['optional'] = true;
    return Object.keys(out).length === 1 ? s.name : out;
  };
  return {
    $schema: SCHEMA_URL,
    briefs,
    archive,
    files: d.files,
    id: d.id,
    status: d.status,
    sections: d.sections.map(sectionJson),
    types: Object.fromEntries(Object.entries(d.types).map(([k, v]) => [k, { sections: v.map(sectionJson) }])),
    archiving: {
      tasks: d.archiving.tasks,
      dispositions: d.archiving.dispositions,
      banner: d.archiving.banner,
      base: d.archiving.base,
    },
  };
}
