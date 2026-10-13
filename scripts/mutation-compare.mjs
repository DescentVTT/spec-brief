/**
 * The mutants a sweep left undetected that main's sweep did not.
 *
 * The gates do not say it. Main's full sweep reads 99.31% with 50 mutants
 * undetected of 7,250, and would read 99.28% with 52: both pass a `break` of
 * 97, and the two that a change brought are in neither number. They were
 * found by setting a sweep's report beside main's by hand, release by
 * release (ADR-0009). Each sweep now does that for itself, in the job that
 * has its report.
 *
 * A mutant is its file, its mutator, the text it replaces and what replaces
 * it. Never its line: a comment added above a mutant moves it and changes
 * nothing about it, and another condition written on the same line is
 * another mutant. Where one file has the same text replaced by the same
 * thing in several places, a report cannot say which of them is which, so
 * they are counted: three here where main's had two is one new, at one of
 * the three lines given. It follows that a mutant whose own text was edited
 * reads as new, and its old self as gone; so does everything undetected in a
 * file main's sweep did not mutate.
 *
 * No mutant fails the run. A new one may be equivalent, and is then said so
 * beside its code; the score is the gate's. And where there is no report of
 * main's to set this one beside, that is what is said: a comparison nobody
 * made has found nothing, which is not the same as none.
 *
 *   node scripts/mutation-compare.mjs <main's mutation.json> <this sweep's mutation.json>
 *   node scripts/mutation-compare.mjs --main <artifact> <this sweep's mutation.json>
 *
 * The second is the workflow's. It asks GitHub, through `gh`, for the newest
 * sweep of main that passed and still has the artifact named, `mutation-core`
 * or `mutation-full`, so the token in `GH_TOKEN` has to be one that may read
 * Actions.
 *
 * Exit 0: the comparison, or the sentence that none was made. Exit 2: this
 * sweep's own report, or one named by hand, could not be read, or the
 * arguments were not one of the two forms.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** What is wrong with a report or with the arguments: exit 2, with its message alone. */
export class CompareError extends Error {}

/** The workflow whose runs are main's sweeps, and the file each sweep's artifact holds its report in. */
const WORKFLOW = 'mutation.yml';
const REPORT = 'mutation.json';

/** The verdicts a score counts against a sweep: every test passed, or no test ran. */
const UNDETECTED = { Survived: 'survived', NoCoverage: 'no test reaches it' };

/**
 * The text between two places of a source, as a report gives them: lines and
 * columns from one, the end being the first character that is not part of it.
 */
export function textAt(source, location) {
  const lines = source.split('\n');
  const { start, end } = location;
  const from = lines[start.line - 1] ?? '';
  if (start.line === end.line) return from.slice(start.column - 1, end.column - 1);
  return [from.slice(start.column - 1), ...lines.slice(start.line, end.line - 1), (lines[end.line - 1] ?? '').slice(0, end.column - 1)].join('\n');
}

const placed = (location) => [location?.start, location?.end].every((place) => Number.isInteger(place?.line) && Number.isInteger(place?.column));

/**
 * What a report left undetected, each mutant under the four things that
 * make it the same mutant in another report, with the lines it stands on in
 * this one. `whose` names the report in what is said when it cannot be read.
 */
export function undetectedOf(report, whose) {
  const files = report?.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new CompareError(`${whose} is no mutation report: it has no "files"`);
  const rows = new Map();
  const counts = { mutants: 0, survived: 0, unreached: 0 };
  for (const [file, entry] of Object.entries(files)) {
    for (const mutant of entry?.mutants ?? []) {
      counts.mutants += 1;
      if (!Object.hasOwn(UNDETECTED, mutant.status)) continue;
      // The text is all that tells one mutant from the next, so a report without it is not compared by line instead.
      if (typeof entry.source !== 'string') throw new CompareError(`${whose} has no source for ${file}, so a mutant of it cannot be told by the text it replaces`);
      if (!placed(mutant.location)) throw new CompareError(`${whose} has a mutant of ${file} with no place in its source`);
      counts[mutant.status === 'Survived' ? 'survived' : 'unreached'] += 1;
      const mutator = String(mutant.mutatorName);
      const text = textAt(entry.source, mutant.location);
      const replacement = String(mutant.replacement ?? '');
      const key = JSON.stringify([file, mutator, text, replacement]);
      const row = rows.get(key) ?? { file, mutator, text, replacement, at: [] };
      row.at.push({ line: mutant.location.start.line, verdict: UNDETECTED[mutant.status] });
      rows.set(key, row);
    }
  }
  return { counts, rows, files: Object.keys(files) };
}

