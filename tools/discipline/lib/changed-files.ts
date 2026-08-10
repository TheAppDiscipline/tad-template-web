import { spawnSync } from 'node:child_process';
import { normalizePath } from './gates-config.js';

/**
 * What changed, from every place a change can hide.
 *
 * `gate --changed` decides how much of the gate to run from this list, so an
 * incomplete list is a skipped gate. That makes every failure here fatal: git
 * missing, an unknown base, a command that exits non-zero. An empty list is a
 * legitimate answer ONLY when git said so; it is never what we fall back to,
 * because "no changes" and "we could not tell" produce the same green.
 */

export type ChangeSource = 'committed' | 'staged' | 'unstaged' | 'untracked';

export interface ChangedFiles {
  /** Every changed path, POSIX-normalized, deduplicated, sorted. */
  files: string[];
  /** Which source each path came from, so a surprising file can be traced. */
  bySource: Record<ChangeSource, string[]>;
  /** The ref `committed` was measured against, or null when none was given. */
  base: string | null;
}

export class ChangedFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangedFilesError';
  }
}

/** Run git and return stdout, or throw. NUL-separated output keeps unicode paths verbatim. */
function git(root: string, args: string[], what: string): string {
  const proc = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
  if (proc.error) {
    throw new ChangedFilesError(`git is required to list ${what}, and it could not be run: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    const stderr = (proc.stderr || '').trim();
    throw new ChangedFilesError(
      `git ${args.join(' ')} failed while listing ${what}${stderr ? `: ${stderr}` : ` (exit ${proc.status})`}.`,
    );
  }
  return proc.stdout ?? '';
}

function splitNul(out: string): string[] {
  return out
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normalizePath);
}

/**
 * The union of committed (vs `base`), staged, unstaged and untracked changes.
 *
 * Deleted paths stay in the list: removing a component changes the UI surface
 * exactly as much as editing it does, and the surface is read from the path.
 */
export function collectChangedFiles(root: string, base?: string | null): ChangedFiles {
  git(root, ['rev-parse', '--git-dir'], 'changed files');

  const bySource: Record<ChangeSource, string[]> = { committed: [], staged: [], unstaged: [], untracked: [] };

  if (base) {
    // Verify the ref first so an unknown base says so, instead of arriving as a
    // confusing diff error. `--verify` also refuses an ambiguous name.
    const check = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root, encoding: 'utf-8' });
    if (check.status !== 0) {
      throw new ChangedFilesError(`base ref "${base}" does not resolve to a commit in this repository.`);
    }
    bySource.committed = splitNul(git(root, ['diff', '--name-only', '-z', `${base}...HEAD`], 'committed changes'));
  }
  bySource.staged = splitNul(git(root, ['diff', '--cached', '--name-only', '-z'], 'staged changes'));
  bySource.unstaged = splitNul(git(root, ['diff', '--name-only', '-z'], 'unstaged changes'));
  bySource.untracked = splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked files'));

  const all = new Set<string>();
  for (const list of Object.values(bySource)) for (const file of list) all.add(file);

  return { files: [...all].sort(), bySource, base: base ?? null };
}
