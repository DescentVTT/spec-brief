/**
 * The library. Everything the CLI does is reachable from here, and the
 * CLI is built from nothing else.
 */

export { applyPlan, ConflictError, TransactionError } from './apply.js';
export {
  applyWaivers,
  type ArchiveRequest,
  type FileOp,
  openTasks,
  type Plan,
  planArchive,
  planUnarchive,
  type PullRequest,
  renderBanner,
  type UnarchiveRequest,
  type Unmeasured,
  WAIVABLE,
  type Waiver,
} from './archive.js';
export { BANNER_CLOSE, BANNER_OPEN, type Brief, BUILT_IN_FIELDS, type FieldProblem, idFromName, parseBrief } from './brief.js';
export { main, type CliIO, EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, UsageError } from './cli.js';
export {
  type Collision,
  collisionFindings,
  type CollisionOptions,
  type CollisionReport,
  collisions,
  type Overlap,
  type SharedDirectory,
  type UndecidedPair,
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
  type Waiting,
  waitingOnDeferred,
} from './corpus.js';
export { type ArchiveOptions, BriefEngine, EngineError, type EngineSetup, type NewOptions, type OpenOptions, today } from './engine.js';
export { type FileSystem, MemoryFileSystem, NodeFileSystem } from './fs.js';
export { type CommitInfo, type FileChange, type Git, NodeGit } from './git.js';
export {
  type Glob,
  globBase,
  globBases,
  globCovers,
  globWitness,
  intersectGlobs,
  type Literal,
  type LiteralReading,
  matchGlob,
  parseGlob,
  type ParseOptions,
  readingIn,
  WITNESS_BUDGET,
  type Witness,
} from './glob.js';
export { integrityOf } from './integrity.js';
export { failing, lint, type LintOptions, type Plugin, ruleIds, sortFindings, summarise, type WaiveContext } from './lint.js';
export { asPlugin, asWaivers, loadPlugins } from './plugins.js';
export { type Format, FORMATS, githubCommands, gitlabCodeQuality, JSON_SCHEMA_VERSION, matrixJson, sarif, scheduleJson, sectionsJson } from './report.js';
export { ARCHIVE_RULES, COLLISION_RULES, type Rule, type RuleContext, type RuleInfo, type RuleResult, RULES } from './rules.js';
export { nextId, renderNewBrief } from './scaffold.js';
export {
  moves,
  type Passed,
  type Placement,
  planWaves,
  reasons,
  type Schedule,
  schedule,
  scheduleFindings,
  type ScheduleOptions,
  type Unplaced,
  type WavePlan,
} from './schedule.js';
export { contradictions, meet, type Meeting, type Scope, scopeOf, type ScopePattern } from './scope.js';
export type { Finding, Phase, Severity, SeveritySetting, Status } from './types.js';

/** Types a plugin author writes against, with inference for the rule list. */
export function definePlugin<T extends import('./lint.js').Plugin>(plugin: T): T {
  return plugin;
}
