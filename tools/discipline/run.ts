#!/usr/bin/env npx tsx
/**
 * discipline run - the stateless single-tick reconciler for ONE slice.
 *
 * No daemon, no residual state: the files are the state. One `discipline run`
 * advances exactly one slice by one tick and stops. It reuses the whole Phase-0
 * substrate and Phase-1 control plane rather than reimplementing any of it:
 *   - assemble-paste-ready  -> the builder prompt body (the paste-ready IS the prompt)
 *   - provider adapters + runner -> spawn a headless CLI, prompt via stdin, tree-kill
 *   - apply-patch / update-progress -> plumbing, under the writer lock (like watch)
 *   - gate-report -> the deterministic arbiter (+ error_signature for the Repair Budget)
 *   - checkpoint -> the pre-commit approval packet (git-auditable)
 *   - diff-report -> the self-contained HTML diff for human review
 *   - locks / ledger -> One Writer Per Slice + intent-before-action audit trail
 *
 * Doctrine baked in: it ALWAYS stops before the commit (the human reviews the
 * diff and approves the checkpoint); it never touches the §7 operations without
 * saying so in the packet; two identical error signatures stop the repair loop;
 * parked (rate limit / auth / missing CLI) never consumes the repair budget.
 *
 * Exit codes: 0 green, 2 config/precondition error, 3 parked, 4 stopped by the
 * repair budget (two identical signatures or attempts exhausted).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { acquireSliceLease, releaseSliceLease, sliceLeaseStatus, acquireWriterLock, releaseWriterLock, isStopped } from './lib/locks.js';
import { appendLedger, errorSignature } from './lib/ledger.js';
import { assemblePasteReady } from './assemble-paste-ready.js';
import { extractEmbeddedPatches } from './lib/parse-patch.js';
import { applyPatches } from './apply-patch.js';
import { updateProgress } from './update-progress.js';
import { runGateReport, writeGateReport, type GateReport } from './gate-report.js';
import { createCheckpoint } from './checkpoint.js';
import { diffToHtml } from './diff-report.js';
import { loadAutonomy, enforceValidatorFamily, type AutonomyConfig, type ProviderName } from './lib/autonomy.js';
import { getAdapter, runAdapter, familyOf, CODEX_RESUME_ARGS, type RunAdapterOutcome } from './lib/providers/index.js';
import { buildCrossValidationReport, parseVerdict } from './lib/cross-validation.js';

export const RUN_EXIT = { GREEN: 0, CONFIG: 2, PARKED: 3, REPAIR_STOP: 4 } as const;

/** Crockford-ish run id: 8 time chars + 8 random chars (monotonic-ish, sortable). */
export function makeRunId(now = Date.now(), rand = crypto.randomBytes(5)): string {
  const time = now.toString(36).padStart(8, '0').slice(-8);
  const random = rand.toString('hex').slice(0, 8);
  return `${time}${random}`.toUpperCase();
}

// --- Slice plan parsing -----------------------------------------------------

export interface SliceStatus {
  found: boolean;
  status: string | null;
  /** True when the status is a ready-to-run state (or unset, which we treat as ready). */
  ready: boolean;
}

/**
 * Parse a slice's status from task_plan.md §Ready Slices leniently. Slices are
 * headings like `## Slice 3 - Name`; an optional `- Status: <value>` line inside
 * the section (or a bracketed marker in the heading) sets the status. Missing
 * status is treated as ready (the plan format does not require the line). A
 * status containing "in-progress", "blocked", "done", "cloud", or "hold" is NOT
 * ready.
 */
export function parseSliceStatus(taskPlan: string, sliceId: string): SliceStatus {
  const lines = taskPlan.split('\n');
  const idNorm = String(sliceId).trim().toLowerCase().replace(/^slice\s*/, '');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,4})\s+Slice\s+([A-Za-z0-9._-]+)\b(.*)$/i);
    if (!m) continue;
    const thisId = m[2].trim().toLowerCase();
    if (thisId === idNorm || thisId === `s${idNorm}` || `s${thisId}` === idNorm) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return { found: false, status: null, ready: false };

  // Section end: next heading of same-or-higher level.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s/);
    if (hm && hm[1].length <= level) {
      end = i;
      break;
    }
  }

  const heading = lines[start];
  const section = lines.slice(start, end).join('\n');
  // Status from a `Status:` line or a bracketed marker in the heading.
  let status: string | null = null;
  const statusLine = section.match(/^[-*]?\s*status\s*:\s*(.+)$/im);
  if (statusLine) status = statusLine[1].trim();
  else {
    const bracket = heading.match(/\[(ready|in-progress[a-z-]*|blocked|done|hold)\]/i);
    if (bracket) status = bracket[1].trim();
  }

  const notReady = /in-progress|in_progress|blocked|done|complete|cloud|hold|wip/i;
  const ready = status === null ? true : !notReady.test(status);
  return { found: true, status, ready };
}

