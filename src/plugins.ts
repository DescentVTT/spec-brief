/**
 * Loading rule plugins named by the configuration.
 *
 * spec-brief does not know how another tool signs a departure, records a
 * reproducer or measures a blast radius, and should not: the tool that
 * defines a format is the one that can check it. A plugin is a module whose
 * default export is a plugin object, or a function of the configured options
 * that returns one. Loading one runs its code, exactly as loading an ESLint
 * configuration does; the configuration belongs to the repository, and so
 * does that trust.
 */

import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PluginReference } from './config.js';
import { ConfigError } from './config.js';
import type { Plugin } from './lint.js';
import type { Rule } from './rules.js';

const SEVERITIES = new Set(['off', 'note', 'warning', 'error']);

function specifierUrl(specifier: string, root: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return pathToFileURL(resolve(root, specifier)).href;
  const require = createRequire(join(root, 'package.json'));
  return pathToFileURL(require.resolve(specifier)).href;
}

function isRule(value: unknown): value is Rule {
  if (typeof value !== 'object' || value === null) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule['id'] === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(rule['id']) &&
    typeof rule['description'] === 'string' &&
    typeof rule['severity'] === 'string' &&
    SEVERITIES.has(rule['severity']) &&
    typeof rule['check'] === 'function'
  );
}

/** Checks the shape a module exported, since nothing typed it on the way in. */
export function asPlugin(value: unknown, module: string, options: unknown): Plugin {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    throw new ConfigError(module, ['does not export a plugin: expected an object with "name" and "rules"']);
  }
  const candidate = value as Record<string, unknown>;
  const name = candidate['name'];
  const rules = candidate['rules'];
  if (typeof name !== 'string' || !/^[a-z0-9@][a-z0-9@/._-]*$/i.test(name)) problems.push('"name" must be a plain identifier');
  if (!Array.isArray(rules)) problems.push('"rules" must be a list');
  else {
    rules.forEach((rule, i) => {
      if (!isRule(rule)) problems.push(`rules[${i}] needs a lower-case "id", a "description", a "severity" and a "check" function`);
    });
  }
  if (problems.length > 0) throw new ConfigError(module, problems);
  return { name: name as string, rules: rules as Rule[], options };
}

export async function loadPlugins(references: readonly PluginReference[], root: string): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const reference of references) {
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(specifierUrl(reference.module, root))) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigError(reference.module, [`could not be loaded: ${(error as Error).message}`]);
    }
    const exported = loaded['default'] ?? loaded['plugin'];
    const value = typeof exported === 'function' ? await (exported as (o: unknown) => unknown)(reference.options) : exported;
    plugins.push(asPlugin(value, reference.module, reference.options));
  }
  const names = plugins.map((p) => p.name);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length > 0) throw new ConfigError('plugins', [`two plugins are named "${repeated[0] as string}"`]);
  return plugins;
}
