import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Stryker's own instrumenter, called as a library: the mutants it makes of
 * one source, with no test run and no sweep.
 *
 * What a sweep leaves unread is otherwise this repository's reading of
 * Stryker, in a comment or in a count, and a reading goes stale with the
 * next release of what it reads. The tests that say "Stryker makes no mutant
 * of this" ask the Stryker that is installed.
 *
 * The instrumenter is found as Stryker finds it, from `@stryker-mutator/core`
 * and not from the top of `node_modules`, where npm may have put another
 * copy for another package. It is slow to load and reads a source as text,
 * so the files that use it are in neither sweep's suite.
 */

/** A mutant as the instrumenter hands it over: lines and columns from zero, where a report counts from one. */
export interface Made {
  mutatorName: string;
  replacement: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export type Instrument = (name: string, source: string) => Promise<Made[]>;

export async function instrumenter(): Promise<Instrument> {
  const core = createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
  const { Instrumenter } = (await import(pathToFileURL(core.resolve('@stryker-mutator/instrumenter')).href)) as {
    Instrumenter: new (logger: object) => { instrument(files: object[], options: object): Promise<{ mutants: Made[] }> };
  };
  const quiet = (): void => undefined;
  const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, isDebugEnabled: () => false };
  // What a sweep here hands it: no mutator left out, no range, nothing ignored.
  const options = { plugins: null, excludedMutations: [], mutationRange: [], ignorers: [], noHeader: true };
  return async (name, source) => (await new Instrumenter(logger).instrument([{ name, mutate: true, content: source }], options)).mutants;
}