// --- STEP_5 packet location -------------------------------------------------

/**
 * Locate the STEP_5_SLICE_PACKET for a slice. The canonical convention in this
 * repo is a single `.discipline/packets/STEP_5_SLICE_PACKET.md` (what watch and
 * assemble use). A per-slice suffixed variant `STEP_5_SLICE_PACKET_<slice>.md`
 * is also accepted when present. Returns the absolute path or null.
 */
export function locateSlicePacket(root: string, sliceId: string): string | null {
  const dir = path.join(root, '.discipline', 'packets');
  const safe = String(sliceId).replace(/[^A-Za-z0-9._-]/g, '_');
  const candidates = [
    path.join(dir, `STEP_5_SLICE_PACKET_${safe}.md`),
    path.join(dir, 'STEP_5_SLICE_PACKET.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// --- Repair decision (pure, extracted for tests) ----------------------------

export interface RepairState {
  /** Number of builder attempts already made (initial build counts as 1). */
  attempts: number;
  /** Signatures seen so far, in order (one per failed gate). */
  signatures: string[];
  /** Max repair attempts from autonomy config. */
  repairMax: number;
}

export interface RepairDecision {
  action: 'repair' | 'stop';
  reason: string;
}

/**
 * Decide whether to attempt another repair after a gate failure. Doctrine:
 *  - Two identical error signatures with no material change -> STOP (self-anneal).
 *  - At most `repairMax` repair attempts beyond the initial build.
 * `newSignature` is the error signature of the just-failed gate.
 */
export function decideRepair(state: RepairState, newSignature: string): RepairDecision {
  // If we have already seen this exact signature, the last attempt changed
  // nothing material: stop (the "2 identical signatures" rule).
  if (state.signatures.includes(newSignature)) {
    return { action: 'stop', reason: 'two identical error signatures with no material change' };
  }
  // repairsUsed = attempts beyond the first (initial) build.
  const repairsUsed = Math.max(0, state.attempts - 1);
  if (repairsUsed >= state.repairMax) {
    return { action: 'stop', reason: `repair budget exhausted (${state.repairMax} repair attempt(s))` };
  }
  return { action: 'repair', reason: 'new failure signature; one more repair attempt allowed' };
}

// --- Prompt building --------------------------------------------------------

const RUN_CONTRACT = [
  '',
  '---',
  '',
  '## RUN CONTRACT (headless build - read carefully)',
  '',
  '- Implement ONLY this slice. Obey every contract in discipline.md.',
  '- Write the code AND its tests (minimum 1 happy path + 1 error path).',
  '- Emit your changes as patch blocks and a SLICE_COMPLETION_PACKET under `.discipline/packets/`',
  '  using the exact packet/patch formats this repo already uses.',
  '- Do NOT run `git commit`. The run stops before commit for human review.',
  '- Do NOT touch `.env*`, GitHub workflows, or database migrations WITHOUT stating so',
  '  explicitly in the packet (these are §7 operations that require human approval).',
  '- Keep the diff under ~500 lines. If the slice is larger, stop and say so in the packet.',
  '',
].join('\n');

/** Build the builder prompt: assembled step-5 paste-ready + the run contract. */
export async function buildBuilderPrompt(root: string): Promise<string> {
  const assembled = await assemblePasteReady(root, '5');
  return `${assembled}${RUN_CONTRACT}`;
}

/** Build a repair prompt: the failed checks + first errors + fix-with-new-info instruction. */
export function buildRepairPrompt(report: GateReport): string {
  const failed = report.failed_checks.length ? report.failed_checks.map((c) => `- ${c}`).join('\n') : '- (none reported)';
  const errs = report.steps
    .filter((s) => s.exit !== 0 && s.firstError)
    .map((s) => `- [${s.cmd}] ${s.firstError}`)
    .join('\n');
  return [
    '## REPAIR TURN (the gate failed)',
    '',
    'The gate did not pass. Fix ONLY with new information; do not repeat the same change.',
    '',
    '### Failed checks',
    failed,
    '',
    '### First error lines',
    errs || '- (no error lines captured)',
    '',
    'Apply a fix, emit updated patch blocks and an updated SLICE_COMPLETION_PACKET, and do NOT commit.',
    'If you cannot make progress with new information, say so instead of retrying the same fix.',
  ].join('\n');
}

/** Read the slice packet body (context for cross-validation). Best-effort. */
function readSlicePacket(root: string, sliceId: string): string {
  const p = locateSlicePacket(root, sliceId);
  if (!p) return '(slice packet not found)';
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '(slice packet unreadable)';
  }
}

// --- Small helpers ----------------------------------------------------------

function gitPorcelainClean(root: string): { clean: boolean; ok: boolean; detail: string } {
  const proc = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' });
  if (proc.status !== 0 || typeof proc.stdout !== 'string') {
    return { clean: false, ok: false, detail: (proc.stderr || 'git status failed').trim() };
  }
  const dirty = proc.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { clean: dirty.length === 0, ok: true, detail: dirty.slice(0, 20).join('\n') };
}

function gitDiffText(root: string): string {
  const proc = spawnSync('git', ['diff'], { cwd: root, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return proc.status === 0 && typeof proc.stdout === 'string' ? proc.stdout : '';
}

/** yyyymmdd-hhmmss local-time slug (same idiom as checkpoint/diff-report). */
function tsSlug(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function safeLedger(root: string, event: Record<string, unknown>): void {
  try {
    appendLedger(root, event);
  } catch {
    // Ledger is best-effort observability; never fail the run because of it.
  }
}

function openInBrowser(filePath: string): void {
  try {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore' });
    else if (process.platform === 'darwin') spawnSync('open', [filePath], { stdio: 'ignore' });
    else spawnSync('xdg-open', [filePath], { stdio: 'ignore' });
  } catch {
    disciplineWarn(`Could not open ${filePath} in a browser.`);
  }
}

/** Ask a y/N question on the terminal; resolves true only on an explicit yes. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// --- Options ----------------------------------------------------------------

export interface RunOptions {
  slice: string;
  autonomyFlag?: number;
  dryRun: boolean;
  yes: boolean;
  allowDirty: boolean;
  open: boolean;
  timeoutMin?: number;
  /** Override the configured builder (from `run --with-llm --provider X`). */
  builderOverride?: ProviderName;
  /** Override the configured validator (from `cross-validate --with-llm --provider X`). */
  validatorOverride?: ProviderName;
  /** Run JUST the advisory cross-validation against the current diff (no builder). */
  crossValidateOnly: boolean;
}

const DEFAULT_TIMEOUT_MIN = 20;

// --- The reconciler ---------------------------------------------------------

/** Redact an adapter outcome for the ledger: never persist prompt/argv/summary text verbatim. */
function ledgerStepFinished(outcome: RunAdapterOutcome): Record<string, unknown> {
  return {
    status: outcome.status,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    sessionId: outcome.sessionId ?? null,
    costUsd: outcome.costUsd ?? null,
    tokensIn: outcome.tokens?.in ?? null,
    tokensOut: outcome.tokens?.out ?? null,
  };
}

export async function runReconciler(root: string, opts: RunOptions): Promise<number> {
  // (a) STOP switch + autonomy.
  if (isStopped(root)) {
    disciplineWarn('.discipline/STOP is present: the pipeline is paused. Remove it to run. Aborting.');
    return RUN_EXIT.CONFIG;
  }

  const autonomy = loadAutonomy(root, opts.autonomyFlag);
  // Apply CLI provider overrides (from `--with-llm --provider X`). The builder
  // override re-runs the family rule so the validator stays family-different.
  if (opts.builderOverride) {
    autonomy.builder = opts.builderOverride;
    autonomy.validator = enforceValidatorFamily(autonomy.builder, autonomy.validator, autonomy.warnings);
  }
  if (opts.validatorOverride) {
    autonomy.validator = enforceValidatorFamily(autonomy.builder, opts.validatorOverride, autonomy.warnings);
  }
  for (const w of autonomy.warnings) disciplineWarn(w);

  const timeoutMs = Math.max(1, (opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN)) * 60 * 1000;
  const builderName = autonomy.builder;
  const validatorName = autonomy.validator;

  // Cross-validate-only mode (`discipline cross-validate --with-llm`): run JUST
  // the advisory review against the current diff, write the report packet, exit.
  // No builder, no lease, no tag, no gate. Advisory: never blocks (always exit 0).
  if (opts.crossValidateOnly) {
    const validator = getAdapter(validatorName);
    if (!validator) {
      disciplineWarn(`Validator "${validatorName}" is not a known adapter. Configure a valid validator.`);
      return RUN_EXIT.CONFIG;
    }
    if (opts.dryRun) {
      disciplineInfo(`--dry-run: would cross-validate the current diff with ${validatorName} (${validator.cli}) and write a report packet.`);
      return RUN_EXIT.GREEN;
    }
    const runId = makeRunId();
    safeLedger(root, { event: 'run_started', run_id: runId, slice: opts.slice, mode: 'cross-validate-only', validator: validatorName });
    await runCrossValidation(root, runId, opts.slice, validatorName, builderName, timeoutMs);
    safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'cross-validate-only' });
    return RUN_EXIT.GREEN;
  }

  // (b) Level 0 and Level 1 are plumbing-only.
  if (autonomy.level === 0) {
    disciplineInfo('Autonomy level 0 (manual): no headless execution is configured.');
    disciplineInfo(`Paste-ready for the slice lives at .discipline/paste-ready/step-5-input.md (run \`discipline assemble --step 5\` to (re)build it).`);
    return RUN_EXIT.GREEN;
  }
  if (autonomy.level === 1) {
    try {
      await assemblePasteReady(root, '5');
      disciplineInfo('Autonomy level 1 (semi-automatic): assembled the slice paste-ready. Paste it into your agent.');
      disciplineInfo('Path: .discipline/paste-ready/step-5-input.md');
    } catch (err) {
      disciplineWarn(`Could not assemble the paste-ready: ${err instanceof Error ? err.message : err}`);
      return RUN_EXIT.CONFIG;
    }
    return RUN_EXIT.GREEN;
  }

  // Level >= 2 from here.
  const builder = getAdapter(builderName);
  const validator = getAdapter(validatorName);
  if (!builder) {
    disciplineWarn(`Unknown builder provider "${builderName}". Configure a valid builder in discipline.md §Autonomy.`);
    return RUN_EXIT.CONFIG;
  }

  // (c) Preconditions.
  const tree = gitPorcelainClean(root);
  if (!tree.ok) {
    disciplineWarn(`Cannot check the working tree with git: ${tree.detail}`);
    return RUN_EXIT.CONFIG;
  }
  if (!tree.clean && !opts.allowDirty) {
    disciplineWarn('Working tree is NOT clean. A headless run needs a clean tree so the diff is only this slice.');
    disciplineWarn('Commit/stash your changes, or pass --allow-dirty to override (the diff will include your existing changes).');
    return RUN_EXIT.CONFIG;
  }
  if (!tree.clean && opts.allowDirty) {
    disciplineWarn('--allow-dirty: proceeding with a DIRTY working tree. The review diff will include pre-existing changes.');
  }

  const taskPlanPath = path.join(root, 'task_plan.md');
  if (!fs.existsSync(taskPlanPath)) {
    disciplineWarn('task_plan.md not found. Run discipline:hydrate first.');
    return RUN_EXIT.CONFIG;
  }
  const sliceStatus = parseSliceStatus(fs.readFileSync(taskPlanPath, 'utf-8'), opts.slice);
  if (!sliceStatus.found) {
    disciplineWarn(`Slice "${opts.slice}" not found in task_plan.md §Ready Slices (looked for "## Slice ${opts.slice} - ...").`);
    return RUN_EXIT.CONFIG;
  }
  if (!sliceStatus.ready) {
    disciplineWarn(`Slice "${opts.slice}" has status "${sliceStatus.status}", which is not ready to run. Refusing.`);
    return RUN_EXIT.CONFIG;
  }

  const slicePacket = locateSlicePacket(root, opts.slice);
  if (!slicePacket) {
    disciplineWarn(`No STEP_5_SLICE_PACKET found for slice "${opts.slice}" in .discipline/packets/.`);
    disciplineWarn('Expected .discipline/packets/STEP_5_SLICE_PACKET.md (or STEP_5_SLICE_PACKET_<slice>.md). Run Step 4 first.');
    return RUN_EXIT.CONFIG;
  }

  // Crash recovery note: a prior run_started without run_finished + a stale lease.
  warnOnStaleRun(root, opts.slice);

  // (k) Dry-run: print the resolved plan and exit WITHOUT leasing/tagging/spawning.
  if (opts.dryRun) {
    const promptPreview = await buildBuilderPrompt(root).catch(() => '');
    printDryRunPlan(root, opts, autonomy, {
      builder: builderName,
      validator: validatorName,
      slicePacket,
      promptChars: promptPreview.length,
      timeoutMs,
    });
    return RUN_EXIT.GREEN;
  }

  // (d) Acquire the slice lease. One Writer Per Slice.
  try {
    acquireSliceLease(root, opts.slice, { tool: 'discipline:run' });
  } catch (err) {
    disciplineWarn(`Could not acquire the slice lease: ${err instanceof Error ? err.message : err}`);
    return RUN_EXIT.CONFIG;
  }

  const runId = makeRunId();
  let leaseReleased = false;
  const releaseLease = () => {
    if (leaseReleased) return;
    releaseSliceLease(root, opts.slice, { force: true });
    leaseReleased = true;
  };

  try {
    safeLedger(root, { event: 'run_started', run_id: runId, slice: opts.slice, autonomy: autonomy.level, builder: builderName, validator: validatorName });

    // (d) Pre-run safety tag: rollback = git reset --hard <tag>. Kept on clean finish (cheap, documented).
    const preTag = `disc/run-${runId}-pre`;
    const tagProc = spawnSync('git', ['tag', preTag], { cwd: root, encoding: 'utf-8' });
    if (tagProc.status !== 0) disciplineWarn(`Could not create pre-run tag ${preTag}: ${(tagProc.stderr || '').trim()} (continuing).`);
    else disciplineInfo(`Pre-run tag: ${preTag} (rollback: git reset --hard ${preTag}).`);

    // (e) Builder prompt.
    const builderPrompt = await buildBuilderPrompt(root);

    // (f) Level 2 confirms before the spawn; level 3 proceeds.
    if (autonomy.level === 2 && !opts.yes) {
      const proceed = await confirm(`Run builder "${builderName}" headless for slice ${opts.slice}? (~${builderPrompt.length} prompt chars, timeout ${opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN} min)`);
      if (!proceed) {
        disciplineInfo('Aborted before spawn (level 2 confirmation declined).');
        releaseLease();
        safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'aborted-by-user' });
        return RUN_EXIT.CONFIG;
      }
    }

    // (f) Spawn the builder.
    safeLedger(root, { event: 'step_started', run_id: runId, step: 'builder', provider: builderName });
    disciplineInfo(`Builder ${builderName} running (this calls the real CLI and can incur cost)...`);
    const buildOutcome = await runAdapter(builder, 'builder', builderPrompt, { timeoutMs, cwd: root });
    safeLedger(root, { event: 'step_finished', run_id: runId, step: 'builder', provider: builderName, ...ledgerStepFinished(buildOutcome) });

    if (buildOutcome.status === 'parked') {
      disciplineWarn(`Builder parked: ${buildOutcome.summary}. This did NOT consume the repair budget.`);
      disciplineWarn('Remediation: run `discipline doctor --providers` to check the CLI/login/rate-limit, then re-run.');
      releaseLease();
      safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'parked' });
      return RUN_EXIT.PARKED;
    }

    let sessionId = buildOutcome.sessionId;

    // (g) Plumbing: process any new packets exactly like watch does, under the writer lock.
    await processPacketsUnderLock(root);

    // (h) Gate + repair loop.
    const repairState: RepairState = { attempts: 1, signatures: [], repairMax: autonomy.repairMax };
    let report = runGateAndLog(root, runId);

    while (!report.passed) {
      const sig = report.error_signature ?? errorSignature(report.failed_checks[0] ?? 'gate', 'unknown');
      const decision = decideRepair(repairState, sig);
      repairState.signatures.push(sig);
      if (decision.action === 'stop') {
        disciplineWarn(`Repair loop stopped: ${decision.reason}. Signature: ${sig}.`);
        const outcome = await terminalStop(root, runId, opts, preTag, 'stopped-by-repair-budget');
        releaseLease();
        return outcome === 'ok' ? RUN_EXIT.REPAIR_STOP : RUN_EXIT.REPAIR_STOP;
      }

      // Re-invoke the builder with a REPAIR prompt, resuming the session when possible.
      const repairPrompt = buildRepairPrompt(report);
      const extraArgs = resumeArgsFor(builderName, sessionId);
      repairState.attempts += 1;
      safeLedger(root, { event: 'step_started', run_id: runId, step: 'repair', attempt: repairState.attempts, provider: builderName, resumed: extraArgs.length > 0 });
      disciplineInfo(`Repair attempt ${repairState.attempts - 1}/${autonomy.repairMax} via ${builderName}${extraArgs.length ? ' (resumed session)' : ''}...`);
      const repairOutcome = await runAdapter(builder, 'builder', repairPrompt, { timeoutMs, cwd: root, extraArgs });
      safeLedger(root, { event: 'step_finished', run_id: runId, step: 'repair', attempt: repairState.attempts, provider: builderName, ...ledgerStepFinished(repairOutcome) });

      if (repairOutcome.status === 'parked') {
        disciplineWarn(`Repair parked: ${repairOutcome.summary}. This did NOT consume the repair budget.`);
        releaseLease();
        safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'parked' });
        return RUN_EXIT.PARKED;
      }
      if (repairOutcome.sessionId) sessionId = repairOutcome.sessionId;

      await processPacketsUnderLock(root);
      report = runGateAndLog(root, runId);
    }

    disciplineInfo('Gate is GREEN.');

    // (i) Cross-validation advisory (family-different validator). Never blocks.
    if (validator) {
      await runCrossValidation(root, runId, opts.slice, validator.name as ProviderName, builderName, timeoutMs);
    } else {
      disciplineWarn(`Validator "${validatorName}" is not a known adapter; skipping the advisory cross-validation.`);
    }

    // (j) Terminal state ALWAYS stops before commit.
    await terminalStop(root, runId, opts, preTag, 'green');
    releaseLease();
    return RUN_EXIT.GREEN;
  } finally {
    releaseLease();
  }
}

