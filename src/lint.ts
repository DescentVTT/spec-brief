/**
 * Running rules: severities from the configuration, plugins beside the
 * built-in rules, findings in a stable order.
 */

import type { Waiver } from './archive.js';
import type { Brief } from './brief.js';
import { ConfigError } from './config.js';
import type { Corpus } from './corpus.js';
import { analyse, ARCHIVE_RULES, COLLISION_RULES, type Rule, type RuleInfo, RULES } from './rules.js';
import type { Finding, Severity, SeveritySetting } from './types.js';

/** What a plugin's `waive` hook is asked about: one archival, refused. */
export interface WaiveContext {
  /** The absolute root: the directory holding the configuration. */
  readonly root: string;
  readonly brief: { readonly id: string | null; readonly file: string; readonly text: string };
  /**
   * Every finding that refuses the archival, as a frozen copy: writing to it
   * throws, and the waivers are matched against the plan's own. A
   * `protected-file` finding names its `path`; an `out-of-scope` one lists its
   * `paths`. Only those two can be waived.
   */
  readonly findings: readonly Finding[];
  /** The base the round is measured from, as it was given; `null` when none was. */
  readonly base: string | null;
  /** The commit the round landed as; `null` when none was read. */
  readonly commit: string | null;
}

export interface Plugin {
  /** Prefixes the plugin's rule ids: `<name>/<rule>`. */
  readonly name: string;
  readonly rules: readonly Rule[];
  /** The plugin's entry in the configuration, handed to each rule. */
  readonly options?: unknown;
  /**
   * Lifts refusals of an archival that the plugin's own check allows - a
   * protected file a verified ruling covers - by rule and path. Asked only
   * when the plan has a refusal it could lift. Returning nothing waives
   * nothing.
   */
  readonly waive?: ((context: WaiveContext) => readonly Waiver[] | void | Promise<readonly Waiver[] | void>) | undefined;
}

export interface LintOptions {
  readonly plugins?: readonly Plugin[];
  /** Tracked files, for the rules that read the tree. */
  readonly repoFiles?: readonly string[] | null;
  /** Limit the findings to these briefs. The whole corpus is still read. */
  readonly only?: readonly Brief[];
}

const RANK: Readonly<Record<Severity, number>> = { note: 0, warning: 1, error: 2 };

function lower(a: Severity, b: Severity): Severity {
  return RANK[a] <= RANK[b] ? a : b;
}

interface ActiveRule {
  readonly id: string;
  readonly rule: Rule;
  readonly severity: SeveritySetting;
  readonly options: unknown;
}

/** Every rule id a run knows: built-in, collision, archive and plugin. */
export function ruleIds(plugins: readonly Plugin[] = []): string[] {
  return [
    ...RULES.map((r) => r.id),
    ...COLLISION_RULES.map((r) => r.id),
    ...ARCHIVE_RULES.map((r) => r.id),
    ...plugins.flatMap((p) => p.rules.map((r) => `${p.name}/${r.id}`)),
  ];
}

/** The severity configuration assigns a rule, or its own. */
export function severityOf(corpus: Corpus, id: string, fallback: SeveritySetting): SeveritySetting {
  return corpus.config.rules[id] ?? fallback;
}

/** The severity of a built-in rule as configured, or `null` when it is off. */
export function configuredSeverity(corpus: Corpus, id: string): Severity | null {
  const rule = [...RULES, ...COLLISION_RULES, ...ARCHIVE_RULES].find((r) => r.id === id) as RuleInfo;
  const setting = severityOf(corpus, id, rule.severity);
  return setting === 'off' ? null : setting;
}

/** Refuses a configuration that names a rule nobody defines: a typo there silences nothing. */
export function checkRuleIds(corpus: Corpus, plugins: readonly Plugin[] = []): void {
  const known = new Set(ruleIds(plugins));
  const unknown = Object.keys(corpus.config.rules).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ConfigError('configuration', unknown.map((id) => `"rules.${id}" names no rule`));
  }
}

export async function lint(corpus: Corpus, options: LintOptions = {}): Promise<Finding[]> {
  const plugins = options.plugins ?? [];
  checkRuleIds(corpus, plugins);
  const active: ActiveRule[] = [
    ...RULES.map((rule) => ({ id: rule.id, rule, severity: severityOf(corpus, rule.id, rule.severity), options: undefined })),
    ...plugins.flatMap((plugin) =>
      plugin.rules.map((rule) => {
        const id = `${plugin.name}/${rule.id}`;
        return { id, rule, severity: severityOf(corpus, id, rule.severity), options: plugin.options };
      }),
    ),
  ].filter((r) => r.severity !== 'off');

  const shared = analyse(corpus);
  const targets = options.only ?? corpus.briefs;
  const findings: Finding[] = [];
  for (const brief of targets) {
    for (const { id, rule, severity, options: ruleOptions } of active) {
      const results = await rule.check({
        brief,
        corpus,
        config: corpus.config,
        repoFiles: options.repoFiles ?? null,
        shared,
        options: ruleOptions,
      });
      for (const result of results) {
        const configured = severity as Severity;
        findings.push({
          rule: id,
          severity: result.severity === undefined ? configured : lower(result.severity, configured),
          message: result.message,
          file: brief.file,
          line: Math.max(1, Math.trunc(result.line)),
          brief: brief.id ?? undefined,
          hint: result.hint,
        });
      }
    }
  }
  return sortFindings(findings);
}

/** Strings by code unit, which is the same order on every host and in every locale. */
function order(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => order(a.file, b.file) || a.line - b.line || order(a.rule, b.rule) || order(a.message, b.message),
  );
}

export interface Summary {
  readonly errors: number;
  readonly warnings: number;
  readonly notes: number;
}

export function summarise(findings: readonly Finding[]): Summary {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    notes: findings.filter((f) => f.severity === 'note').length,
  };
}

/** Whether findings fail a run: any error, or any warning under `--strict`. */
export function failing(findings: readonly Finding[], strict: boolean): boolean {
  return findings.some((f) => f.severity === 'error' || (strict && f.severity === 'warning'));
}
