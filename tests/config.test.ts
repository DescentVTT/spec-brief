import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA,
  ConfigError,
  configJsonSchema,
  DEFAULT_CONFIG,
  initialConfig,
  locateConfig,
  parseConfig,
  resolveConfig,
} from '../src/config.js';
import { closest, type Schema, toJsonSchema, validate } from '../src/schema.js';

function problems(raw: unknown): readonly string[] {
  try {
    resolveConfig(raw);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe('the schema language', () => {
  it('names the path and what was expected', () => {
    const schema: Schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        extra: { type: 'map', values: { type: 'boolean' } },
        either: { type: 'anyOf', options: [{ type: 'string' }, { type: 'array', items: { type: 'integer' } }] },
        maybe: { type: 'string', nullable: true },
        free: { type: 'any' },
      },
    };
    expect(validate(schema, 3)).toEqual(['the configuration must be an object']);
    expect(validate(schema, [])).toEqual(['the configuration must be an object']);
    expect(validate(schema, null)).toEqual(['the configuration must be an object']);
    expect(validate(schema, {})).toEqual(['"name" is required']);
    expect(validate(schema, { name: '' })).toEqual(['"name" must not be empty']);
    expect(validate(schema, { name: 'x', count: 1.5 })).toEqual(['"count" must be an integer']);
    expect(validate(schema, { name: 'x', count: 0 })).toEqual(['"count" must be at least 1']);
    expect(validate(schema, { name: 'x', count: 4 })).toEqual(['"count" must be at most 3']);
    expect(validate(schema, { name: 'x', count: '2' })).toEqual(['"count" must be an integer']);
    expect(validate(schema, { name: 'x', tags: ['a', 'c'] })).toEqual(['"tags[1]" must be one of "a", "b", not "c"']);
    expect(validate(schema, { name: 'x', extra: { on: 'yes' } })).toEqual(['"extra.on" must be true or false']);
    expect(validate(schema, { name: 'x', either: true })).toEqual(['"either" must be a string or a list']);
    expect(validate(schema, { name: 'x', either: [1, 'two'] })).toEqual(['"either[1]" must be an integer']);
    expect(validate(schema, { name: 'x', either: 'ok', maybe: null, free: { any: 1 } })).toEqual([]);
    expect(validate(schema, { name: 'x', maybe: 1 })).toEqual(['"maybe" must be a string or null']);
    expect(validate(schema, { name: 'x', nmae: 1 })).toEqual(['"nmae" is not a known key; did you mean "name"?']);
    expect(validate(schema, { name: 'x', zzzzzz: 1 })).toEqual(['"zzzzzz" is not a known key']);
  });

  it('tries every option of the same kind before reporting the first one', () => {
    const schema: Schema = {
      type: 'anyOf',
      options: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
      ],
    };
    expect(validate(schema, { b: 'x' })).toEqual([]);
    expect(validate(schema, { c: 'x' })).toEqual(['"c" is not a known key; did you mean "a"?', '"a" is required']);
    expect(validate({ type: 'anyOf', options: [] }, 1)).toEqual(['the configuration must be ']);
  });

  it('suggests only near misses', () => {
    expect(closest('satus', ['status', 'wave'])).toBe('status');
    expect(closest('dependson', ['dependsOn'])).toBe('dependsOn');
    expect(closest('abc', ['xyz'])).toBeUndefined();
  });

  it('renders JSON Schema with descriptions, nullability and closed objects', () => {
    expect(toJsonSchema({ type: 'string', nullable: true, enum: ['a'], minLength: 1, description: 'd' })).toEqual({
      description: 'd',
      type: ['string', 'null'],
      enum: ['a', null],
      minLength: 1,
    });
    expect(toJsonSchema({ type: 'integer', minimum: 1, maximum: 2 })).toEqual({ type: 'integer', minimum: 1, maximum: 2 });
    expect(toJsonSchema({ type: 'object', properties: { a: { type: 'boolean' } }, required: ['a'] })).toEqual({
      type: 'object',
      properties: { a: { type: 'boolean' } },
      additionalProperties: false,
      required: ['a'],
    });
    expect(toJsonSchema({ type: 'object', properties: {}, required: [] })).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(toJsonSchema({ type: 'map', values: { type: 'any' } })).toEqual({ type: 'object', additionalProperties: {} });
    expect(toJsonSchema({ type: 'anyOf', options: [{ type: 'string' }] })).toEqual({ anyOf: [{ type: 'string' }] });
    expect(toJsonSchema({ type: 'array', items: { type: 'string' } })).toEqual({ type: 'array', items: { type: 'string' } });
  });
});

