/**
 * Writing a new brief: the next free id, a file name, and a body with every
 * section the configuration requires, each holding a hint in a comment.
 * Comments are not content, so a freshly scaffolded brief reads as unwritten
 * until somebody writes it.
 */

import { type Config, DEFAULT_CONFIG, type SectionRule } from './config.js';
import type { Corpus } from './corpus.js';
import { renderScalar } from './frontmatter.js';
import { fillTemplate, slugify } from './text.js';

export interface NewBrief {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly type?: string | undefined;
  readonly wave?: number | undefined;
  readonly dependsOn?: readonly string[] | undefined;
}

/**
 * The next id: one more than the highest numeric id, live or archived, at the
 * configured width. Ids are never reused, so an archived brief still holds
 * its number. `null` when the corpus has ids but none of them are numbers.
 */
export function nextId(corpus: Corpus): string | null {
  const ids = corpus.briefs.map((b) => b.id).filter((id): id is string => id !== null);
  const numeric = ids.filter((id) => /^\d+$/.test(id)).map(Number);
  if (numeric.length === 0 && ids.length > 0) return null;
  const next = numeric.length === 0 ? 1 : Math.max(...numeric) + 1;
  return String(next).padStart(corpus.config.id.digits, '0');
}

export function fileNameFor(config: Config, id: string, title: string): string {
  const slug = slugify(title);
  if (config.id.source === 'frontmatter') return `${slug === '' ? id : slug}.md`;
  return slug === '' ? `${id}.md` : `${id}${config.id.separator}${slug}.md`;
}

const DEFAULT_RULES: readonly SectionRule[] = [...DEFAULT_CONFIG.sections, ...Object.values(DEFAULT_CONFIG.types).flat()];

/**
 * What a new brief says under a heading: the section's configured hint, or the
 * default section's of the same name - a configuration written before hints
 * existed names its sections without one - or a plain instruction. A "-->"
 * would end the comment early and leave the rest as content, so it is broken.
 */
function hint(rule: SectionRule): string {
  const text = rule.hint ?? DEFAULT_RULES.find((d) => d.name.toLowerCase() === rule.name.toLowerCase())?.hint ?? `Write the ${rule.name}.`;
  return text.replaceAll('-->', '-- >');
}

function frontMatter(config: Config, brief: NewBrief): string[] {
  const lines = ['---'];
  if (config.id.source === 'frontmatter') lines.push(`id: ${renderScalar(brief.id)}`);
  if (config.status.field !== null) {
    lines.push(`${config.status.field}: ${renderScalar(config.status.draft ?? config.status.active)}`);
  }
  lines.push(`date: ${brief.date}`);
  if (brief.type !== undefined) lines.push(`type: ${renderScalar(brief.type)}`);
  if (brief.wave !== undefined) lines.push(`wave: ${brief.wave}`);
  if (brief.dependsOn !== undefined && brief.dependsOn.length > 0) {
    lines.push(`dependsOn: [${brief.dependsOn.map((d) => JSON.stringify(d)).join(', ')}]`);
  }
  lines.push('affectedFiles: []', 'protectedFiles: []', '---');
  return lines;
}

/** The text of a new brief, from the configured template or from the section list. */
export function renderNewBrief(config: Config, brief: NewBrief, template: string | null): string {
  if (template !== null) {
    return fillTemplate(template, {
      id: brief.id,
      title: brief.title,
      date: brief.date,
      type: brief.type ?? '',
      wave: brief.wave === undefined ? '' : String(brief.wave),
      status: config.status.draft ?? config.status.active,
    });
  }
  const typed = brief.type === undefined ? [] : (config.types[brief.type] ?? []);
  const lines = [...frontMatter(config, brief), '', `# ${brief.id} \u2014 ${brief.title}`];
  for (const rule of [...config.sections, ...typed]) {
    lines.push('', `## ${rule.name}`, '', `<!-- ${hint(rule)} -->`);
    // Text a section must contain is written in, so it is not forgotten.
    if (rule.mustContain.length > 0) lines.push('', ...rule.mustContain.map((text) => `- ${text}`));
    if (rule.checklist) lines.push('', '- [ ] <!-- one check -->');
  }
  return `${lines.join('\n')}\n`;
}
