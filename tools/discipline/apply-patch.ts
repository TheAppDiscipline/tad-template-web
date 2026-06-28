import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePatchFile } from './lib/parse-patch.js';
import { findSectionBounds, isDuplicateAnchor, PATCH_APPLICATION_ORDER, ALLOWED_PATCH_TARGETS, normalizeLineEndings } from './lib/anchors.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);
const dryRun = args['dry-run'] === true;

/**
 * Write file atomically: write to .tmp, then rename.
 * Creates backup in .discipline/backups/ before overwriting.
 */
function atomicWriteWithBackup(root: string, filePath: string, content: string): void {
  const backupDir = path.join(root, '.discipline', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  // Backup original
  if (fs.existsSync(filePath)) {
    const backupName = `${path.basename(filePath)}.${Date.now()}`;
    fs.copyFileSync(filePath, path.join(backupDir, backupName));
  }

  // Atomic write: tmp → rename
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export async function applyPatches(root: string, isDryRun = false): Promise<number> {
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');
  const appliedDir = path.join(root, '.discipline', 'patches', 'applied');
  if (!fs.existsSync(pendingDir)) { disciplineInfo('No hay directorio .discipline/patches/pending/'); return 0; }

  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) { disciplineInfo('No hay patches pendientes.'); return 0; }

  const patches = files.map(f => {
    const fullPath = path.join(pendingDir, f);
    return parsePatchFile(fullPath, normalizeLineEndings(fs.readFileSync(fullPath, 'utf-8')));
  });

  // Validate TARGET_FILE whitelist
  for (const patch of patches) {
    if (!ALLOWED_PATCH_TARGETS.has(patch.targetFile)) {
      disciplineError(`TARGET_FILE not allowed: "${patch.targetFile}". Allowed: ${[...ALLOWED_PATCH_TARGETS].join(', ')}`);
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
      disciplineInfo(`  [${status}] ${patch.name} → ${patch.targetFile} (${patch.patchMode} at "${patch.anchor}")`);
    }
    disciplineInfo(`\n[DRY-RUN] ${patches.length} patch(es) previewed. No changes made.`);
    return 0;
  }

  // Track backups for rollback
  const backupMap: Array<{ targetPath: string; backupPath: string; patchSourcePath: string; appliedPath: string }> = [];

  let applied = 0;
  for (const patch of patches) {
    const targetPath = path.join(root, patch.targetFile);

    try {
      if (!fs.existsSync(targetPath)) throw new Error(`Target file not found: ${patch.targetFile}`);

      const lines = normalizeLineEndings(fs.readFileSync(targetPath, 'utf-8')).split('\n');

      if (isDuplicateAnchor(lines, patch.anchor)) throw new Error(`Duplicate anchor in ${patch.targetFile}: "${patch.anchor}". Fix manually.`);

      const bounds = findSectionBounds(lines, patch.anchor);
      if (!bounds) throw new Error(`Anchor not found in ${patch.targetFile}: "${patch.anchor}"`);

      let newLines: string[];
      switch (patch.patchMode) {
        case 'replace_section': newLines = [...lines.slice(0, bounds.start + 1), patch.content, '', ...lines.slice(bounds.end)]; break;
        case 'replace_block': newLines = [...lines.slice(0, bounds.start), patch.content, '', ...lines.slice(bounds.end)]; break;
        case 'insert_after': newLines = [...lines.slice(0, bounds.end), '', patch.content, ...lines.slice(bounds.end)]; break;
        case 'append': newLines = [...lines.slice(0, bounds.end), patch.content, '', ...lines.slice(bounds.end)]; break;
      }

      // Atomic write with backup
      atomicWriteWithBackup(root, targetPath, newLines.join('\n'));

      // Find the backup that was just created
      const backupDir = path.join(root, '.discipline', 'backups');
      const latestBackup = fs.readdirSync(backupDir)
        .filter(f => f.startsWith(path.basename(patch.targetFile)))
        .sort().pop();

      // Move patch to applied
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      if (!fs.existsSync(appliedDir)) fs.mkdirSync(appliedDir, { recursive: true });
      const appliedPath = path.join(appliedDir, `${timestamp}_${path.basename(patch.sourcePath)}`);
      try { fs.renameSync(patch.sourcePath, appliedPath); } catch { fs.copyFileSync(patch.sourcePath, appliedPath); fs.unlinkSync(patch.sourcePath); }

      backupMap.push({
        targetPath,
        backupPath: latestBackup ? path.join(backupDir, latestBackup) : '',
        patchSourcePath: patch.sourcePath,
        appliedPath,
      });

      applied++;
      disciplineInfo(`Applied: ${patch.name} → ${patch.targetFile} (${patch.patchMode} at "${patch.anchor}")`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      disciplineError(`Patch failed: ${patch.name} → ${msg}`);

      // Rollback all previously applied patches in this batch
      if (backupMap.length > 0) {
        disciplineInfo(`\nRolling back ${backupMap.length} previously applied patch(es)...`);
        for (const entry of backupMap.reverse()) {
          try {
            if (entry.backupPath && fs.existsSync(entry.backupPath)) {
              fs.copyFileSync(entry.backupPath, entry.targetPath);
              disciplineInfo(`  Restored: ${path.basename(entry.targetPath)}`);
            }
            // Move patch back from applied to pending
            if (fs.existsSync(entry.appliedPath)) {
              fs.renameSync(entry.appliedPath, entry.patchSourcePath);
            }
          } catch (rollbackErr) {
            disciplineError(`  Rollback failed for ${path.basename(entry.targetPath)}: ${rollbackErr}`);
          }
        }
        disciplineInfo('Rollback complete. All files restored to pre-patch state.');
      }

      process.exit(1);
    }
  }

  disciplineInfo(`\n${applied} patch(es) applied. Moved to .discipline/patches/applied/`);
  return applied;
}

// Solo ejecutar como CLI cuando se invoca directamente (npm run discipline:patch).
// Cuando se importa desde otro modulo (ej: watch.ts), no auto-ejecutar.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  applyPatches(projectRoot, dryRun).catch(e => disciplineError(e.message));
}
