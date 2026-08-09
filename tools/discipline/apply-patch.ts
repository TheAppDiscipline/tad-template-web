import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineErrorMessage, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePatchFile } from './lib/parse-patch.js';
import { findSectionBounds, isDuplicateAnchor, stripLeadingAnchorLine, PATCH_APPLICATION_ORDER, ALLOWED_PATCH_TARGETS, normalizeLineEndings } from './lib/anchors.js';
import { withWriterLock } from './lib/locks.js';
import { appendLedger } from './lib/ledger.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const dryRun = args['dry-run'] === true;

/** One written file and how to undo it. `appliedPath` stays empty until the patch file moves. */
type RollbackEntry = { targetPath: string; backupPath: string; patchSourcePath: string; appliedPath: string };

/** A patch batch that failed and was rolled back. Carries what the ledger needs to record. */
export class PatchBatchError extends Error {
  readonly applied: number;
  readonly rolledBack: number;
  readonly rollbackFailures: number;
  readonly unrestored: number;
  readonly stranded: number;
  readonly targetFile: string;
  constructor(
    message: string,
    detail: { applied: number; rolledBack: number; unrestored: number; stranded: number; targetFile: string },
  ) {
    super(message);
    this.name = 'PatchBatchError';
    this.applied = detail.applied;
    this.rolledBack = detail.rolledBack;
    this.unrestored = detail.unrestored;
    this.stranded = detail.stranded;
    this.rollbackFailures = detail.unrestored + detail.stranded;
    this.targetFile = detail.targetFile;
  }
}

/** The three filesystem calls the rollback needs, injectable so its failure paths are testable. */
export type RollbackOps = {
  existsSync(p: string): boolean;
  copyFileSync(src: string, dest: string): void;
  renameSync(src: string, dest: string): void;
};

const realRollbackOps: RollbackOps = {
  existsSync: (p) => fs.existsSync(p),
  copyFileSync: (src, dest) => { fs.copyFileSync(src, dest); },
  renameSync: (src, dest) => { fs.renameSync(src, dest); },
};

export type RollbackResult = {
  /** Journal entries the rollback walked. */
  attempted: number;
  /** State files put back the way they were found. */
  restored: string[];
  /** State files that still carry their patch. This is what "half-patched" means, and the only
   *  number that belongs in the ledger's `count` after a failure. */
  unrestored: number;
  /** Patch files left in applied/ although their target was restored: bookkeeping, not data loss. */
  stranded: number;
  errors: string[];
};

/**
 * Undo every write in the journal, newest first, keeping the two failure modes apart because
 * they mean different things to whoever reads the ledger. A journaled backup that is no longer
 * on disk counts as unrestored: the file was written and nothing put it back.
 */
export function rollbackJournal(journal: RollbackEntry[], ops: RollbackOps = realRollbackOps): RollbackResult {
  const result: RollbackResult = { attempted: journal.length, restored: [], unrestored: 0, stranded: 0, errors: [] };
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

  for (const entry of [...journal].reverse()) {
    if (entry.backupPath) {
      try {
        if (!ops.existsSync(entry.backupPath)) throw new Error(`backup missing: ${entry.backupPath}`);
        ops.copyFileSync(entry.backupPath, entry.targetPath);
        result.restored.push(entry.targetPath);
      } catch (err) {
        result.unrestored++;
        result.errors.push(`Could not restore ${path.basename(entry.targetPath)}: ${reason(err)}`);
        // The file still carries this patch, so the patch file belongs in applied/, not pending/.
        continue;
      }
    }
    // Empty appliedPath = the move never happened, so the patch file is still in pending/.
    if (entry.appliedPath && ops.existsSync(entry.appliedPath)) {
      try {
        ops.renameSync(entry.appliedPath, entry.patchSourcePath);
      } catch (err) {
        result.stranded++;
        result.errors.push(`Could not return ${path.basename(entry.patchSourcePath)} to pending/: ${reason(err)}`);
      }
    }
  }
  return result;
}

/** The tail appended to a failed batch's message when the rollback did not fully succeed. */
export function describeRollback(result: RollbackResult): string {
  if (result.unrestored === 0 && result.stranded === 0) return '';
  const parts: string[] = [];
  if (result.unrestored > 0) {
    parts.push(`${result.unrestored} of ${result.attempted} state file(s) could not be restored and still carry their patch`);
  }
  if (result.stranded > 0) {
    parts.push(`${result.stranded} patch file(s) stayed in applied/ instead of returning to pending/`);
  }
  return ` | Rollback incomplete: ${parts.join('; ')}. Compare the state files against .discipline/backups/ before running anything else.`;
}

/**
 * Copy filePath into backupDir under a name no other backup holds, and return that name.
 * COPYFILE_EXCL makes claiming the name atomic, so two patches against the same file landing
 * on the same millisecond take different slots instead of one overwriting the other's backup.
 */
