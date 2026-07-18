import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { watch as chokidarWatch } from 'chokidar';
import minimist from 'minimist';
import { disciplineInfo, disciplineWarn, type StepId } from './lib/types.js';
import { routeFromPackets, resolveStep4Origin } from './lib/step4-origin.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { copyToClipboard as writeTextToClipboard } from './lib/clipboard.js';
import { extractEmbeddedPatches } from './lib/parse-patch.js';
import { applyPatches } from './apply-patch.js';
import { updateProgress, completionGateState } from './update-progress.js';
import { assemblePasteReady } from './assemble-paste-ready.js';
import { logRun } from './log-run.js';
import { STEP_ASSEMBLY_MAP } from './lib/artifact-flow.js';
import { withWriterLock, isStopped } from './lib/locks.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

export function detectNext(root: string): StepId | null {
  const dir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(dir)) return null;

  // The watcher shares BOTH the route AND the advance conditions with the direct /discipline-step4
  // command, so it can never advance where that command would stop. routeFromPackets is the pure
  // router (which packet -> which step); for a Step 4 origin, resolveStep4Origin then authorizes the
  // advance with the same coherence the skill enforces (STEP_4_EXECUTION_PACKET validated for every
  // mode, completion gate green for reentry, feedback branch declared for feedback).
  const route = routeFromPackets(root);
  switch (route.kind) {
    case 'step4': {
      const res = resolveStep4Origin(root);
      if (res.status === 'chosen') return res.mode ?? null;
      disciplineWarn(
        `  Step 4 origin (${route.mode}) not ready to advance; not assembling or opening the next handoff. ` +
          `Reason: ${res.reason ?? 'not coherent'}`,
      );
      return null;
    }
    case 'redirect':
      return route.step;
    case 'collision':
      disciplineWarn(
        `  Ambiguous Step 4 origin (${route.modes.join(', ')} all present); not auto-advancing. ` +
          'Choose with /discipline-step4 --mode <x>. Expected in Fase 1 (no consumption model yet).',
      );
      return null;
    case 'feedback-unclear':
      disciplineWarn(
        '  POST_DEPLOY_FEEDBACK_PACKET does not declare a clear recommended branch (Step 4 vs Step 7); ' +
          'not auto-advancing. Declare it and re-drop the packet.',
      );
      return null;
    case 'none':
      return null;
  }
}

function copyToClipboard(content: string) {
  try {
    writeTextToClipboard(content);
    disciplineInfo('  Copied paste-ready to clipboard.');
  } catch {
    disciplineWarn('  Could not copy paste-ready to clipboard.');
  }
}

function openTool(stepId: StepId) {
  const config = STEP_ASSEMBLY_MAP[stepId];
  if (!config.toolUrl) return;

  try {
    if (process.platform === 'win32') execSync(`start ${config.toolUrl}`);
    else if (process.platform === 'darwin') execSync(`open ${config.toolUrl}`);
    else execSync(`xdg-open ${config.toolUrl}`);
    disciplineInfo(`  Opened tool for Step ${stepId}.`);
  } catch {
    disciplineWarn(`  Could not open: ${config.toolUrl}`);
  }
}

