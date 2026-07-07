import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { acquireSliceLease, releaseSliceLease, sliceLeaseStatus, DEFAULT_TTL_S } from './lib/locks.js';

/**
 * Slice lease CLI: one writer owns a slice at a time (One Writer Per Slice).
 *
 *   discipline:lease -- acquire <slice-id> [--force] [--ttl <seconds>]
 *   discipline:lease -- release <slice-id> [--force]
 *   discipline:lease -- status  <slice-id>
 *
 * A lease is a file `.discipline/locks/slice-<id>.lock`. Acquire is atomic
 * (fails if a live owner holds it, unless --force or the lock is stale); status
 * reports the current owner if any. No network, no daemon.
 *
 * Release ergonomics: each CLI invocation is its own process, so `acquire` and a
 * later `release` never share a pid. So the CLI treats a lease it created
 * itself (tool `discipline:lease`) on the same host as releasable without
 * --force; a lease held by a different tool (e.g. a live watcher) still needs
 * --force. The underlying library stays strict pid+hostname ownership.
 */

const USAGE = 'Usage: discipline:lease -- acquire|release|status <slice-id> [--force] [--ttl <seconds>]';

export function runLease(root: string, action: string, sliceId: string | undefined, force: boolean, ttlS: number): number {
  if (!sliceId) {
    disciplineWarn(`Missing <slice-id>. ${USAGE}`);
    return 1;
  }

  switch (action) {
    case 'acquire': {
      const handle = acquireSliceLease(root, sliceId, { tool: 'discipline:lease', force, ttlS });
      disciplineInfo(`Lease acquired for slice ${sliceId} (ttl ${handle.body.ttl_s}s). Lock: ${handle.path}`);
      return 0;
    }
    case 'release': {
      // A lease this same CLI created on this host is releasable without --force,
      // since separate invocations never share a pid. Anything else needs --force.
      const existing = sliceLeaseStatus(root, sliceId);
      const selfCreated = !!existing && existing.tool === 'discipline:lease' && existing.hostname === os.hostname();
      const removed = releaseSliceLease(root, sliceId, { force: force || selfCreated });
      if (removed) disciplineInfo(`Lease released for slice ${sliceId}.`);
      else if (!existing) disciplineWarn(`No lease to release for slice ${sliceId}.`);
      else disciplineWarn(`Lease for slice ${sliceId} is held by ${existing.tool} on ${existing.hostname}. Use --force to override.`);
      return removed ? 0 : 1;
    }
    case 'status': {
      const body = sliceLeaseStatus(root, sliceId);
      if (!body) {
        disciplineInfo(`Slice ${sliceId}: no lease.`);
      } else {
        disciplineInfo(
          `Slice ${sliceId}: held by ${body.tool} (pid ${body.pid} on ${body.hostname}, since ${body.acquired_at}, ttl ${body.ttl_s}s).`,
        );
      }
      return 0;
    }
    default:
      disciplineWarn(`Unknown action "${action}". ${USAGE}`);
      return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args['project-dir']);
  const action = String(args._[0] ?? '');
  const sliceId = args._[1] !== undefined ? String(args._[1]) : undefined;
  const force = args.force === true;
  const ttlS = typeof args.ttl === 'number' ? args.ttl : DEFAULT_TTL_S;

  try {
    process.exit(runLease(projectRoot, action, sliceId, force, ttlS));
  } catch (err) {
    disciplineError(err instanceof Error ? err.message : String(err));
  }
}
