/**
 * Types shared across the pipeline. Type-only: this module compiles to nothing.
 */

export type Severity = 'error' | 'warning' | 'note';

/** A severity as configuration spells it, where `off` silences a rule. */
export type SeveritySetting = Severity | 'off';

/** Where a brief lives. Location is the authority on whether a brief is archived. */
export type Phase = 'live' | 'archived';

/**
 * The lifecycle a brief moves through. `draft` and `deferred` are optional: a
 * repository that never writes one maps no word to it. A deferred brief waits
 * in the live directory for an event its `trigger` names, and runs in no wave
 * until then. There is no persisted "archiving" state; archival is a
 * transaction, and a transaction that stops half-way is rolled back rather
 * than recorded.
 */
export type Status = 'draft' | 'active' | 'deferred' | 'archived';

/**
 * One problem, located. Lines are 1-based; a finding about a file as a whole
 * points at line 1.
 */
export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly brief?: string | undefined;
  /** The concrete next action, where there is one. */
  readonly hint?: string | undefined;
  /**
   * The one repository path a finding is about, where it is about one: a
   * protected file the round changed is one finding per file, and names it.
   */
  readonly path?: string | undefined;
  /** The paths of a finding about several, such as the files a round changed outside its scope. */
  readonly paths?: readonly string[] | undefined;
}