function copyToUniqueBackup(backupDir: string, filePath: string): string {
  const base = `${path.basename(filePath)}.${Date.now()}`;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = path.join(backupDir, attempt === 0 ? base : `${base}.${attempt}`);
    try {
      fs.copyFileSync(filePath, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not claim a unique backup name for ${path.basename(filePath)} in ${backupDir}`);
}

/**
 * Write file atomically: write to .tmp, then rename.
 * Backs the original up in .discipline/backups/ first and RETURNS that exact path ('' when the
 * target did not exist yet). The path is returned instead of being rediscovered by scanning the
 * directory afterwards: a scan sorts by name, and same-millisecond backups of the same file
 * would hand the rollback the wrong copy.
 */
function atomicWriteWithBackup(root: string, filePath: string, content: string): string {
  const backupDir = path.join(root, '.discipline', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = fs.existsSync(filePath) ? copyToUniqueBackup(backupDir, filePath) : '';

  // Atomic write: tmp -> rename
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
  return backupPath;
}

export async function applyPatches(root: string, isDryRun = false, rollbackOps: RollbackOps = realRollbackOps): Promise<number> {
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');
  if (!fs.existsSync(pendingDir)) { disciplineInfo('No .discipline/patches/pending/ directory.'); return 0; }

  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) { disciplineInfo('No pending patches.'); return 0; }

  const patches = files.map(f => {
    const fullPath = path.join(pendingDir, f);
    return parsePatchFile(fullPath, normalizeLineEndings(fs.readFileSync(fullPath, 'utf-8')));
  });

  // Validate TARGET_FILE whitelist
  for (const patch of patches) {
    if (!ALLOWED_PATCH_TARGETS.has(patch.targetFile)) {
      // Throw, never exit: same reason as the batch failure below, this function is imported.
      throw new Error(`TARGET_FILE not allowed: "${patch.targetFile}". Allowed: ${[...ALLOWED_PATCH_TARGETS].join(', ')}`);
    }
  }

  patches.sort((a, b) => {
    const idxA = PATCH_APPLICATION_ORDER.indexOf(a.targetFile as typeof PATCH_APPLICATION_ORDER[number]);
    const idxB = PATCH_APPLICATION_ORDER.indexOf(b.targetFile as typeof PATCH_APPLICATION_ORDER[number]);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });

  // Dry-run mode: validate and preview without applying
  if (isDryRun) {
    disciplineInfo('[DRY-RUN] Previewing patches (no files will be modified):\n');
    for (const patch of patches) {
      const targetPath = path.join(root, patch.targetFile);
      const exists = fs.existsSync(targetPath);
      const anchorOk = exists ? !!findSectionBounds(normalizeLineEndings(fs.readFileSync(targetPath, 'utf-8')).split('\n'), patch.anchor) : false;
      const status = !exists ? 'FAIL (file missing)' : !anchorOk ? 'FAIL (anchor not found)' : 'OK';
      disciplineInfo(`  [${status}] ${patch.name} -> ${patch.targetFile} (${patch.patchMode} at "${patch.anchor}")`);
    }
    disciplineInfo(`\n[DRY-RUN] ${patches.length} patch(es) previewed. No changes made.`);
    return 0;
  }

  // Mutating from here on: hold the writer lock so no other process (manual
  // flow or a future reconciler) rewrites the same Discipline files at once.
  // If a live owner holds it, withWriterLock throws a clear error naming it.
  const targetsTouched = [...new Set(patches.map(p => p.targetFile))];
  let applied: number;
  try {
    applied = await withWriterLock(root, { tool: 'discipline:patch' }, () =>
      applyPatchesLocked(root, patches, rollbackOps),
    );
  } catch (err) {
    // Record the failed batch, then rethrow so the caller decides. withWriterLock releases the
    // lock in its own finally (and, when re-entered from run.ts/watch.ts, correctly leaves the
    // outer holder's lock alone), so nothing is released by hand here.
    // count = state files still carrying a patch after the rollback: 0 when everything was
    // restored, and only the files the rollback could not put back when it was not. Counting the
    // patches that had reached applied/ would overstate it, since the rollback undoes those too.
    const failure = err instanceof PatchBatchError ? err : null;
    try {
      appendLedger(root, {
        event: 'patch_applied',
        targets: failure ? [failure.targetFile] : targetsTouched,
        count: failure?.unrestored ?? 0,
        ok: false,
        rolled_back: failure?.rolledBack ?? 0,
        rollback_failures: failure?.rollbackFailures ?? 0,
        stranded_patches: failure?.stranded ?? 0,
      });
    } catch { /* best-effort */ }
    throw err;
  }

  try {
    appendLedger(root, { event: 'patch_applied', targets: targetsTouched, count: applied, ok: true });
  } catch {
    // Ledger is best-effort observability; never fail patching because of it.
  }

  disciplineInfo(`\n${applied} patch(es) applied. Moved to .discipline/patches/applied/`);
  return applied;
}

type PatchList = ReturnType<typeof parsePatchFile>[];

function applyPatchesLocked(root: string, patches: PatchList, rollbackOps: RollbackOps): number {
  const appliedDir = path.join(root, '.discipline', 'patches', 'applied');
  // Rollback journal: one entry per file this batch has written, in write order.
  const backupMap: RollbackEntry[] = [];

  let applied = 0;
  for (const patch of patches) {
    const targetPath = path.join(root, patch.targetFile);

    try {
      if (!fs.existsSync(targetPath)) throw new Error(`Target file not found: ${patch.targetFile}`);

      const lines = normalizeLineEndings(fs.readFileSync(targetPath, 'utf-8')).split('\n');

      if (isDuplicateAnchor(lines, patch.anchor)) throw new Error(`Duplicate anchor in ${patch.targetFile}: "${patch.anchor}". Fix manually.`);

      const bounds = findSectionBounds(lines, patch.anchor);
      if (!bounds) throw new Error(`Anchor not found in ${patch.targetFile}: "${patch.anchor}"`);

      // replace_section keeps the anchor line, so a CONTENT block that repeats the heading would
      // write it twice and poison every later patch to that section. Drop it here, with a warning
      // so the patch author fixes the source. replace_block is left alone on purpose: it replaces
      // the anchor line itself, so there the repeated heading is the one that survives.
      let content = patch.content;
      if (patch.patchMode === 'replace_section') {
        const withoutAnchor = stripLeadingAnchorLine(content, patch.anchor);
        if (withoutAnchor.stripped) {
          content = withoutAnchor.content;
          disciplineWarn(`${patch.name}: CONTENT repeated the anchor "${patch.anchor}"; dropped it (replace_section keeps the heading). Remove it from the patch to silence this.`);
        }
      }

      let newLines: string[];
      switch (patch.patchMode) {
        case 'replace_section': newLines = [...lines.slice(0, bounds.start + 1), content, '', ...lines.slice(bounds.end)]; break;
        case 'replace_block': newLines = [...lines.slice(0, bounds.start), content, '', ...lines.slice(bounds.end)]; break;
        case 'insert_after': newLines = [...lines.slice(0, bounds.end), '', content, ...lines.slice(bounds.end)]; break;
        case 'append': newLines = [...lines.slice(0, bounds.end), content, '', ...lines.slice(bounds.end)]; break;
      }

      // Atomic write with backup. The target is modified from this line on, so the rollback
      // entry is journaled BEFORE any post-write step: if creating applied/ or moving the patch
      // file throws, the catch still knows this file has to be restored. appliedPath is filled
      // in only once the move succeeded, so the rollback never chases a file that never moved.
      const backupPath = atomicWriteWithBackup(root, targetPath, newLines.join('\n'));
      const journal: RollbackEntry = { targetPath, backupPath, patchSourcePath: patch.sourcePath, appliedPath: '' };
      backupMap.push(journal);

      // Move patch to applied
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      if (!fs.existsSync(appliedDir)) fs.mkdirSync(appliedDir, { recursive: true });
      const appliedPath = path.join(appliedDir, `${timestamp}_${path.basename(patch.sourcePath)}`);
      try { fs.renameSync(patch.sourcePath, appliedPath); } catch { fs.copyFileSync(patch.sourcePath, appliedPath); fs.unlinkSync(patch.sourcePath); }
      journal.appliedPath = appliedPath;

      applied++;
      disciplineInfo(`Applied: ${patch.name} -> ${patch.targetFile} (${patch.patchMode} at "${patch.anchor}")`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Undo every file this batch has written, newest first. The journal is written before
      // each post-write step, so this covers the current patch too, not only the earlier ones.
      const rollback = rollbackJournal(backupMap, rollbackOps);
      if (rollback.attempted > 0) {
        disciplineInfo(`\nRolling back ${rollback.attempted} written file(s)...`);
        for (const restored of rollback.restored) disciplineInfo(`  Restored: ${path.basename(restored)}`);
        for (const error of rollback.errors) disciplineErrorMessage(`  ${error}`);
        if (rollback.unrestored === 0 && rollback.stranded === 0) {
          disciplineInfo('Rollback complete. All files restored to pre-patch state.');
        }
      }

      // Throw, never exit: this function is imported by run.ts and watch.ts, and process.exit()
      // here would skip their finally blocks (the slice lease in run.ts, the queue bookkeeping
      // in watch.ts). The CLI entrypoint at the bottom of this file owns the exit code.
      throw new PatchBatchError(`Patch failed: ${patch.name} -> ${msg}${describeRollback(rollback)}`, {
        applied,
        rolledBack: rollback.attempted,
        unrestored: rollback.unrestored,
        stranded: rollback.stranded,
        targetFile: patch.targetFile,
      });
    }
  }

  return applied;
}

// Only execute as CLI when invoked directly (npm run discipline:patch).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  applyPatches(projectRoot, dryRun).catch(e => disciplineError(e.message));
}