/** The rows `one` has more of than `other`, each with how many more, in the order a reader goes through the files. */
function beyond(one, other) {
  const more = [];
  for (const [key, row] of one.rows) {
    const count = row.at.length - (other.rows.get(key)?.at.length ?? 0);
    if (count > 0) more.push({ ...row, at: [...row.at].sort((a, b) => a.line - b.line), count });
  }
  const first = (row) => row.at[0].line;
  return more.sort((a, b) => a.file.localeCompare(b.file) || first(a) - first(b) || a.mutator.localeCompare(b.mutator) || a.replacement.localeCompare(b.replacement));
}

const sum = (rows) => rows.reduce((total, row) => total + row.count, 0);

/**
 * This sweep's report set beside main's: the undetected mutants main's did
 * not have, those of main's that are detected or gone here, and the files
 * only one of the two sweeps mutated, which is why every mutant of such a
 * file is on one of the lists.
 */
export function compare(mains, sweeps) {
  const there = undetectedOf(mains, "main's report");
  const here = undetectedOf(sweeps, "this sweep's report");
  const added = beyond(here, there);
  const gone = beyond(there, here);
  return {
    here: here.counts,
    main: there.counts,
    added,
    gone,
    new: sum(added),
    lost: sum(gone),
    onlyHere: here.files.filter((file) => !there.files.includes(file)).sort(),
    onlyMain: there.files.filter((file) => !here.files.includes(file)).sort(),
  };
}

/** A text on one line, a long one by its two ends, and nothing at all by a word. */
function shown(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(nothing)';
  return flat.length > 96 ? `${flat.slice(0, 64)} ... ${flat.slice(-24)}` : flat;
}

const listed = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * A row as one line. It starts with the file, whatever the mutated text
 * holds: a line of a job's log that starts with `::` is a command to the
 * runner, and a pull request's source is not to be able to write one.
 */
export function rowLine(row) {
  const verdicts = listed([...new Set(row.at.map((at) => at.verdict))]);
  const lines = `line${row.at.length === 1 ? '' : 's'} ${listed(row.at.map((at) => String(at.line)))}`;
  // Which of several alike is the one that differs, no report can say: all their lines are given, with how many of them it is.
  const which = row.count < row.at.length ? `${row.count} of the ${row.at.length} alike, at ` : row.count > 1 ? `${row.count} alike, ` : '';
  return `${row.file}  ${row.mutator}  ${shown(row.text)}  ->  ${shown(row.replacement)}  (${verdicts}; ${which}${lines})`;
}

const number = (count) => count.toLocaleString('en-US');
const some = (count, one, many) => `${number(count)} ${count === 1 ? one : many}`;
const tally = (counts) => `${some(counts.mutants, 'mutant', 'mutants')}, ${number(counts.survived + counts.unreached)} undetected: ${number(counts.survived)} survived and ${number(counts.unreached)} that no test reaches`;

function fileNotes(result) {
  const notes = [];
  if (result.onlyHere.length > 0) notes.push(`mutated here and not in main's report, so everything undetected in ${result.onlyHere.length === 1 ? 'it' : 'them'} reads as new: ${listed(result.onlyHere)}`);
  if (result.onlyMain.length > 0) notes.push(`in main's report and not mutated here, so everything undetected in ${result.onlyMain.length === 1 ? 'it' : 'them'} reads as gone: ${listed(result.onlyMain)}`);
  return notes;
}