describe('resolving a configuration', () => {
  it('is the defaults for an empty object', () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('merges objects one level deep and replaces lists and types', () => {
    const config = resolveConfig({
      status: { active: 'proposed', draft: null },
      sections: ['Mission', { name: 'Deliverables', checklist: true, aliases: ['Tasks'], mustContain: ['x'], optional: true }],
      types: { spike: { sections: ['Findings'] }, bare: {} },
      rules: { title: 'off' },
      plugins: ['./p.js', { module: 'q', options: { level: 2 } }],
    });
    expect(config.status).toEqual({ field: 'status', draft: null, active: 'proposed', archived: 'archived' });
    expect(config.sections).toEqual([
      { name: 'Mission', aliases: [], mustContain: [], checklist: false, optional: false },
      { name: 'Deliverables', aliases: ['Tasks'], mustContain: ['x'], checklist: true, optional: true },
    ]);
    expect(Object.keys(config.types)).toEqual(['spike', 'bare']);
    expect(config.types['bare']).toEqual([]);
    expect(config.rules).toEqual({ title: 'off' });
    expect(config.plugins).toEqual([
      { module: './p.js', options: undefined },
      { module: 'q', options: { level: 2 } },
    ]);
    expect(config.archiving.banner).toEqual(DEFAULT_CONFIG.archiving.banner);
  });

  it('puts the archive under a configured briefs directory unless told otherwise', () => {
    expect(resolveConfig({ briefs: 'specs' }).archive).toBe('specs/archive');
    expect(resolveConfig({ briefs: 'specs', archive: 'done' }).archive).toBe('done');
    expect(resolveConfig({ template: null }).template).toBeNull();
    expect(resolveConfig({ template: 't.md' }).template).toBe('t.md');
  });

  it('refuses relationships the schema cannot express', () => {
    expect(problems({ briefs: 'b', archive: './b/' })).toEqual(['"briefs" and "archive" must be different directories']);
    expect(problems({ briefs: 'b', archive: 'b\\' })).toEqual(['"briefs" and "archive" must be different directories']);
    expect(problems({ status: { active: 'Done', archived: 'done' } })).toEqual(['the status words for draft, active and archived must differ']);
    expect(problems({ files: '[' })).toEqual(['"files" pattern "[": a "[" is never closed']);
    expect(problems({ exclude: ['ok.md', '{'] })).toEqual(['"exclude" pattern "{": a "{" is never closed']);
    expect(problems({ archiving: { banner: ['{date} {sumary}'] } })).toEqual([
      expect.stringContaining('"archiving.banner" uses {sumary}; the placeholders are {date}'),
    ]);
  });

  it('refuses a misspelt key rather than ignoring it', () => {
    expect(problems({ archving: {} })).toEqual(['"archving" is not a known key; did you mean "archiving"?']);
    expect(problems({ rules: { title: 'loud' } })).toEqual(['"rules.title" must be one of "off", "note", "warning", "error", not "loud"']);
  });

  it('parses text, with a byte-order mark, and names the file on failure', () => {
    expect(parseConfig(`${String.fromCharCode(0xfeff)}{"briefs": "x"}`, 'c.json').briefs).toBe('x');
    expect(() => parseConfig('{', 'c.json')).toThrow(/^c\.json: is not valid JSON/);
    expect(() => parseConfig('{"briefs": 1}', 'c.json')).toThrow('c.json: "briefs" must be a string');
  });
});

describe('finding the file', () => {
  const at = (files: readonly string[]) => (path: string): Promise<boolean> => Promise.resolve(files.includes(path));

  it('walks up to the nearest configuration', async () => {
    const found = await locateConfig(join('/r', 'a', 'b'), at([join('/r', '.spec-brief.json')]));
    expect(found).toBe(join('/r', '.spec-brief.json'));
    expect(await locateConfig(join('/r', 'a'), at([join('/r', 'a', 'spec-brief.json')]))).toBe(join('/r', 'a', 'spec-brief.json'));
    expect(await locateConfig(join('/r', 'a'), at([]))).toBeUndefined();
  });

  it('refuses a directory holding both names', async () => {
    await expect(locateConfig('/r', at([join('/r', '.spec-brief.json'), join('/r', 'spec-brief.json')]))).rejects.toThrow('keep one');
  });
});

describe('what is published', () => {
  it('schema.json is the schema the loader validates against', () => {
    const published = JSON.parse(readFileSync('schema.json', 'utf8')) as unknown;
    expect(published).toEqual(configJsonSchema());
  });

  it('the configuration init writes loads, and means the defaults', () => {
    const written = initialConfig('briefs', 'briefs/archive');
    const config = resolveConfig(written);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('every configuration key has a description', () => {
    const undocumented: string[] = [];
    const visit = (schema: Schema, path: string): void => {
      if (schema.type === 'object') {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (key !== '$schema' && value.description === undefined && value.type !== 'object') undocumented.push(`${path}${key}`);
          visit(value, `${path}${key}.`);
        }
      }
    };
    visit(CONFIG_SCHEMA, '');
    expect(undocumented.filter((p) => !p.startsWith('plugins') && !p.includes('.sections'))).toEqual([]);
  });
});
