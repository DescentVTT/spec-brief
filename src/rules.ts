/**
 * The built-in rules. Each is a pure function of one brief and the corpus
 * around it, and returns what it found with 1-based lines.
 *
 * Structure is checked on live briefs only. An archived brief is a frozen
 * record of the tree before a round, and holding it to today's schema would
 * ask somebody to edit what must not be edited; the rules that do reach the
 * archive are about identity and the freeze itself.
 */

import { BUILT_IN_FIELDS, type Brief, knownFields, lineOfField } from './brief.js';
import { type Config, type SectionRule, statusWords } from './config.js';
import { type Corpus, dependencyCycles, duplicateIds, idKey, resolveDependency } from './corpus.js';
import { findEntry } from './frontmatter.js';
import { integrityOf } from './integrity.js';
import { type Glob, hasExtension, held, isGlobSyntax, matchGlob, parseGlob, readingIn, treeOf, WITNESS_BUDGET } from './glob.js';
import { hasContent, type Section } from './markdown.js';
import { closest } from './schema.js';
import { contradictions, patternsOf, scopeOf, type ScopePattern } from './scope.js';
import { inWords, labelMatches } from './text.js';
import { namesAnEvent } from './trigger.js';
import type { Severity, SeveritySetting } from './types.js';

export interface RuleResult {
  /** 1-based. */
  readonly line: number;
  readonly message: string;
  readonly hint?: string | undefined;
  /** Lower than the rule's severity for this one finding, as a draft's unwritten sections are. */
  readonly severity?: Severity | undefined;
}

export interface RuleContext {
  readonly brief: Brief;
  readonly corpus: Corpus;
  readonly config: Config;
  /** The files git sees, or every file without git; `null` when unknown. A rule that needs them stays quiet without them. */
  readonly repoFiles: readonly string[] | null;
  /** Analyses computed once per run and shared by every brief. */
  readonly shared: SharedAnalysis;
  /** A plugin's options from the configuration. */
  readonly options?: unknown;
}

/** What a rule is called, how loud it is by default, and what it checks. */
export interface RuleInfo {
  readonly id: string;
  readonly severity: SeveritySetting;
  readonly description: string;
}

export interface Rule extends RuleInfo {
  check(context: RuleContext): readonly RuleResult[] | Promise<readonly RuleResult[]>;
}

export interface SharedAnalysis {
  readonly cycles: readonly (readonly Brief[])[];
  readonly duplicates: ReadonlyMap<string, readonly Brief[]>;
}

export function analyse(corpus: Corpus): SharedAnalysis {
  return { cycles: dependencyCycles(corpus), duplicates: duplicateIds(corpus) };
}

const at = (line0: number): number => line0 + 1;

/** The sections a brief must carry: the configured ones, then its type's. */
export function sectionRules(brief: Brief, config: Config): SectionRule[] {
  const typed = brief.type === null ? [] : (config.types[brief.type] ?? []);
  return [...config.sections, ...typed];
}

/** The headings that fill a section rule. */
export function sectionsFilling(brief: Brief, rule: SectionRule): Section[] {
  const names = [rule.name, ...rule.aliases];
  return brief.sections.filter((s) => names.some((name) => labelMatches(s.heading.text, name)));
}

/** A section's own lines that carry content: comments dropped, sub-headings not counted. */
function contentLines(brief: Brief, section: Section): number[] {
  const headingLines = new Set(brief.scan.headings.map((h) => h.line));
  const lines: number[] = [];
  for (let i = section.heading.line + 1; i < section.end; i += 1) {
    if (!headingLines.has(i) && hasContent(brief.scan.prose[i] as string)) lines.push(i);
  }
  return lines;
}

function isPlaceholder(line: string, placeholders: readonly string[]): boolean {
  const text = line
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/[*_]/g, '')
    .trim();
  if (text === '') return true;
  const lower = text.toLowerCase();
  return placeholders.some((p) => {
    const word = p.toLowerCase();
    return lower === word || (lower.startsWith(word) && /^[\s:.\-\u2014]/.test(lower.slice(word.length)));
  });
}

