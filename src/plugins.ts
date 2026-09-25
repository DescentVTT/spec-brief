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

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PluginReference } from './config.js';
import { ConfigError } from './config.js';
import type { Plugin } from './lint.js';
import type { Rule } from './rules.js';

const SEVERITIES = new Set(['off', 'note', 'warning', 'error']);

/** The conditions Node matches in "exports" when it imports a module. */
const IMPORT_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

/**
 * A target of "exports": a path inside the package, `null` where the package
 * refuses the subpath, `undefined` where no condition matched and a fallback
 * may still. A target that is not a "./" path, or that climbs out of the
 * package, is refused, as Node refuses it.
 */
function exportTarget(value: unknown, match: string | null): string | null | undefined {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) return null;
    const path = match === null ? value : value.replaceAll('*', match);
    return path.split('/').slice(1).some((part) => part === '..' || part === '.' || part === 'node_modules') ? null : path;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const path = exportTarget(item, match);
      if (typeof path === 'string') return path;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [condition, item] of Object.entries(value)) {
      if (!IMPORT_CONDITIONS.has(condition)) continue;
      const path = exportTarget(item, match);
      if (path !== undefined) return path;
    }
    return undefined;
  }
  return null;
}

/**
 * The file a package's "exports" gives a subpath (`.` or `./x`) under the
 * conditions of an import, or `null` when it gives none: Node's
 * PACKAGE_EXPORTS_RESOLVE. An exact key wins; then the "*" pattern with the
 * longest prefix, and of those the longest key.
 */
export function exportsTarget(exports: unknown, subpath: string): string | null {
  const keys = typeof exports === 'object' && exports !== null && !Array.isArray(exports) ? Object.keys(exports) : [];
  const dotted = keys.filter((key) => key.startsWith('.'));
  if (dotted.length === 0) return subpath === '.' ? (exportTarget(exports, null) ?? null) : null;
  // Subpaths beside conditions is a package Node refuses to read.
  if (dotted.length !== keys.length) return null;
  const map = exports as Record<string, unknown>;
  if (!subpath.includes('*') && Object.hasOwn(map, subpath)) return exportTarget(map[subpath], null) ?? null;
  let best: { readonly key: string; readonly prefix: number; readonly match: string } | undefined;
  for (const key of dotted) {
    const star = key.indexOf('*');
    if (star < 0 || key.includes('*', star + 1)) continue;
    const suffix = key.slice(star + 1);
    if (subpath.length < key.length || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(suffix)) continue;
    if (best === undefined || star > best.prefix || (star === best.prefix && key.length > best.key.length)) {
      best = { key, prefix: star, match: subpath.slice(star, subpath.length - suffix.length) };
    }
  }
  return best === undefined ? null : (exportTarget(map[best.key], best.match) ?? null);
}

/** A package.json, `undefined` when there is none to read. */
async function manifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * The file a package specifier names, found from the root the way an import
 * there would find it. `require.resolve` reads "exports" under the require
 * conditions, so a package that exports only for "import" - an ESM-only
 * plugin - could not be found; Node's `import.meta.resolve` resolves only
 * from the module calling it, not from the root. So the nearest
 * node_modules/<name> is found here and its "exports" read under the import
 * conditions; a package with no "exports" resolves as it always has.
 */
async function resolvePackage(specifier: string, root: string): Promise<string> {
  const slash = specifier.indexOf('/', specifier.startsWith('@') ? specifier.indexOf('/') + 1 : 0);
  const name = slash < 0 ? specifier : specifier.slice(0, slash);
  const subpath = slash < 0 ? '.' : `.${specifier.slice(slash)}`;
  let directory = root;
  // Bounded by the depth of the path: each pass moves one directory up.
  for (let depth = 0; depth < 256; depth += 1) {
    const packageDirectory = join(directory, 'node_modules', name);
    const found = await manifest(join(packageDirectory, 'package.json'));
    if (found !== undefined) {
      if (found['exports'] === undefined || found['exports'] === null) break;
      const target = exportsTarget(found['exports'], subpath);
      if (target === null) throw new Error(`${name} exports no "${subpath}" for import`);
      return join(packageDirectory, target);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return createRequire(join(root, 'package.json')).resolve(specifier);
}

async function specifierUrl(specifier: string, root: string): Promise<string> {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return pathToFileURL(resolve(root, specifier)).href;
  return pathToFileURL(await resolvePackage(specifier, root)).href;
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
      loaded = (await import(await specifierUrl(reference.module, root))) as Record<string, unknown>;
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
