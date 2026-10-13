// Types for the tests that import scripts/mutation-compare.mjs. A report is
// Stryker's mutation-testing-report-schema object, typed only as far as the
// script reads it; what a test hands it to be refused is typed as unknown.

export interface Position {
  line: number;
  column: number;
}

export interface Location {
  start: Position;
  end: Position;
}

export interface Mutant {
  mutatorName: string;
  replacement?: string;
  status: string;
  location: Location;
  [field: string]: unknown;
}

export interface Report {
  files: Record<string, { source?: string; mutants?: Mutant[]; [field: string]: unknown }>;
  [field: string]: unknown;
}

/** One undetected mutant, or several a report cannot tell apart, with each line they stand on. */
export interface Row {
  file: string;
  mutator: string;
  text: string;
  replacement: string;
  at: { line: number; verdict: string }[];
}

export interface Counts {
  mutants: number;
  survived: number;
  unreached: number;
}

export interface Undetected {
  counts: Counts;
  rows: Map<string, Row>;
  files: string[];
}

/** A row of a comparison: `count` of its mutants are on one side and not the other. */
export type Differing = Row & { count: number };

export interface Compared {
  here: Counts;
  main: Counts;
  added: Differing[];
  gone: Differing[];
  new: number;
  lost: number;
  onlyHere: string[];
  onlyMain: string[];
}

/** The GitHub CLI: the arguments in, what it printed out, or a throw. */
export type Gh = (args: string[]) => string;

export type Found = { file: string; run: string; sha: string; created: string; url: string; reason?: undefined } | { reason: string };

export interface Run {
  env?: Readonly<Record<string, string | undefined>>;
  gh?: Gh;
  directory?: string;
  log?: (text: string) => void;
  fail?: (text: string) => void;
}

export declare class CompareError extends Error {}
export declare function textAt(source: string, location: Location): string;
export declare function undetectedOf(report: unknown, whose: string): Undetected;
export declare function compare(mains: unknown, sweeps: unknown): Compared;
export declare function rowLine(row: Differing): string;
export declare function logOf(result: Compared, against: string): string;
export declare function summaryOf(result: Compared, sweep: string, against: string): string;
export declare function notCompared(reason: string): string;
export declare function mainsReport(options: { gh: Gh; repository: string; artifact: string; directory: string; own: string }): Found;
export declare function main(argv: readonly string[], run?: Run): number;
