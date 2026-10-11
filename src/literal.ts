/**
 * A table's literal types, without `as const`.
 *
 * Stryker makes no mutant of anything that stands under a TypeScript `as`
 * expression, `as const` among them: a table written `{ ... } as const` is
 * read by no mutator, and no test is held to what it says. A `const` type
 * parameter infers the same readonly literal types from its argument, and an
 * argument is mutated as any other expression is (ADR-0009, amended
 * 2026-10-12).
 */
export function literal<const T>(table: T): T {
  return table;
}