/** Resume flags for a provider given a session id. Others: fresh call (no flags). */
function resumeArgsFor(provider: ProviderName, sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  if (provider === 'claude') return ['--resume', sessionId];
  // codex: `exec resume <id>` (volatile). We pass the resume subcommand + id; the
  // runner appends these after buildArgs, so this is best-effort for newer builds.
  if (provider === 'codex') return [...CODEX_RESUME_ARGS, sessionId];
  return []; // gemini / cursor: fresh call with the repair prompt as context.
}

/** Run the gate report, write it, and append the gate_result ledger event. */
function runGateAndLog(root: string, runId: string): GateReport {
  disciplineInfo('Running the gate (deterministic arbiter)...');
  const report = runGateReport(root);
  writeGateReport(root, report);
  safeLedger(root, {
    event: 'gate_result',
    run_id: runId,
    passed: report.passed,
    failed_checks: report.failed_checks,
    duration_ms: report.duration_ms,
    error_signature: report.error_signature,
  });
  disciplineInfo(`Gate ${report.passed ? 'PASSED' : 'FAILED'}${report.error_signature ? ` (sig ${report.error_signature.slice(0, 12)})` : ''}.`);
  return report;
}

/**
 * Extract+apply patches and update progress on completion packets, under the
 * writer lock (the same plumbing watch does). Async: it AWAITS applyPatches and
 * updateProgress so the mutations complete before the gate runs. We hold the
 * SYNC writer lock across the awaits (single process); applyPatches re-enters it
 * without re-acquiring. Only runs updateProgress if progress.md still has its
 * fixed header (it errors loudly otherwise, which we tolerate as a warning).
 */
