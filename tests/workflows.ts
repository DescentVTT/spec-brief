/**
 * A workflow read as it is written here, for the tests that hold one to a
 * decision: blocks by indentation, two spaces a level, and a list as a dash.
 * No YAML parser is a dependency of this package, and none is needed for
 * files this repository writes itself. A test that reads a block compares
 * the whole of it, so a line this reading cannot follow fails that test and
 * does not pass unread.
 */

/** The lines that say something to GitHub: no comment, no blank line. */
export function written(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(?:^|\s)#.*$/, '').trimEnd())
    .filter((line) => line !== '');
}

/** The lines under a key that stands at the margin of `lines`, with their two spaces taken off. */
export function under(lines: readonly string[], key: string): string[] {
  const from = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (from === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith(' ')) break;
    block.push(line.slice(2));
  }
  return block;
}

/** A job's steps, each as its lines without the dash and the indent under it. */
export function stepsOf(job: readonly string[]): string[][] {
  const steps: string[][] = [];
  for (const line of under(job, 'steps')) {
    if (line.startsWith('- ')) steps.push([line.slice(2)]);
    else steps.at(-1)?.push(line.slice(2));
  }
  return steps;
}