/** Completeness findings on a draft are reminders, not failures. */
function leniency(brief: Brief): Severity | undefined {
  return brief.status === 'draft' ? 'warning' : undefined;
}

function live(check: (context: RuleContext) => RuleResult[]): (context: RuleContext) => RuleResult[] {
  return (context) => (context.brief.phase === 'live' ? check(context) : []);
}

const SCOPE_FIELDS = ['affectedFiles', 'protectedFiles'] as const;

const quoted = (items: readonly string[]): string => inWords(items.map((item) => `"${item}"`));

/**
 * The paths a pattern names with no glob syntax that the tree does not hold
 * and whose names carry no extension. The tree reads each as a file, and the
 * spelling cannot say whether a directory was meant.
 */
export function unheldLiterals(glob: Glob, files: readonly string[]): string[] {
  const tree = treeOf(files);
  return glob.literals
    .map((literal) => literal.path)
    .filter((path) => held(tree, path) === null && !hasExtension(path.slice(path.lastIndexOf('/') + 1)));
}

/**
 * Affected patterns a brief's own protections cover entirely: one error for
 * all of them, and a warning for those the search could not decide.
 */
export function scopeContradiction(brief: Brief, repoFiles: readonly string[] | null, budget: number = WITNESS_BUDGET): RuleResult[] {
  const { covered, undecided } = contradictions(scopeOf(brief, readingIn(repoFiles)), budget);
  const line = at(lineOfField(brief, 'protectedFiles'));
  const results: RuleResult[] = [];
  if (covered.length > 0) {
    const one = covered.length === 1;
    results.push({
      line,
      message: `${quoted(covered)} in affectedFiles ${one ? 'is' : 'are'} entirely protected, so nothing of ${one ? 'it' : 'them'} is writable`,
      hint: `drop ${one ? 'it' : 'them'} from affectedFiles, or narrow protectedFiles so that some of ${one ? 'it' : 'each'} is writable`,
    });
  }
  if (undecided.length > 0) {
    results.push({
      line,
      message: `whether ${quoted(undecided)} in affectedFiles ${undecided.length === 1 ? 'is' : 'are'} entirely protected is undecided: the search met its budget`,
      hint: 'simplify the patterns until the question can be answered',
      severity: 'warning',
    });
  }
  return results;
}

