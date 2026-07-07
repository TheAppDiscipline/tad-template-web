import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { disciplineWarn } from './types.js';

/**
 * File-based writer lock and per-slice leases for the Discipline Loop pipeline.
 *
 * These guard both the manual flow (apply-patch, watch) and any future
 * reconciler: only one process should mutate discipline.md / task_plan.md /
 * findings.md / progress.md at a time (writer lock), and only one writer should
 * own a given slice at a time (slice lease).
 *
 * The kill switch is a plain file: `.discipline/STOP`. Any long-running loop
 * should call isStopped() before doing more work and stop gracefully if present.
 *
 * No network, no daemon, no external dependency. Files are the source of truth.
 */

export const DEFAULT_TTL_S = 1800;
/** A lock older than STALE_TTL_MULTIPLIER * ttl_s is considered abandoned. */
export const STALE_TTL_MULTIPLIER = 3;

export interface LockBody {
  tool: string;
  pid: number;
  hostname: string;
  acquired_at: string;
  ttl_s: number;
}

export interface AcquireOptions {
  tool: string;
  ttlS?: number;
  /** Take over a stale lock even if its mtime is not yet past the stale window. */
  force?: boolean;
}

export interface ReleaseOptions {
  /** Remove the lock even if this process does not own it. */
  force?: boolean;
}

export interface LockHandle {
  /** Absolute path to the lock file. */
  path: string;
  body: LockBody;
}

function locksDir(root: string): string {
  return path.join(root, '.discipline', 'locks');
}

function writerLockPath(root: string): string {
  return path.join(locksDir(root), 'writer.lock');
}

function sliceLockPath(root: string, sliceId: string): string {
  // Keep the id filesystem-safe: slices are short ids like "S03" or "3".
  const safe = String(sliceId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(locksDir(root), `slice-${safe}.lock`);
}

function buildBody(tool: string, ttlS: number): LockBody {
  return {
    tool,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
    ttl_s: ttlS,
  };
}

function readBody(lockPath: string): LockBody | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockBody;
  } catch {
    // A malformed or unreadable lock file is treated as "no readable owner".
    return null;
  }
}

function isStale(lockPath: string, ttlS: number): boolean {
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    return ageMs > STALE_TTL_MULTIPLIER * ttlS * 1000;
  } catch {
    return false;
  }
}

/** True when the lock body was written by this same pid + hostname. */
function ownedByThisProcess(body: LockBody | null): boolean {
  return !!body && body.pid === process.pid && body.hostname === os.hostname();
}

/**
 * Acquire a lock at lockPath by atomically creating the file (O_EXCL via 'wx').
 * If the file already exists: take it over when it is stale (or when force is
 * set), otherwise throw a clear error naming the live owner.
 */
function acquireAt(lockPath: string, opts: AcquireOptions): LockHandle {
  const ttlS = opts.ttlS ?? DEFAULT_TTL_S;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const body = buildBody(opts.tool, ttlS);
  const payload = JSON.stringify(body);

  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, payload, 'utf-8');
    } finally {
      fs.closeSync(fd);
    }
    return { path: lockPath, body };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    const existing = readBody(lockPath);
    const existingTtl = existing?.ttl_s ?? ttlS;
    if (opts.force || isStale(lockPath, existingTtl)) {
      const owner = existing ? `${existing.tool} pid ${existing.pid}@${existing.hostname}` : 'unreadable owner';
      disciplineWarn(`Taking over stale lock ${path.basename(lockPath)} (was ${owner}).`);
      // Replace atomically: write the new body then rename over the old file.
      const tmp = `${lockPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf-8');
      fs.renameSync(tmp, lockPath);
      return { path: lockPath, body };
    }

    const owner = existing
      ? `${existing.tool} (pid ${existing.pid} on ${existing.hostname}, since ${existing.acquired_at})`
      : 'an unreadable lock file';
    throw new Error(
      `Lock held by ${owner}. If that process is gone, wait for the stale window ` +
        `(${STALE_TTL_MULTIPLIER}x ttl) or re-run with --force. Lock: ${lockPath}`,
    );
  }
}

/**
 * Release a lock: unlink it only when this process owns it (pid + hostname
 * match) or when force is set. Returns true if a file was removed.
 */
function releaseAt(lockPath: string, opts: ReleaseOptions = {}): boolean {
  if (!fs.existsSync(lockPath)) return false;
  const body = readBody(lockPath);
  if (opts.force || ownedByThisProcess(body)) {
    fs.unlinkSync(lockPath);
    return true;
  }
  const owner = body ? `${body.tool} pid ${body.pid}@${body.hostname}` : 'an unreadable owner';
  disciplineWarn(`Not releasing ${path.basename(lockPath)}: owned by ${owner}. Use --force to override.`);
  return false;
}

// Writer lock ---------------------------------------------------------------

export function acquireWriterLock(root: string, opts: AcquireOptions): LockHandle {
  return acquireAt(writerLockPath(root), opts);
}

export function releaseWriterLock(root: string, opts: ReleaseOptions = {}): boolean {
  return releaseAt(writerLockPath(root), opts);
}

/**
 * Run fn while holding the writer lock, releasing it afterwards (even on
 * throw) when this call acquired it. If the lock is already held by this same
 * process (re-entrant use, e.g. watch -> apply-patch), fn runs without a second
 * acquire/release so the outer holder keeps ownership.
 */
export async function withWriterLock<T>(
  root: string,
  opts: AcquireOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const existing = readBody(writerLockPath(root));
  if (ownedByThisProcess(existing)) {
    return await fn();
  }
  acquireWriterLock(root, opts);
  try {
    return await fn();
  } finally {
    releaseWriterLock(root);
  }
}

// Slice lease ---------------------------------------------------------------

export function acquireSliceLease(root: string, sliceId: string, opts: AcquireOptions): LockHandle {
  return acquireAt(sliceLockPath(root, sliceId), opts);
}

export function releaseSliceLease(root: string, sliceId: string, opts: ReleaseOptions = {}): boolean {
  return releaseAt(sliceLockPath(root, sliceId), opts);
}

export function sliceLeaseStatus(root: string, sliceId: string): LockBody | null {
  const lockPath = sliceLockPath(root, sliceId);
  if (!fs.existsSync(lockPath)) return null;
  return readBody(lockPath);
}

// Kill switch ---------------------------------------------------------------

/** True when `.discipline/STOP` exists: loops should stop processing new work. */
export function isStopped(root: string): boolean {
  return fs.existsSync(path.join(root, '.discipline', 'STOP'));
}

// Test / introspection helpers ----------------------------------------------

export function writerLockFile(root: string): string {
  return writerLockPath(root);
}

export function sliceLockFile(root: string, sliceId: string): string {
  return sliceLockPath(root, sliceId);
}