async function processPacketsUnderLock(root: string): Promise<void> {
  const packetsDir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(packetsDir)) return;
  const packetFiles = fs.readdirSync(packetsDir).filter((f) => f.endsWith('.md'));
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');

  acquireWriterLock(root, { tool: 'discipline:run' });
  try {
    // Extract embedded patch blocks from every packet into pending, then apply.
    let extracted = 0;
    for (const name of packetFiles) {
      const full = path.join(packetsDir, name);
      const content = fs.readFileSync(full, 'utf-8');
      const patches = extractEmbeddedPatches(content, full);
      if (patches.length === 0) continue;
      if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });
      for (const patch of patches) {
        const patchFile = path.join(pendingDir, `${new Date().toISOString().slice(0, 10)}_${patch.name}.md`);
        fs.writeFileSync(
          patchFile,
          `## ${patch.name}\n\nTARGET_FILE: ${patch.targetFile}\nPATCH_MODE: ${patch.patchMode}\nANCHOR: ${patch.anchor}\n\n### CONTENT\n${patch.content}`,
          'utf-8',
        );
        extracted++;
      }
    }
    if (extracted > 0) {
      disciplineInfo(`Extracted ${extracted} patch block(s) from packets; applying...`);
      // applyPatches takes the (re-entrant) writer lock itself; we already hold it.
      await applyPatches(root);
    }
    if (packetFiles.some((f) => f.includes('SLICE_COMPLETION_PACKET'))) {
      disciplineInfo('SLICE_COMPLETION_PACKET present; updating progress.md...');
      await updateProgress(root);
    }
  } finally {
    releaseWriterLock(root);
  }
}

