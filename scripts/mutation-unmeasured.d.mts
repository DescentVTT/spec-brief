// Types for the tests that import scripts/mutation-unmeasured.mjs. A report is
// Stryker's mutation-testing-report-schema object, typed only as far as the
// script reads it.

export interface Position {
  line: number;
  column: number;
}

export interface Mutant {
  location: { start: Position; end: Position };
  [field: string]: unknown;
}

export interface Report {
  files: Record<string, { source: string; mutants: Mutant[]; [field: string]: unknown }>;
  [field: string]: unknown;
}

/** A source read into a syntax tree, which the script walks without naming its nodes. */
export type Parse = (source: string) => { program: unknown };

export interface Unmeasured {
  line: number;
  sites: number;
  text: string;
  loc: { start: Position; end: Position };
}

export interface Measured {
  files: string[];
  mutants: number;
  mutated: number;
  rows: { file: string; line: number; sites: number; text: string }[];
}

export declare const LEFT: Readonly<Record<string, number>>;
export declare class UnmeasuredError extends Error {}
/** `from` is where the search for Stryker's parser starts: this script, unless a test says otherwise. */
export declare function parser(from?: string): Promise<Parse>;
export declare function unmeasured(source: string, parse: Parse): Unmeasured[];
export declare function measure(report: Report, parse: Parse): Measured;
export declare function gate(measured: Measured, left?: Readonly<Record<string, number>>): string[];
export declare function main(argv: readonly string[], out?: (line: string) => void): Promise<number>;