export const RULES: readonly Rule[] = [
  {
    id: 'front-matter',
    severity: 'error',
    description: 'Front matter parses, with no duplicate keys and no YAML beyond the supported subset.',
    check: ({ brief }) =>
      (brief.frontMatter?.problems ?? []).map((p) => ({
        line: at(p.line),
        message: p.message,
        hint: 'front matter is flat "key: value" lines, with lists as [a, b] or "- item" lines',
      })),
  },
  {
    id: 'field',
    severity: 'error',
    description: 'Fields spec-brief reads hold values of the right shape.',
    check: ({ brief }) => brief.problems.map((p) => ({ line: at(p.line), message: p.message })),
  },
  {
    id: 'unknown-field',
    severity: 'warning',
    description: 'Front-matter keys are ones spec-brief or the configuration knows.',
    check: ({ brief, config }) => {
      const known = knownFields(config);
      return (brief.frontMatter?.entries ?? [])
        .filter((entry) => !known.has(entry.name))
        .map((entry) => {
          const guess = closest(entry.key, BUILT_IN_FIELDS);
          return {
            line: at(entry.line),
            message: `"${entry.key}" is not a key spec-brief knows`,
            hint:
              guess === undefined
                ? `if the repository uses it, list it under "fields" in the configuration`
                : `did you mean "${guess}"? If not, list "${entry.key}" under "fields" in the configuration`,
          };
        });
    },
  },
  {
    id: 'status',
    severity: 'error',
    description: 'The status agrees with where the brief lives.',
    check: ({ brief, config }) => {
      const field = config.status.field;
      if (field === null) return [];
      const line = at(lineOfField(brief, field));
      const expected = brief.phase === 'archived' ? config.status.archived : config.status.active;
      if (brief.statusWord === null) {
        return [
          {
            line,
            message: `declares no "${field}"`,
            hint: `add "${field}: ${expected}" to the front matter`,
          },
        ];
      }
      if (brief.status === null) {
        const words = statusWords(config);
        return [
          {
            line,
            message: `"${brief.statusWord}" is not a status here`,
            hint: `use one of ${words.map((w) => `"${w}"`).join(', ')}`,
          },
        ];
      }
      if (brief.phase === 'live' && brief.status === 'archived') {
        return [
          {
            line,
            message: `is marked "${brief.statusWord}" but lives in ${config.briefs}/`,
            hint: `run "spec-brief archive ${brief.id ?? brief.name}", which moves it and writes its banner`,
          },
        ];
      }
      if (brief.phase === 'archived' && brief.status !== 'archived') {
        return [
          {
            line,
            message: `lives in ${config.archive}/ but is marked "${brief.statusWord}"`,
            hint: `run "spec-brief unarchive ${brief.id ?? brief.name}" to reopen it, or set "${field}: ${config.status.archived}"`,
          },
        ];
      }
      return [];
    },
  },
  {
    id: 'id',
    severity: 'error',
    description: 'Every brief has an id with no whitespace or slashes in it.',
    check: ({ brief, config }) => {
      if (brief.id === null) {
        return [
          {
            line: 1,
            message: config.id.source === 'frontmatter' ? 'declares no "id"' : 'has no id in its file name',
            hint: config.id.source === 'frontmatter' ? 'add "id: <id>" to the front matter' : undefined,
          },
        ];
      }
      if (/[\s/\\]/.test(brief.id)) return [{ line: 1, message: `the id "${brief.id}" contains whitespace or a slash` }];
      return [];
    },
  },
  {
    id: 'duplicate-id',
    severity: 'error',
    description: 'No two briefs share an id, live or archived.',
    check: ({ brief, shared }) => {
      if (brief.id === null) return [];
      const group = shared.duplicates.get(idKey(brief.id));
      if (group === undefined || group[0] === brief) return [];
      return [
        {
          line: 1,
          message: `the id "${brief.id}" is also ${(group[0] as Brief).file}'s`,
          hint: 'ids are allocated once and never reused; give this brief the next free one',
        },
      ];
    },
  },
  {
    id: 'title',
    severity: 'warning',
    description: 'A brief has a title: a "title" field or a level-one heading.',
    check: live(({ brief }) =>
      brief.title === null ? [{ line: at(brief.bodyStart), message: 'has no title', hint: 'start the body with "# <title>"' }] : [],
    ),
  },
  {
    id: 'unknown-type',
    severity: 'error',
    description: 'A declared type is one the configuration defines.',
    check: live(({ brief, config }) => {
      if (brief.type === null || config.types[brief.type] !== undefined) return [];
      const names = Object.keys(config.types);
      return [
        {
          line: at(lineOfField(brief, 'type')),
          message: `"${brief.type}" is not a brief type here`,
          hint: names.length === 0 ? 'the configuration defines no types' : `use one of ${names.map((n) => `"${n}"`).join(', ')}`,
        },
      ];
    }),
  },
  {
    id: 'missing-section',
    severity: 'error',
    description: 'Every required section is present.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config)
        .filter((rule) => !rule.optional && sectionsFilling(brief, rule).length === 0)
        .map((rule) => {
          const heading =
            rule.aliases.length === 0
              ? `add a "## ${rule.name}" heading`
              : `add a "## ${rule.name}" heading (also accepted: ${rule.aliases.map((a) => `"${a}"`).join(', ')})`;
          return {
            line: at(brief.bodyStart),
            message: `has no "${rule.name}" section`,
            hint: rule.hint === undefined ? heading : `${heading}. ${rule.hint}`,
          };
        }),
    ),
  },
  {
    id: 'duplicate-section',
    severity: 'warning',
    description: 'A section appears once.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config).flatMap((rule) =>
        sectionsFilling(brief, rule)
          .slice(1)
          .map((s) => ({ line: at(s.heading.line), message: `a second "${rule.name}" section`, hint: 'merge the two' })),
      ),
    ),
  },
  {
    id: 'empty-section',
    severity: 'error',
    description: 'A section carries content; a comment alone is not content.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config).flatMap((rule) =>
        sectionsFilling(brief, rule)
          .slice(0, 1)
          .filter((s) => contentLines(brief, s).length === 0)
          .map((s) => ({
            line: at(s.heading.line),
            message: `the "${rule.name}" section is empty`,
            hint: rule.hint ?? 'write it; a comment alone is not content',
            severity: leniency(brief),
          })),
      ),
    ),
  },
  {
    id: 'placeholder',
    severity: 'error',
    description: 'A section says something: not only "TBD", "TODO" or an empty box.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config).flatMap((rule) =>
        sectionsFilling(brief, rule)
          .slice(0, 1)
          .filter((s) => {
            const lines = contentLines(brief, s);
            return lines.length > 0 && lines.every((i) => isPlaceholder(brief.scan.prose[i] as string, config.placeholders));
          })
          .map((s) => ({
            line: at(s.heading.line),
            message: `the "${rule.name}" section holds only a placeholder`,
            hint: rule.hint ?? 'replace the placeholder with what the section must say',
            severity: leniency(brief),
          })),
      ),
    ),
  },
  {
    id: 'missing-checklist',
    severity: 'error',
    description: 'A checklist section holds at least one task item.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config)
        .filter((rule) => rule.checklist)
        .flatMap((rule) =>
          sectionsFilling(brief, rule)
            .slice(0, 1)
            .filter((s) => !brief.tasks.some((t) => t.line > s.heading.line && t.line < s.end))
            .map((s) => ({
              line: at(s.heading.line),
              message: `the "${rule.name}" section has no "- [ ]" items`,
              hint: 'write each check as a task item, so it has a state that can be closed',
              severity: leniency(brief),
            })),
        ),
    ),
  },
  {
    id: 'must-contain',
    severity: 'error',
    description: 'A section contains the text the configuration requires of it.',
    check: live(({ brief, config }) =>
      sectionRules(brief, config).flatMap((rule) => {
        const section = sectionsFilling(brief, rule)[0];
        if (section === undefined) return [];
        const body = brief.scan.prose.slice(section.heading.line + 1, section.end).join('\n');
        return rule.mustContain
          .filter((text) => !body.includes(text))
          .map((text) => ({ line: at(section.heading.line), message: `the "${rule.name}" section must contain "${text}"` }));
      }),
    ),
  },
  {
    id: 'section-order',
    severity: 'error',
    description: 'Sections appear in the configured order, when the configuration asks for one.',
    check: live(({ brief, config }) => {
      if (!config.sectionOrder) return [];
      const placed = sectionRules(brief, config)
        .map((rule) => ({ rule, section: sectionsFilling(brief, rule)[0] }))
        .filter((p): p is { rule: SectionRule; section: Section } => p.section !== undefined);
      for (let i = 1; i < placed.length; i += 1) {
        const before = placed[i - 1] as { rule: SectionRule; section: Section };
        const current = placed[i] as { rule: SectionRule; section: Section };
        if (current.section.heading.line < before.section.heading.line) {
          return [
            {
              line: at(current.section.heading.line),
              message: `"${current.rule.name}" comes before "${before.rule.name}"`,
              hint: `the order is ${sectionRules(brief, config)
                .map((r) => r.name)
                .join(', ')}`,
            },
          ];
        }
      }
      return [];
    }),
  },
  {
    id: 'dependency',
    severity: 'error',
    description: 'Every dependency names another brief that exists.',
    check: live(({ brief, corpus }) =>
      brief.dependsOn.flatMap((dependency) => {
        const line = at(lineOfField(brief, 'dependsOn'));
        if (brief.id !== null && idKey(dependency) === idKey(brief.id)) {
          return [{ line, message: 'depends on itself' }];
        }
        if (resolveDependency(corpus, dependency) === undefined) {
          return [{ line, message: `depends on "${dependency}", which is not a brief here` }];
        }
        return [];
      }),
    ),
  },
  {
    id: 'dependency-cycle',
    severity: 'error',
    description: 'Dependencies between live briefs form no cycle.',
    check: live(({ brief, shared }) =>
      shared.cycles
        .filter((cycle) => cycle[0] === brief)
        .map((cycle) => ({
          line: at(lineOfField(brief, 'dependsOn')),
          message: `dependencies form a cycle: ${cycle.map((b) => b.id ?? b.name).join(' -> ')}`,
          hint: 'a cycle can never become ready; remove the dependency that is not real',
        })),
    ),
  },
  {
    id: 'wave-order',
    severity: 'error',
    description: 'A dependency that is still live runs in an earlier wave.',
    check: live(({ brief, corpus }) => {
      const wave = brief.wave;
      if (wave === null) return [];
      return brief.dependsOn.flatMap((dependency) => {
        const target = resolveDependency(corpus, dependency);
        // A self-dependency is reported once, by the dependency rule.
        if (target === undefined || target === brief || target.phase !== 'live' || target.wave === null || target.wave < wave) return [];
        return [
          {
            line: at(lineOfField(brief, 'dependsOn')),
            message: `depends on ${target.id ?? target.name}, which is in wave ${target.wave}, not before wave ${wave}`,
            hint: `move this brief to a wave after ${target.wave}, or ${target.id ?? target.name} to one before ${wave}`,
          },
        ];
      });
    }),
  },
  {
    id: 'deferral-trigger',
    severity: 'error',
    description: 'A deferred brief names in "trigger" the observable event that brings it back, not a date.',
    check: live(({ brief, config }) => {
      // A trigger of the wrong shape is the field rule's finding.
      if (brief.status !== 'deferred' || brief.problems.some((p) => p.field === 'trigger')) return [];
      const example = 'such as "when the second tenant signs" or "when p95 exceeds 200 ms"';
      const trigger = brief.trigger?.trim() ?? '';
      if (trigger === '') {
        const declared = findEntry(brief.frontMatter, 'trigger') !== undefined;
        return [
          {
            line: at(lineOfField(brief, declared ? 'trigger' : (config.status.field as string))),
            message: 'is deferred and names no "trigger"',
            hint: `add "trigger: <the event that brings it back>", ${example}`,
          },
        ];
      }
      const line = at(lineOfField(brief, 'trigger'));
      const hint = `name what must happen before the work resumes, ${example}`;
      if (config.placeholders.some((p) => p.toLowerCase() === trigger.toLowerCase())) {
        return [{ line, message: `the trigger "${trigger}" is a placeholder, not an event`, hint }];
      }
      if (!namesAnEvent(trigger)) {
        return [{ line, message: `the trigger "${trigger}" is a date or a time, not an event`, hint: `${hint}; a date arrives whether or not the reason for the work has` }];
      }
      return [];
    }),
  },
  {
    id: 'glob',
    severity: 'error',
    description: 'Every scope pattern is a glob spec-brief can read.',
    check: live(({ brief }) =>
      SCOPE_FIELDS.flatMap((field) =>
        brief[field].flatMap((pattern) => {
          const parsed = parseGlob(pattern);
          if (parsed.ok) return [];
          return [
            {
              line: at(lineOfField(brief, field)),
              message: `"${pattern}" in ${field}: ${parsed.error}`,
              hint: 'a scope is a glob relative to the repository root: "src/auth/", "src/**/*.ts", "docs/{a,b}.md"',
            },
          ];
        }),
      ),
    ),
  },
  {
    id: 'scope-contradiction',
    severity: 'error',
    description: 'Something of every affected pattern is writable: no pattern lies wholly inside protectedFiles.',
    check: live(({ brief, repoFiles }) => scopeContradiction(brief, repoFiles)),
  },
  {
    id: 'glob-matches-nothing',
    severity: 'note',
    description: 'A scope pattern matches at least one file in the tree.',
    check: live(({ brief, repoFiles }) => {
      if (repoFiles === null) return [];
      const reading = readingIn(repoFiles);
      return SCOPE_FIELDS.flatMap((field) =>
        patternsOf(brief[field], reading)
          // A literal the tree does not hold is literal-read-as-file's finding.
          .filter((p) => unheldLiterals(p.glob, repoFiles).length === 0 && !repoFiles.some((file) => matchGlob(p.glob, file)))
          .map((p) => ({
            line: at(lineOfField(brief, field)),
            message: `"${p.pattern}" in ${field} matches no file in the tree`,
            hint: 'expected when the round creates it; otherwise check the spelling',
          })),
      );
    }),
  },
  {
    id: 'literal-read-as-file',
    severity: 'note',
    description: 'A path with no glob syntax that the tree does not hold, and whose name has no extension, says whether it is a directory.',
    check: live(({ brief, repoFiles }) => {
      if (repoFiles === null) return [];
      const reading = readingIn(repoFiles);
      return SCOPE_FIELDS.flatMap((field) =>
        patternsOf(brief[field], reading).flatMap(({ pattern, glob }: ScopePattern) => {
          const paths = unheldLiterals(glob, repoFiles);
          if (paths.length === 0) return [];
          const line = at(lineOfField(brief, field));
          if (!isGlobSyntax(pattern)) {
            return [
              {
                line,
                message: `"${pattern}" in ${field} is not in the tree and is read as a file`,
                hint: `write "${pattern.trim()}/" for a directory`,
              },
            ];
          }
          return [
            {
              line,
              message: `"${pattern}" in ${field} names ${inWords(paths)}, which ${paths.length === 1 ? 'is' : 'are'} not in the tree and ${paths.length === 1 ? 'is' : 'are'} read as ${paths.length === 1 ? 'a file' : 'files'}`,
              hint: 'write a directory with a trailing "/", in an entry of its own',
            },
          ];
        }),
      );
    }),
  },
  {
    id: 'archive-freeze',
    severity: 'error',
    description: 'An archived brief has not changed since it was archived.',
    check: ({ brief }) => {
      if (brief.phase !== 'archived' || brief.integrity === null) return [];
      if (integrityOf(brief.text) === brief.integrity) return [];
      return [
        {
          line: at(lineOfField(brief, 'integrity')),
          message: 'has changed since it was archived',
          hint: 'an archived brief is frozen: restore it from git, or unarchive it to reopen the round',
        },
      ];
    },
  },
];

/**
 * The rules the collision analysis reports under. They are not run per brief,
 * so they carry no check: they exist so configuration can set their severity
 * and reports can describe them.
 */
export const COLLISION_RULES: readonly RuleInfo[] = [
  { id: 'collision', severity: 'error', description: 'Briefs in one wave do not write the same file.' },
  {
    id: 'collision-undecided',
    severity: 'warning',
    description: 'Whether two briefs in one wave can write the same file is decided within the search budget.',
  },
  { id: 'unscoped', severity: 'note', description: 'A brief sharing a wave declares the files it writes.' },
  { id: 'shared-directory', severity: 'off', description: 'Briefs in one wave do not write into the same directory.' },
];

/**
 * The rules archival reports under beside its refusals. Like the collision
 * rules they carry no check: the planner raises them, and they exist so
 * configuration can set their severity and reports can describe them.
 */
export const ARCHIVE_RULES: readonly RuleInfo[] = [
  {
    id: 'scope-unmeasured',
    severity: 'warning',
    description: 'A brief that declares a scope is archived against the changes its round made.',
  },
  {
    id: 'stale-link',
    severity: 'warning',
    description: 'No live brief is left linking to where a moved brief used to be.',
  },
];