/**
 * Terminal stop: create the pre-commit checkpoint, render the diff HTML, open it
 * unless --no-open, and print the NEXT STEPS block. Returns 'ok' always.
 */
async function terminalStop(
  root: string,
  runId: string,
  opts: RunOptions,
  preTag: string,
  outcome: string,
): Promise<'ok'> {
  // Checkpoint (reuse checkpoint.ts create, kind pre-commit).
  let checkpointPath = '';
  try {
    checkpointPath = createCheckpoint(root, { slice: opts.slice, kind: 'pre-commit', summary: `Headless run ${runId} for slice ${opts.slice} (${outcome}).` });
  } catch (err) {
    disciplineWarn(`Could not create the checkpoint: ${err instanceof Error ? err.message : err}`);
  }

  // Diff HTML (reuse diff-report).
  let diffHtmlPath = '';
  const diff = gitDiffText(root);
  if (diff.trim()) {
    const html = diffToHtml(diff, { repoName: path.basename(root), timestamp: new Date().toISOString() });
    const reviewDir = path.join(root, '.discipline', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    diffHtmlPath = path.join(reviewDir, `run-${runId}.html`);
    fs.writeFileSync(diffHtmlPath, html, 'utf-8');
    if (opts.open) openInBrowser(diffHtmlPath);
  }

  safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome });

  const checkpointRef = checkpointPath ? path.relative(root, checkpointPath) : '(checkpoint unavailable)';
  disciplineInfo('');
  disciplineInfo('=== NEXT STEPS (the run stopped before commit, by design) ===');
  disciplineInfo(`1. Review the diff${diffHtmlPath ? `: ${path.relative(root, diffHtmlPath)}` : ' (git diff)'}`);
  disciplineInfo(`2. Approve the checkpoint:  npm run discipline -- approve ${checkpointRef}`);
  disciplineInfo(`3. Commit (after approval): git add -A && git commit -m "feat(${opts.slice}): <describe the slice>"`);
  disciplineInfo(`4. Rollback if wrong:       git reset --hard ${preTag}`);
  disciplineInfo(outcome === 'green' ? 'Outcome: GREEN gate. Yours to review.' : `Outcome: ${outcome}. Review before deciding.`);
  return 'ok';
}