/** The comparison as a job's log has it, every row of it. `against` says which report main's is. */
export function logOf(result, against) {
  const out = [`this sweep: ${tally(result.here)}`, `${against}: ${tally(result.main)}`, ...fileNotes(result), '', `new against main's: ${number(result.new)}`];
  for (const row of result.added) out.push(`  ${rowLine(row)}`);
  out.push('', `undetected in main's and not here: ${number(result.lost)}`);
  for (const row of result.gone) out.push(`  ${rowLine(row)}`);
  return out.join('\n');
}

/** The rows a summary lists, where the log lists all: a step's summary holds 1 MiB, and a row is under 400 characters. */
const SUMMARY_ROWS = 150;

/** A fence none of its rows can close: longer by one than the longest run of backticks in them, and never under three. */
function fenced(rows) {
  const longest = Math.max(2, ...(rows.join('\n').match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return [`${fence}text`, ...rows, fence].join('\n');
}

const WHAT_A_NEW_ONE_ASKS =
  'A mutant is its file, its mutator, the text it replaces and what replaces it, never its line, so one whose own text was edited is listed, and so is one of anything main took after the commit that report is of. The run is not failed for any of them: before the change merges, each is killed by a test, or said equivalent in a comment beside its code (CONTRIBUTING.md).';

/** The comparison as the Markdown of a job's summary. `sweep` says which sweep, where a run has two. */
export function summaryOf(result, sweep, against) {
  const parts = [`### ${sweep}: undetected mutants new against main: ${result.new === 0 ? 'none' : number(result.new)}`];
  parts.push(`Set beside ${against}: ${number(result.main.survived + result.main.unreached)} undetected there, ${number(result.here.survived + result.here.unreached)} here.`);
  for (const note of fileNotes(result)) parts.push(`Files ${note}.`);
  if (result.new > 0) {
    parts.push(fenced(result.added.slice(0, SUMMARY_ROWS).map(rowLine)));
    if (result.added.length > SUMMARY_ROWS) parts.push(`${some(result.added.length - SUMMARY_ROWS, 'more row is', 'more rows are')} in the job's log.`);
    parts.push(WHAT_A_NEW_ONE_ASKS);
  }
  if (result.lost > 0) parts.push(`${some(result.lost, "mutant that main's sweep left undetected is", "mutants that main's sweep left undetected are")} detected or gone here; the job's log lists ${result.lost === 1 ? 'it' : 'them'}.`);
  return `${parts.join('\n\n')}\n\n`;
}

/** What is said where nothing was compared. It is never to read as a comparison that found none. */
export function notCompared(reason) {
  return `Not compared with main: ${reason}. This says nothing of new undetected mutants, neither that there are some nor that there are none; compare the two reports by hand, with this script.`;
}

const said = (error) => (String(error?.stderr ?? '').trim() || (error instanceof Error ? error.message : String(error))).split('\n')[0].trim();

/** Main's sweeps tried for a report before giving up: the newest may have lost its artifact, and not the four before it too. */
const TRIED = 5;

/** The events a sweep of main itself starts by. A pull request from a fork's own `main` is listed under that branch name too. */
const OF_MAIN = new Set(['push', 'schedule', 'workflow_dispatch']);

/**
 * Main's newest sweep that passed and still has the artifact, with the
 * report fetched under `directory`. `gh` runs the GitHub CLI with the
 * arguments it is given and returns what the CLI printed, or throws. `own`
 * is this run: run again, it is not what it is compared with.
 *
 * Returns the file and its run, or `reason`, why there is none.
 */
export function mainsReport({ gh, repository, artifact, directory, own }) {
  let runs;
  try {
    runs = JSON.parse(gh(['api', `repos/${repository}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&per_page=30`])).workflow_runs;
  } catch (error) {
    return { reason: `GitHub gave no list of main's sweeps (${said(error)})` };
  }
  if (!Array.isArray(runs)) return { reason: "what GitHub gave for main's sweeps is no list of runs" };
  const sweeps = runs
    .filter((run) => run.head_branch === 'main' && run.conclusion === 'success' && OF_MAIN.has(run.event) && String(run.id) !== String(own))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (sweeps.length === 0) return { reason: 'main has no sweep that passed' };
  const tried = [];
  for (const run of sweeps.slice(0, TRIED)) {
    const into = path.join(directory, String(run.id));
    try {
      gh(['run', 'download', String(run.id), '--repo', repository, '--name', artifact, '--dir', into]);
    } catch (error) {
      tried.push(`run ${run.id}: ${said(error)}`);
      continue;
    }
    // The CLI unpacks the one artifact it was asked for into the directory itself; a directory of the artifact's name under it is read as well.
    const file = [path.join(into, REPORT), path.join(into, artifact, REPORT)].find((candidate) => existsSync(candidate));
    if (file === undefined) {
      tried.push(`run ${run.id}: its ${artifact} holds no ${REPORT}`);
      continue;
    }
    return { file, run: String(run.id), sha: String(run.head_sha), created: String(run.created_at), url: String(run.html_url) };
  }
  return { reason: `${tried.length === 1 ? "main's one sweep that passed did not give" : `none of main's ${tried.length} newest sweeps that passed gave`} its ${artifact} (${tried.join('; ')})` };
}

function reportAt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CompareError(`${file} could not be read as a mutation report (${error instanceof Error ? error.message : String(error)})`);
  }
}

const USAGE = "usage: node scripts/mutation-compare.mjs <main's mutation.json> <this sweep's mutation.json>\n       node scripts/mutation-compare.mjs --main <artifact> <this sweep's mutation.json>";

// A call that does not come back is ended; the comparison is then one that was not made.
const cli = (env) => (args) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });

