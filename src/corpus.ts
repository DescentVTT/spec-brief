/**
 * Every brief of a repository at once, and the dependency graph between them.
 */

import { parseBrief, type Brief } from './brief.js';
import type { Config } from './config.js';
import type { Phase } from './types.js';

export interface SourceFile {
  readonly path: string;
  readonly text: string;
  readonly phase: Phase;
}

export interface Corpus {
  readonly config: Config;
  /** Sorted by path. */
  readonly briefs: readonly Brief[];
  readonly live: readonly Brief[];
  readonly archived: readonly Brief[];
}

export function buildCorpus(files: readonly SourceFile[], config: Config): Corpus {
  const briefs = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => parseBrief(file.path, file.text, config, file.phase));
  return {
    config,
    briefs,
    live: briefs.filter((b) => b.phase === 'live'),
    archived: briefs.filter((b) => b.phase === 'archived'),
  };
}

/**
 * The form in which ids are compared. Numeric ids compare by value, so a
 * dependency written `34` - which YAML would read as a number anyway - names
 * brief `034`.
 */
export function idKey(id: string): string {
  return /^\d+$/.test(id) ? String(Number(id)) : id;
}

/** Briefs an id, a file name or a path names. More than one is an ambiguity the caller reports. */
export function findBriefs(corpus: Corpus, reference: string): Brief[] {
  const key = idKey(reference.trim());
  const byId = corpus.briefs.filter((b) => b.id !== null && idKey(b.id) === key);
  if (byId.length > 0) return byId;
  const path = reference.replace(/\\/g, '/').replace(/^\.\//, '');
  return corpus.briefs.filter((b) => b.file === path || b.name === path);
}

/** The brief a dependency names, preferring a live one when an id is ambiguous. */
export function resolveDependency(corpus: Corpus, id: string): Brief | undefined {
  const found = findBriefs(corpus, id);
  return found.find((b) => b.phase === 'live') ?? found[0];
}

/** Briefs grouped by id, for the ids more than one file claims. */
export function duplicateIds(corpus: Corpus): Map<string, Brief[]> {
  const groups = new Map<string, Brief[]>();
  for (const brief of corpus.briefs) {
    if (brief.id === null) continue;
    const key = idKey(brief.id);
    groups.set(key, [...(groups.get(key) ?? []), brief]);
  }
  return new Map([...groups].filter(([, members]) => members.length > 1));
}

/** The live dependencies of a brief that are not archived yet. */
export function pendingDependencies(corpus: Corpus, brief: Brief): string[] {
  return brief.dependsOn.filter((dependency) => {
    const target = resolveDependency(corpus, dependency);
    return target !== undefined && target.phase === 'live';
  });
}

/** A live brief whose every dependency is archived can be executed now. */
export function isReady(corpus: Corpus, brief: Brief): boolean {
  if (brief.phase !== 'live' || brief.status === 'draft') return false;
  return brief.dependsOn.every((dependency) => resolveDependency(corpus, dependency)?.phase === 'archived');
}

/**
 * Dependency cycles among live briefs, each as the ids along it with the first
 * repeated at the end. Found with Tarjan's algorithm; each strongly connected
 * component is reported once, starting from its first brief by path.
 */
export function dependencyCycles(corpus: Corpus): Brief[][] {
  const nodes = corpus.live;
  const edges = new Map<Brief, Brief[]>();
  for (const brief of nodes) {
    const targets = brief.dependsOn
      .map((d) => resolveDependency(corpus, d))
      .filter((t): t is Brief => t !== undefined && t.phase === 'live');
    edges.set(brief, targets);
  }

  const index = new Map<Brief, number>();
  const low = new Map<Brief, number>();
  const stack: Brief[] = [];
  const onStack = new Set<Brief>();
  const components: Brief[][] = [];
  let counter = 0;

  // Recursion depth is bounded by the number of live briefs.
  const connect = (v: Brief): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: Brief[] = [];
      for (;;) {
        const w = stack.pop() as Brief;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      // A brief that depends on itself is the dependency rule's finding, not a cycle's.
      if (component.length > 1) components.push(component);
    }
  };
  for (const brief of nodes) if (!index.has(brief)) connect(brief);

  return components.map((component) => {
    const members = new Set(component);
    const start = [...component].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Brief;
    return cyclePath(start, members, edges);
  });
}

/** A path from `start` back to itself inside one component, found breadth-first. */
function cyclePath(start: Brief, members: ReadonlySet<Brief>, edges: ReadonlyMap<Brief, Brief[]>): Brief[] {
  const previous = new Map<Brief, Brief>();
  const queue: Brief[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as Brief;
    for (const next of edges.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path: Brief[] = [start];
        for (let at: Brief | undefined = node; at !== undefined && at !== start; at = previous.get(at)) path.splice(1, 0, at);
        return [...path, start];
      }
      if (!previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }
  /* v8 ignore next -- a component of two or more always leads back to its start. */
  return [start, start];
}