/** Advisory cross-validation: family-different validator reviews the diff read-only. Never blocks. */
async function runCrossValidation(
  root: string,
  runId: string,
  sliceId: string,
  validatorName: ProviderName,
  builderName: ProviderName,
  timeoutMs: number,
): Promise<void> {
  if (familyOf(validatorName) === familyOf(builderName)) {
    disciplineWarn(`Cross-validation skipped: validator "${validatorName}" shares the builder family. (config should have corrected this.)`);
    return;
  }
  const validator = getAdapter(validatorName);
  if (!validator) return;

  const diff = gitDiffText(root);
  const slicePacket = readSlicePacket(root, sliceId);
  const prompt = [
    '## CROSS-VALIDATION (read-only review)',
    '',
    'You are a second, independent reviewer from a different model family. Do NOT edit files.',
    'Review the diff below against the slice packet and report a verdict.',
    '',
    'Reply with JSON: {"verdict": "pass" | "concerns", "notes": ["..."]}. If you cannot produce JSON, write plain notes.',
    '',
    '### Slice packet',
    slicePacket.slice(0, 6000),
    '',
    '### Diff (git diff)',
    '```diff',
    diff.slice(0, 20000),
    '```',
  ].join('\n');

  disciplineInfo(`Cross-validation via ${validatorName} (advisory, read-only)...`);
  safeLedger(root, { event: 'step_started', run_id: runId, step: 'cross_validate', provider: validatorName });
  const outcome = await runAdapter(validator, 'validator', prompt, { timeoutMs, cwd: root });
  safeLedger(root, { event: 'step_finished', run_id: runId, step: 'cross_validate', provider: validatorName, ...ledgerStepFinished(outcome) });

  if (outcome.status === 'parked') {
    disciplineWarn(`Cross-validation parked (${outcome.summary}); advisory only, not blocking.`);
    return;
  }
  if (outcome.status === 'failed') {
    disciplineWarn(`Cross-validation failed (${outcome.summary}); advisory only, not blocking.`);
  }

  const verdict = parseVerdict(outcome.summary);
  const reportMd = buildCrossValidationReport({
    slice: sliceId,
    runId,
    validator: validatorName,
    builder: builderName,
    verdict: verdict.verdict,
    notes: verdict.notes,
    rawSummary: outcome.summary,
  });
  const dir = path.join(root, '.discipline', 'packets');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(sliceId).replace(/[^A-Za-z0-9._-]/g, '_');
  const outPath = path.join(dir, `CROSS_VALIDATION_REPORT_${safe}_${tsSlug()}.md`);
  fs.writeFileSync(outPath, reportMd, 'utf-8');
  disciplineInfo(`Cross-validation report: ${path.relative(root, outPath)} (verdict: ${verdict.verdict}).`);
}