/**
 * `directory` is where main's report is fetched to: under `reports/`, which
 * git ignores, and outside the directory a sweep uploads as its own.
 */
export function main(argv, { env = process.env, gh = cli(env), directory = path.join('reports', 'main'), log = console.log, fail = console.error } = {}) {
  const marked = (kind) => (env.GITHUB_ACTIONS === 'true' ? `::${kind}::` : '');
  const summarise = (text) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  };
  const fetched = argv[0] === '--main';
  const [first, second] = fetched ? argv.slice(1) : argv;
  if (argv.length !== (fetched ? 3 : 2) || first === '' || second === '' || first.startsWith('-') || second.startsWith('-')) {
    fail(USAGE);
    return 2;
  }
  try {
    const sweeps = reportAt(second);
    // Before GitHub is asked anything: a sweep without a report of its own has nothing to set beside main's.
    undetectedOf(sweeps, "this sweep's report");
    let mains;
    let against;
    let linked;
    let sweep = path.basename(path.dirname(path.resolve(second)));
    if (fetched) {
      sweep = first;
      const found = mainsReport({ gh, repository: env.GITHUB_REPOSITORY ?? '', artifact: first, directory, own: env.GITHUB_RUN_ID ?? '' });
      let reason = found.reason;
      if (reason === undefined) {
        try {
          mains = reportAt(found.file);
          undetectedOf(mains, "main's report");
        } catch (error) {
          // Whatever is wrong with it: nothing about main's report fails the sweep of a change.
          reason = `the ${first} of run ${found.run} cannot be used (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      if (reason !== undefined) {
        const sentence = notCompared(reason);
        log(`${marked('warning')}${sentence}`);
        summarise(`### ${sweep}: undetected mutants new against main: not compared\n\n${sentence}\n\n`);
        return 0;
      }
      const of = `of ${found.sha.slice(0, 7)}, ${found.created.slice(0, 10)}`;
      against = `main's newest sweep that passed and has its ${first}, run ${found.run} ${of}`;
      linked = `main's newest sweep that passed and has its ${first}, [run ${found.run}](${found.url}) ${of}`;
    } else {
      mains = reportAt(first);
      against = first;
      linked = `\`${first}\``;
    }
    const result = compare(mains, sweeps);
    log(logOf(result, against));
    if (result.new > 0) log(`\n${marked('notice')}${sweep}: ${some(result.new, 'undetected mutant is', 'undetected mutants are')} new against ${against}. The run is not failed for ${result.new === 1 ? 'it' : 'them'}: each is killed by a test, or said equivalent beside its code, before the change merges.`);
    summarise(summaryOf(result, sweep, linked));
    return 0;
  } catch (error) {
    if (!(error instanceof CompareError)) throw error;
    fail(`${marked('error')}mutation-compare: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
