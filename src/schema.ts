/**
 * A small schema language: one description that both validates a value and
 * renders as JSON Schema, so the published `schema.json` and the checks the
 * loader runs cannot disagree about what a configuration may say.
 */

interface Described {
  readonly description?: string;
}

export type Schema =
  | (Described & {
      readonly type: 'string';
      readonly enum?: readonly string[];
      readonly nullable?: boolean;
      readonly minLength?: number;
    })
  | (Described & { readonly type: 'boolean' })
  | (Described & { readonly type: 'integer'; readonly minimum?: number; readonly maximum?: number })
  | (Described & { readonly type: 'array'; readonly items: Schema })
  | (Described & {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, Schema>>;
      readonly required?: readonly string[];
    })
  | (Described & { readonly type: 'map'; readonly values: Schema })
  | (Described & { readonly type: 'anyOf'; readonly options: readonly Schema[] })
  | (Described & { readonly type: 'any' });

type Kind = 'null' | 'string' | 'boolean' | 'number' | 'array' | 'object';

function kindOf(value: unknown): Kind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    default:
      return 'object';
  }
}

function accepts(schema: Schema, kind: Kind): boolean {
  switch (schema.type) {
    case 'string':
      return kind === 'string' || (kind === 'null' && schema.nullable === true);
    case 'boolean':
      return kind === 'boolean';
    case 'integer':
      return kind === 'number';
    case 'array':
      return kind === 'array';
    case 'object':
    case 'map':
      return kind === 'object';
    case 'anyOf':
      return schema.options.some((option) => accepts(option, kind));
    case 'any':
      return true;
  }
}

function noun(schema: Schema): string {
  switch (schema.type) {
    case 'string':
      return schema.nullable === true ? 'a string or null' : 'a string';
    case 'boolean':
      return 'true or false';
    case 'integer':
      return 'an integer';
    case 'array':
      return 'a list';
    case 'object':
    case 'map':
      return 'an object';
    case 'anyOf':
      return schema.options.map(noun).join(' or ');
    /* v8 ignore next 2 -- "any" accepts every value, so no message ever names it. */
    case 'any':
      return 'anything';
  }
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** The problems with `value`, each naming the path to it. Empty when it conforms. */
export function validate(schema: Schema, value: unknown, path = ''): string[] {
  const where = path === '' ? 'the configuration' : `"${path}"`;
  if (!accepts(schema, kindOf(value))) return [`${where} must be ${noun(schema)}`];
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [];
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        return [`${where} must be one of ${schema.enum.map((e) => `"${e}"`).join(', ')}, not "${value}"`];
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${where} must not be empty`];
      return [];
    }
    case 'integer': {
      const number = value as number;
      if (!Number.isInteger(number)) return [`${where} must be an integer`];
      if (schema.minimum !== undefined && number < schema.minimum) return [`${where} must be at least ${schema.minimum}`];
      if (schema.maximum !== undefined && number > schema.maximum) return [`${where} must be at most ${schema.maximum}`];
      return [];
    }
    case 'array':
      return (value as unknown[]).flatMap((item, i) => validate(schema.items, item, `${path}[${i}]`));
    case 'object': {
      const record = value as Record<string, unknown>;
      const known = Object.keys(schema.properties);
      const problems: string[] = [];
      for (const key of Object.keys(record)) {
        const property = schema.properties[key];
        if (property === undefined) {
          const guess = closest(key, known);
          problems.push(`"${at(path, key)}" is not a known key${guess === undefined ? '' : `; did you mean "${guess}"?`}`);
          continue;
        }
        problems.push(...validate(property, record[key], at(path, key)));
      }
      for (const key of schema.required ?? []) {
        if (!(key in record)) problems.push(`"${at(path, key)}" is required`);
      }
      return problems;
    }
    case 'map':
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
        validate(schema.values, item, at(path, key)),
      );
    case 'anyOf': {
      const candidates = schema.options.filter((option) => accepts(option, kindOf(value)));
      let first: string[] | undefined;
      for (const option of candidates) {
        const problems = validate(option, value, path);
        if (problems.length === 0) return [];
        first ??= problems;
      }
      return first ?? [];
    }
    case 'boolean':
    case 'any':
      return [];
  }
}

/** The known key nearest to a misspelling, when one is near enough to be what was meant. */
export function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(word.length / 3)) + 1;
  for (const option of options) {
    const d = distance(word.toLowerCase(), option.toLowerCase());
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      row.push(Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + cost));
    }
    previous = row;
  }
  return previous[b.length] as number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Renders a schema as JSON Schema (draft 2020-12). */
export function toJsonSchema(schema: Schema): { [key: string]: Json } {
  const described = (body: { [key: string]: Json }): { [key: string]: Json } =>
    schema.description === undefined ? body : { description: schema.description, ...body };
  switch (schema.type) {
    case 'string': {
      const body: { [key: string]: Json } = { type: schema.nullable === true ? ['string', 'null'] : 'string' };
      if (schema.enum !== undefined) body['enum'] = [...schema.enum, ...(schema.nullable === true ? [null] : [])];
      if (schema.minLength !== undefined) body['minLength'] = schema.minLength;
      return described(body);
    }
    case 'boolean':
      return described({ type: 'boolean' });
    case 'integer': {
      const body: { [key: string]: Json } = { type: 'integer' };
      if (schema.minimum !== undefined) body['minimum'] = schema.minimum;
      if (schema.maximum !== undefined) body['maximum'] = schema.maximum;
      return described(body);
    }
    case 'array':
      return described({ type: 'array', items: toJsonSchema(schema.items) });
    case 'object': {
      const properties: { [key: string]: Json } = {};
      for (const [key, value] of Object.entries(schema.properties)) properties[key] = toJsonSchema(value);
      const body: { [key: string]: Json } = { type: 'object', properties, additionalProperties: false };
      if (schema.required !== undefined && schema.required.length > 0) body['required'] = [...schema.required];
      return described(body);
    }
    case 'map':
      return described({ type: 'object', additionalProperties: toJsonSchema(schema.values) });
    case 'anyOf':
      return described({ anyOf: schema.options.map(toJsonSchema) });
    case 'any':
      return described({});
  }
}
