/**
 * The library. Everything the CLI does is reachable from here, and the
 * CLI is built from nothing else.
 */

export { applyPlan, ConflictError, TransactionError } from './apply.js';
export { type ArchiveRequest, type FileOp, openTasks, type Plan, planArchive, planUnarchive, type PullRequest, renderBanner } from './archive.js';
export { BANNER_CLOSE, BANNER_OPEN, type Brief, BUILT_IN_FIELDS, type FieldProblem, idFromName, parseBrief } from './brief.js';
export { main, type CliIO, EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, UsageError } from './cli.js';
export {
  type Collision,
  collisionFindings,
  type CollisionOptions,
  type CollisionReport,
  collisions,
  type SharedDirectory,
  type WaveMatrix,
} from './collisions.js';
export {
  BANNER_PLACEHOLDERS,
  type Config,
  CONFIG_FILES,
  CONFIG_SCHEMA,
  ConfigError,
  configJsonSchema,
  DEFAULT_CONFIG,
  parseConfig,
  type PluginReference,
  resolveConfig,
  type SectionRule,
} from './config.js';
export {
  buildCorpus,
  type Corpus,
  dependencyCycles,
  findBriefs,
  isReady,
  pendingDependencies,
  resolveDependency,
  type SourceFile,
} from './corpus.js';
export { type ArchiveOptions, BriefEngine, EngineError, type EngineSetup, type NewOptions, type OpenOptions, today } from './engine.js';
export { type FileSystem, MemoryFileSystem, NodeFileSystem } from './fs.js';
export { type CommitInfo, type FileChange, type Git, NodeGit } from './git.js';
export { type Glob, globBase, intersectGlobs, matchGlob, parseGlob } from './glob.js';
export { integrityOf } from './integrity.js';
export { failing, lint, type LintOptions, type Plugin, ruleIds, sortFindings, summarise } from './lint.js';
export { asPlugin, loadPlugins } from './plugins.js';
export { type Format, FORMATS, githubCommands, JSON_SCHEMA_VERSION, sarif } from './report.js';
export { COLLISION_RULES, type Rule, type RuleContext, type RuleInfo, type RuleResult, RULES } from './rules.js';
export { nextId, renderNewBrief } from './scaffold.js';
export type { Finding, Phase, Severity, SeveritySetting, Status } from './types.js';

/** Types a plugin author writes against, with inference for the rule list. */
export function definePlugin<T extends import('./lint.js').Plugin>(plugin: T): T {
  return plugin;
}