export async function handlePacket(root: string, filePath: string) {
  const fileName = path.basename(filePath);
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');

  disciplineInfo(`[${new Date().toTimeString().slice(0, 8)}] New packet: ${fileName}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const patches = extractEmbeddedPatches(content, filePath);
  const logNotes: string[] = [];
  let assembledStep: StepId | null = null;
  let assembledOK = false;

  // Hold the writer lock around both mutations (patch application and progress
  // update) so a single packet's state changes are atomic against any other
  // writer. applyPatches also takes the writer lock, but withWriterLock is
  // re-entrant, so the inner call reuses this hold rather than re-acquiring.
  await withWriterLock(root, { tool: 'discipline:watch' }, async () => {
    if (patches.length > 0) {
      disciplineInfo(`  Extracted ${patches.length} patch(es)`);
      if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });

      for (const patch of patches) {
        const patchFile = path.join(pendingDir, `${new Date().toISOString().slice(0, 10)}_${patch.name}.md`);
        fs.writeFileSync(
          patchFile,
          `## ${patch.name}\n\nTARGET_FILE: ${patch.targetFile}\nPATCH_MODE: ${patch.patchMode}\nANCHOR: ${patch.anchor}\n\n### CONTENT\n${patch.content}`,
          'utf-8',
        );
      }

      disciplineInfo('  Applying patches...');
      await applyPatches(root);
      logNotes.push(`patches=${patches.length}`);
    }

    if (fileName.includes('SLICE_COMPLETION_PACKET')) {
      disciplineInfo('  Updating progress...');
      // Record progress honestly (updateProgress refuses only a packet with no outcome/gate). The
      // decision to advance is taken below from the packet's PERSISTED gate state, not from here.
      try {
        const res = await updateProgress(root);
        logNotes.push(res.gate === 'passed' ? 'progress-updated' : `progress-updated,gate-${res.gate}`);
      } catch (err) {
        disciplineWarn(`  Refused progress.md update: ${err instanceof Error ? err.message : err}`);
        logNotes.push('progress-refused');
      }
    }
  });

  const next = detectNext(root);
  if (next) {
    // Durable guard, re-derived from disk on EVERY event (not a per-event flag): never auto-advance
    // while any persisted completion gate is non-green. This applies to every next-step branch,
    // not only 4-reentry: detectNext gives deploy/feedback/hardening packets higher priority than
    // SLICE_COMPLETION_PACKET, so guarding only 4-reentry let a later high-priority packet bypass
    // a stale failed or unverified completion.
    const completionPath = path.join(root, '.discipline', 'packets', 'SLICE_COMPLETION_PACKET.md');
    if (fs.existsSync(completionPath) && completionGateState(root) !== 'passed') {
      disciplineWarn('  Completion gate is not green; not assembling or opening the next handoff. Declare "GATE_STATE: passed" and re-drop the packet.');
      logNotes.push('advance-blocked');
    } else {
      try {
        const assembled = await assemblePasteReady(root, next);
        const outputFile = STEP_ASSEMBLY_MAP[next].outputFile;
        disciplineInfo(`  Paste-ready assembled for Step ${next}: .discipline/paste-ready/${outputFile}`);
        copyToClipboard(assembled);
        openTool(next);
        assembledStep = next;
        assembledOK = true;
        logNotes.push(`next=${next}`);
      } catch {
        disciplineWarn(`  Could not assemble Step ${next} (required packets may be missing).`);
        logNotes.push(`assemble-failed=${next}`);
      }
    }
  }

  // QW-2 audit, auto-log each processed packet in run-log.md (NN #5).
  // Does not fail if logRun throws; only logs a warning to avoid stopping the watcher.
  try {
    await logRun(root, {
      step: 'watch',
      tool: 'discipline:watch',
      inputPacket: fileName,
      outputPacket: assembledOK && assembledStep ? STEP_ASSEMBLY_MAP[assembledStep].outputFile : '-',
      notes: logNotes.length > 0 ? logNotes.join(', ') : 'no-op',
    });
  } catch (err) {
    disciplineWarn(`  Could not auto-log run: ${err instanceof Error ? err.message : err}`);
  }

  disciplineInfo('');
}

export function startWatcher(root: string) {
  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) fs.mkdirSync(packetsDir, { recursive: true });

  disciplineInfo('Watcher started. Watching .discipline/packets/...');
  disciplineInfo('Ctrl+C to stop.\n');

  let processing = false;
  const queue: string[] = [];

  function enqueue(filePath: string) {
    queue.push(filePath);
    processNext();
  }

  async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;
    const filePath = queue.shift()!;

    try {
      // Kill switch: `.discipline/STOP` pauses processing without killing the
      // watcher. Skip this packet (it stays in .discipline/packets/) and warn.
      if (isStopped(root)) {
        disciplineWarn(`.discipline/STOP present: skipping ${path.basename(filePath)}. Remove STOP to resume.`);
      } else {
        await handlePacket(root, filePath);
      }
    } catch (err) {
      disciplineWarn(`Error processing ${path.basename(filePath)}: ${err instanceof Error ? err.message : err}`);
    } finally {
      processing = false;
      if (queue.length > 0) processNext();
    }
  }

  const watcher = chokidarWatch(packetsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', (filePath: string) => {
    if (path.extname(filePath).toLowerCase() === '.md') enqueue(filePath);
  });

  process.on('SIGINT', () => {
    disciplineInfo('\nWatcher stopped.');
    watcher.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    watcher.close();
    process.exit(0);
  });
}

// --once: health/smoke pass for freshly cloned projects. Creates the
// packets directory if missing, reports status, and exits 0. Does NOT open a browser, does NOT copy to
// the clipboard, and does NOT keep watching. Intended for CI / Release Preflight.
function runOnce(root: string) {
  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) fs.mkdirSync(packetsDir, { recursive: true });
  const packets = fs.readdirSync(packetsDir).filter((f) => f.endsWith('.md'));
  if (packets.length === 0) {
    disciplineInfo('discipline:watch --once: no packets, watcher healthy.');
  } else {
    disciplineInfo(`discipline:watch --once: ${packets.length} packet(s) present (run "discipline:watch" to process). Watcher healthy.`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (args.once) runOnce(projectRoot);
  else startWatcher(projectRoot);
}