/** Warn (do not fail) when a prior run_started for this slice never finished and the lease is stale. */
function warnOnStaleRun(root: string, sliceId: string): void {
  try {
    const lease = sliceLeaseStatus(root, sliceId);
    if (!lease) return;
    // A live lease from another tool blocks the acquire later anyway; only note it here.
    disciplineWarn(`Note: a lease for slice ${sliceId} already exists (held by ${lease.tool} since ${lease.acquired_at}).`);
    disciplineWarn('Crash recovery is "just re-run": the files are the state. If a prior run crashed, this run continues fresh.');
  } catch {
    // best-effort
  }
}

// --- Dry-run plan -----------------------------------------------------------

function printDryRunPlan(
  root: string,
  opts: RunOptions,
  autonomy: AutonomyConfig,
  info: { builder: string; validator: string; slicePacket: string; promptChars: number; timeoutMs: number },
): void {
  disciplineInfo('=== discipline run --dry-run (no spawn, no lease, no tag) ===');
  disciplineInfo(`slice:        ${opts.slice}`);
  disciplineInfo(`autonomy:     level ${autonomy.level} (builder ${info.builder}, validator ${info.validator}, repair_max ${autonomy.repairMax}${autonomy.perRunUsd !== null ? `, per_run_usd ${autonomy.perRunUsd}` : ''})`);
  disciplineInfo(`builder CLI:  ${getAdapter(info.builder)?.cli ?? '(unknown)'}  args: ${JSON.stringify(getAdapter(info.builder)?.buildArgs('builder') ?? [])}`);
  disciplineInfo(`validator:    ${info.validator} (${getAdapter(info.validator)?.cli ?? 'n/a'}), family-different: ${familyOf(info.validator) !== familyOf(info.builder)}`);
  disciplineInfo(`slice packet: ${path.relative(root, info.slicePacket)}`);
  disciplineInfo(`prompt size:  ~${info.promptChars} chars (delivered via stdin)`);
  disciplineInfo(`timeout:      ${Math.round(info.timeoutMs / 60000)} min, tree-kill on timeout`);
  disciplineInfo('files it may touch: discipline.md, task_plan.md, findings.md, progress.md (via patch engine), plus code/tests written by the builder');
  disciplineInfo('it will STOP before commit: writes a pre-commit checkpoint + diff HTML for human review.');
}

