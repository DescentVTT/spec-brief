/**
 * The freeze: a content hash an archived brief carries in its own front matter.
 *
 * Kept in the file rather than in a ledger beside it, because a ledger every
 * archival appends to is one more file that two rounds merging in parallel
 * both edit. The hash covers every line except its own, after CRLF and a
 * byte-order mark are normalised away, so a checkout with `core.autocrlf`
 * reads as unchanged and an edited word does not.
 */

import { createHash } from 'node:crypto';

import { readFrontMatter, removeEntry } from './frontmatter.js';
import { canonicalText, splitLines } from './text.js';

export const INTEGRITY_FIELD = 'integrity';

export function integrityOf(text: string): string {
  const lines = splitLines(canonicalText(text));
  const without = removeEntry(lines, readFrontMatter(lines), INTEGRITY_FIELD);
  const digest = createHash('sha256').update(`${without.join('\n')}\n`).digest('hex');
  return `sha256-${digest}`;
}
