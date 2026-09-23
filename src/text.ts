/**
 * Line handling and the normalisations every other module agrees on.
 */

/** Splits text into lines without their terminators. A final newline adds no line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The line ending a file already uses, so a rewrite does not flip it. Decided by
 * the first terminator; a file with none is written with LF.
 */
export function lineEnding(text: string): '\n' | '\r\n' {
  const first = text.indexOf('\n');
  return first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
}

/** Joins lines with the given ending and a final newline. */
export function joinLines(lines: readonly string[], eol: '\n' | '\r\n'): string {
  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** CRLF and a byte-order mark are storage details, not content. */
export function canonicalText(text: string): string {
  return stripBom(text).replace(/\r\n/g, '\n');
}

/**
 * The form in which two section names are compared.
 *
 * Headings are typed by people and pasted from documents, so the comparison
 * forgives what does not change meaning: typographic apostrophes and quotes,
 * emphasis and code markers, a leading number, a trailing colon, case and runs
 * of whitespace. `## 2. Commander’s Intent:` and `Commander's Intent` compare
 * equal. Nothing else is folded: a different word is a different section.
 */
export function normaliseLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201b\u2032\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether a heading names a section: equal after normalisation, or the section
 * name followed by a separator and a qualifier, as in `Invariants (must hold)`
 * or `Deliverables — round two`.
 */
export function labelMatches(heading: string, name: string): boolean {
  const h = normaliseLabel(heading);
  const n = normaliseLabel(name);
  if (n.length === 0) return false;
  if (h === n) return true;
  if (!h.startsWith(n)) return false;
  const rest = h.slice(n.length);
  return /^(?:\s*[:(\u2014\u2013]|\s+-\s)/.test(rest);
}

/**
 * A file-name slug: lower case, ASCII letters and digits, single hyphens.
 * Letters with diacritics lose them; anything else becomes a separator.
 */
export function slugify(title: string, maxLength = 80): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastBreak = cut.lastIndexOf('-');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/** Fills `{name}` holes. An unknown name is left as written. */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (hole, name: string) => values[name] ?? hole);
}

/** The `{name}` holes a template line refers to. */
export function templateHoles(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] as string);
}