// --- CLI --------------------------------------------------------------------

const USAGE = [
  'Usage: discipline run --slice <id> [--autonomy 0..3] [--dry-run] [--yes] [--allow-dirty] [--no-open] [--timeout-min N]',
  '',
  'Runs ONE stateless tick for one slice. Level 0/1 are plumbing only; level >=2 spawns the',
  'configured builder headless, runs the gate, repairs within the budget, cross-validates',
  '(advisory), and STOPS before commit for human review.',
  'Exit codes: 0 green, 2 config/precondition error, 3 parked, 4 stopped by the repair budget.',
].join('\n');

export function parseRunArgs(argv: string[]): RunOptions | null {
  const args = minimist(argv, {
    string: ['slice', 'timeout-min', 'autonomy', 'builder', 'validator'],
    boolean: ['dry-run', 'yes', 'allow-dirty', 'open', 'cross-validate-only'],
    // --no-open sets open:false via minimist's negation; default open:true.
    default: { open: true },
  });
  const slice = args.slice ? String(args.slice) : (args._[0] !== undefined ? String(args._[0]) : '');
  const crossValidateOnly = args['cross-validate-only'] === true;
  // cross-validate-only can run without a specific slice (it reviews the diff);
  // use a placeholder id so the report/ledger still have a value.
  if (!slice && !crossValidateOnly) return null;
  const autonomyFlag = args.autonomy !== undefined ? Number(args.autonomy) : undefined;
  const timeoutMin = args['timeout-min'] !== undefined ? Number(args['timeout-min']) : undefined;
  const builderOverride = args.builder ? (String(args.builder) as ProviderName) : undefined;
  const validatorOverride = args.validator ? (String(args.validator) as ProviderName) : undefined;
  return {
    slice: slice || 'current',
    autonomyFlag: Number.isNaN(autonomyFlag as number) ? undefined : autonomyFlag,
    dryRun: args['dry-run'] === true,
    yes: args.yes === true,
    allowDirty: args['allow-dirty'] === true,
    open: args.open !== false,
    timeoutMin: Number.isNaN(timeoutMin as number) ? undefined : timeoutMin,
    builderOverride,
    validatorOverride,
    crossValidateOnly,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rawArgs = minimist(process.argv.slice(2), { string: ['project-dir'] });
  const projectRoot = resolveProjectRoot(rawArgs['project-dir']);
  const opts = parseRunArgs(process.argv.slice(2));
  if (!opts) {
    disciplineWarn(`Missing --slice.\n${USAGE}`);
    process.exit(RUN_EXIT.CONFIG);
  } else {
    runReconciler(projectRoot, opts)
      .then((code) => process.exit(code))
      .catch((err) => {
        disciplineWarn(`Run failed: ${err instanceof Error ? err.message : err}`);
        process.exit(RUN_EXIT.CONFIG);
      });
  }
}
