/**
 * Executing a plan as a transaction over files.
 *
 * Three phases. First every file is read back and compared with what the plan
 * saw, so a file somebody edited in the meantime stops the transaction before
 * anything changes. Then the operations run in order - the new file first, the
 * old one removed last - and each one that completes is recorded. If any
 * fails, the recorded ones are undone in reverse from the contents the plan
 * already holds. Each write is itself atomic (a rename over the target), so
 * the only window in which the tree shows both copies is between the first
 * operation and the last, and a crash inside it leaves two briefs with one id,
 * which `lint` reports by name.
 */

import type { FileOp } from './archive.js';
import { type FileSystem, type NotAFile, NotAFileError } from './fs.js';

export class ConflictError extends Error {
  readonly path: string;

  /** `found` is what stands at the path where it is not a file, which is not read. */
  constructor(path: string, found?: NotAFile) {
    super(
      found === undefined
        ? `${path} changed after the plan was made; nothing was written. Run the command again.`
        : `${path} is ${found}; nothing was written. Move it out of the way, then run the command again.`,
    );
    this.name = 'ConflictError';
    this.path = path;
  }
}

export class TransactionError extends Error {
  /** Whether every completed operation was undone. */
  readonly rolledBack: boolean;
  readonly failures: readonly string[];

  constructor(cause: unknown, rolledBack: boolean, failures: readonly string[]) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      rolledBack
        ? `${reason}; every change was rolled back`
        : `${reason}; the rollback also failed (${failures.join('; ')}), so check these files by hand`,
    );
    this.name = 'TransactionError';
    this.rolledBack = rolledBack;
    this.failures = failures;
  }
}

export async function applyPlan(fs: FileSystem, ops: readonly FileOp[]): Promise<void> {
  for (const op of ops) {
    const current = await fs.read(op.path).catch((error: unknown) => {
      // A plan is made from the files a listing names, so what stands where
      // it would write a new one can be a named pipe, read without end, or a
      // directory. Nothing is written yet, and the refusal can say so.
      throw error instanceof NotAFileError ? new ConflictError(op.path, error.what) : error;
    });
    if (current !== op.before) throw new ConflictError(op.path);
  }

  const done: FileOp[] = [];
  try {
    for (const op of ops) {
      if (op.kind === 'write') await fs.write(op.path, op.content);
      else await fs.remove(op.path);
      done.push(op);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const op of [...done].reverse()) {
      // Undoing is putting back what was there: a file that was absent is
      // removed, and one that was present - written over or removed - is
      // written again.
      try {
        if (op.before === null) await fs.remove(op.path);
        else await fs.write(op.path, op.before);
      } catch (undo) {
        failures.push(`${op.path}: ${undo instanceof Error ? undo.message : String(undo)}`);
      }
    }
    throw new TransactionError(error, failures.length === 0, failures);
  }
}
