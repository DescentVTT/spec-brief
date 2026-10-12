import { describe, expect, expectTypeOf, it } from 'vitest';

import { literal } from '../src/literal.js';

/**
 * `literal` (src/literal.ts), loaded alone: this file imports the function
 * and nothing else under `src/`.
 *
 * The tables that take their literal types from the function are built
 * through it, two of them as their modules load. Were it to answer nothing,
 * what says so is whatever reads a table first. Each is read inside a
 * function, so every module loads and a test fails. A table read as its
 * module loads would throw there, and every test file that imports the
 * module would end before it had a test: a mutation sweep counts a test that
 * failed, a file that did not load has none, and the function emptied is
 * then scored as survived with nothing working. Here the failure is a
 * test's, whatever the modules that call the function do as they load
 * (ADR-0009, amended 2026-10-12).
 *
 * No disk and no process: it is in both sweeps' suites, as the function is
 * mutated in both. `tests/source.test.ts` holds what this file imports and
 * where it runs.
 */
describe('literal', () => {
  it('answers the table it was given, and neither a copy nor nothing', () => {
    const codes = { red: [31, 39], dim: [2, 22] };
    expect(literal(codes)).toBe(codes);
    const fields = ['affectedFiles', 'protectedFiles'];
    expect(literal(fields)).toBe(fields);
  });

  it('types a table as `as const` types it: every entry its own literal, and none to be written', () => {
    // The compiler holds these lines under `npm run lint`: a type parameter
    // that is not `const` reads the same table as number[] and string[].
    const cast = { red: [31, 39], fields: ['affectedFiles', 'protectedFiles'] } as const;
    const called = literal({ red: [31, 39], fields: ['affectedFiles', 'protectedFiles'] });
    expectTypeOf(called).toEqualTypeOf(cast);
    expectTypeOf(called.fields).toEqualTypeOf<readonly ['affectedFiles', 'protectedFiles']>();
    expect(called).toEqual(cast);
  });
});
