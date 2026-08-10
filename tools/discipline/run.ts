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
import { disciplineInfo, disciplineWarn, type ParsedPatch } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { acquireSliceLease, releaseSliceLease, sliceLeaseStatus, acquireWriterLock, releaseWriterLock, isStopped } from './lib/locks.js';
import { appendLedger, errorSignature } from './lib/ledger.js';
import { assemblePasteReady } from './assemble-paste-ready.js';
import { extractEmbeddedPatches } from './lib/parse-patch.js';
import { applyPatches } from './apply-patch.js';
import { locateSlicePacket, normalizeSliceId, packetStatus, resolvePacketIdentity, resolveSlice, slicePasteReadyFileName } from './lib/slice-identity.js';
import { readCompletion } from './lib/completion-packet.js';
import { recordClosure } from './update-progress.js';
import { runGateReport, writeGateReport, type GateReport } from './gate-report.js';
import { runChangedGate, writeGateReportV2, printChangedGate, type GateReportV2 } from './gate-changed.js';
import { GateConfigError } from './lib/gates-config.js';
import { ChangedFilesError } from './lib/changed-files.js';
import { createCheckpoint } from './checkpoint.js';
import { diffToHtml } from './diff-report.js';
import { loadAutonomy, enforceValidatorFamily, type AutonomyConfig, type ProviderName } from './lib/autonomy.js';
import { getAdapter, runAdapter, familyOf, CODEX_RESUME_ARGS, type RunAdapterOutcome } from './lib/providers/index.js';
import { buildCrossValidationReport, parseVerdict } from './lib/cross-validation.js';

// INCOMPLETE: the builder ran but this run cannot close its slice, so it is NOT green. A run that
// reported 0 while saying "no completion packet for slice 2" is the false green this code exists to
// prevent: the exit code is what a CI job, a wrapper script or a tired human actually reads.
export const RUN_EXIT = { GREEN: 0, CONFIG: 2, PARKED: 3, REPAIR_STOP: 4, INCOMPLETE: 5 } as const;

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
  /** True only when the status is explicitly ready, or absent for legacy plans. */
  ready: boolean;
}

/**
 * Parse a slice's status from task_plan.md §Ready Slices leniently. Slices are
 * headings like `## Slice 3 - Name`; an optional `- Status: <value>` line inside
 * the section (or a bracketed marker in the heading) sets the status. Missing
 * status is treated as ready for legacy plans, but an explicit unrecognized or
 * malformed marker is refused rather than silently promoted to ready.
 */
export function parseSliceStatus(taskPlan: string, sliceId: string): SliceStatus {
  const lines = taskPlan.split('\n');
  // Identity comes from lib/slice-identity, the one definition of "which slice is this" shared by
  // the runner, the watcher, the assembler and the validator. A duplicate heading is refused here
  // instead of resolved to the first match: the two copies can carry different statuses.
  const resolution = resolveSlice(taskPlan, sliceId);
  if (!resolution.ok) {
    // Every refusal that has something to say says it: reporting only the duplicate case left a
    // table/section contradiction as a bare "not found in task_plan.md", which sends the operator
    // looking for a missing slice instead of at the two lines that disagree.
    return { found: false, status: resolution.reason === 'not-found' ? null : resolution.message, ready: false };
  }
  const start = resolution.heading.line;
  const level = resolution.heading.level;

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
  let sectionStatus: string | null = null;
  const statusLine = section.match(/^[-*]?\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(.+)$/im);
  if (statusLine) sectionStatus = normalizeSliceStatus(statusLine[1]);
  else {
    const bracket = heading.match(/\[([^\]]+)\]/);
    if (bracket) sectionStatus = normalizeSliceStatus(bracket[1]);
  }

  // The §4 Ready Slices table is a statement about the slice too, and the plan's most visible one.
  // Reading only the section threw it away: a row marked `done`, `planned` or `blocked` was
  // invisible whenever the slice's own section did not repeat the status, and the legacy
  // "no status means ready" fallback then handed the slice straight back to the runner. resolveSlice
  // already refuses a table that disagrees with the section, so when both are present they agree.
  const tableStatus = resolution.tableStatus ? normalizeSliceStatus(resolution.tableStatus) : null;
  const status = sectionStatus ?? tableStatus;

  // The legacy fallback applies ONLY when the plan states no status anywhere: an old plan with no
  // table and no Status line still runs, a plan that says something is taken at its word.
  const ready = status === null || status.toLowerCase() === 'ready';
  return { found: true, status, ready };
}

function normalizeSliceStatus(raw: string): string {
  const value = raw.trim();
  // `planned` is what Step 4 writes for a slice it expanded but did not promote, so it has to be a
  // recognized state and not an "invalid marker": both are refused, but only one is honest.
  const recognized = /^(ready|planned|in-progress(?:[a-z-]*)?|in_progress(?:_[a-z_]*)?|blocked|done|complete|cloud|hold|wip)$/i;
  return recognized.test(value) ? value : `invalid marker: ${value}`;
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

/**
 * Build the builder prompt: THIS slice's assembled step-5 paste-ready + the run contract.
 *
 * The slice id is not optional. The run validated `locateSlicePacket(root, slice)` and then
 * assembled without a slice, which goes through the one door that does not check identity: the
 * builder could be handed the generic packet, or another slice's, against this slice's plan entry
 * and this slice's lease.
 */
export async function buildBuilderPrompt(root: string, sliceId: string): Promise<string> {
  const assembled = await assemblePasteReady(root, '5', sliceId);
  return `${assembled}${RUN_CONTRACT}`;
}

/** A gate result the repair loop can read, whichever schema produced it. */
type GateReportLike = GateReport | GateReportV2;

/** Build a repair prompt: the failed checks + first errors + fix-with-new-info instruction. */
export function buildRepairPrompt(report: GateReportLike): string {
  const failed = report.failed_checks.length ? report.failed_checks.map((c) => `- ${c}`).join('\n') : '- (none reported)';
  const errs = report.steps
    .filter((s) => s.exit !== 0 && s.firstError)
    .map((s) => `- [${s.cmd}] ${s.firstError}`)
    .join('\n');
  // A refusal never ran a gate: the fix is the packet or the diff, not the code.
  // Saying "the gate failed" here would send the builder looking for a bug there is none of.
  const refusal = 'refusal' in report ? report.refusal : null;
  if (refusal) {
    return [
      '## REPAIR TURN (the gate refused to run)',
      '',
      'No gate ran. The change and the slice packet do not agree about what this slice touches:',
      '',
      refusal,
      '',
      'Fix the disagreement itself: declare the missing surface in the packet (emit a patch block for it),',
      'or take the files that imply it out of this slice. Do NOT change code to make the message go away.',
      'Then emit updated patch blocks and an updated SLICE_COMPLETION_PACKET, and do NOT commit.',
    ].join('\n');
  }
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
  const taskPlanPath = path.join(root, 'task_plan.md');
  const taskPlan = fs.existsSync(taskPlanPath) ? fs.readFileSync(taskPlanPath, 'utf-8') : undefined;
  const located = locateSlicePacket(root, sliceId, taskPlan);
  if (!located.ok) return `(slice packet not usable: ${located.message})`;
  try {
    return fs.readFileSync(located.path, 'utf-8');
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

  const taskPlanPath = path.join(root, 'task_plan.md');
  if (!fs.existsSync(taskPlanPath)) {
    disciplineWarn('task_plan.md not found. Run discipline:hydrate first.');
    return RUN_EXIT.CONFIG;
  }
  const sliceStatus = parseSliceStatus(fs.readFileSync(taskPlanPath, 'utf-8'), opts.slice);
  if (!sliceStatus.found) {
    disciplineWarn(sliceStatus.status
      ?? `Slice "${opts.slice}" not found in task_plan.md §Ready Slices (looked for "## Slice ${opts.slice} - ...").`);
    return RUN_EXIT.CONFIG;
  }
  if (!sliceStatus.ready) {
    disciplineWarn(`Slice "${opts.slice}" has status "${sliceStatus.status}", which is not ready to run. Refusing.`);
    return RUN_EXIT.CONFIG;
  }

  // The packet must prove it belongs to THIS slice: a generic packet matched by filename alone
  // is how a run ends up implementing someone else's slice against this slice's plan entry.
  const located = locateSlicePacket(root, opts.slice, fs.readFileSync(taskPlanPath, 'utf-8'));
  if (!located.ok) {
    disciplineWarn(located.message);
    return RUN_EXIT.CONFIG;
  }
  for (const warning of located.warnings) disciplineWarn(warning);
  const slicePacket = located.path;

  // A packet is work only while its status is `ready`, the same rule the watcher's Step 5
  // selection applies. Without it a run could implement a draft, or re-implement a slice already
  // consumed, purely because a file with the right name was still sitting in .discipline/packets/.
  const packetState = packetStatus(fs.readFileSync(slicePacket, 'utf-8'));
  if (packetState !== 'ready') {
    disciplineWarn(`${path.basename(slicePacket)} has status ${packetState ? `"${packetState}"` : '(none declared)'}, not "ready". Refusing to run it.`);
    disciplineWarn('Declare `status: ready` in the packet when it is the work to do; a draft, a consumed or a status-less packet is not.');
    return RUN_EXIT.CONFIG;
  }

  // (b) Level 0 and Level 1 are plumbing-only, but the slice identity still has to hold: an
  // assembled handoff that silently used the generic packet is exactly the failure this phase
  // removes, and it is worse at L0/L1 because a human pastes it without a second check.
  const sliceHandoff = slicePasteReadyFileName(opts.slice);
  if (autonomy.level === 0) {
    disciplineInfo('Autonomy level 0 (manual): no headless execution is configured.');
    disciplineInfo(`Paste-ready for the slice lives at .discipline/paste-ready/${sliceHandoff} (run \`discipline assemble --step 5 --slice ${opts.slice}\` to (re)build it).`);
    return RUN_EXIT.GREEN;
  }
  if (autonomy.level === 1) {
    try {
      await assemblePasteReady(root, '5', opts.slice);
      disciplineInfo('Autonomy level 1 (semi-automatic): assembled the slice paste-ready. Paste it into your agent.');
      disciplineInfo(`Path: .discipline/paste-ready/${sliceHandoff}`);
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

  // Crash recovery note: a prior run_started without run_finished + a stale lease.
  warnOnStaleRun(root, opts.slice);

  // (k) Dry-run: print the resolved plan and exit WITHOUT leasing/tagging/spawning.
  if (opts.dryRun) {
    // A dry run exists to answer "what would this run do?". Swallowing the assembly failure
    // answered "0 prompt chars" and exited GREEN, which reads as a plan that is ready to go.
    let promptPreview: string;
    try {
      promptPreview = await buildBuilderPrompt(root, opts.slice);
    } catch (err) {
      disciplineWarn(`Could not assemble the paste-ready for slice ${opts.slice}: ${err instanceof Error ? err.message : err}`);
      disciplineWarn('The real run would fail here too, so the plan is not green. Fix the packet and re-run.');
      return RUN_EXIT.CONFIG;
    }
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
    // The gate measures the change against this tag, so a commit made mid-run is
    // still part of what gets gated. Without the tag there is no base to measure
    // from, and the gate falls back to the working tree alone.
    const gateBase = tagProc.status === 0 ? preTag : null;

    // (e) Builder prompt, for THIS slice.
    const builderPrompt = await buildBuilderPrompt(root, opts.slice);

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
    const packetsBeforeBuild = snapshotPackets(root);
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

    // (g) Plumbing: decide on the packets THIS spawn wrote BEFORE writing anything, then apply.
    // `alreadyFinished` is set on the path that went through terminalStop, which writes the
    // run_finished event itself. One run, one terminal event: two of them made the ledger say a
    // run ended twice, and the ledger is what the Repair Budget and the crash check read.
    const incomplete = (reason: string, wrote: boolean, alreadyFinished = false) => {
      disciplineWarn(`This run cannot close slice ${opts.slice}: ${reason}`);
      disciplineWarn(wrote
        ? 'The gate ran and the patches were applied; the closure was not recorded. Review the diff, fix the completion packet and re-run.'
        : 'Nothing written: no patch applied, progress.md and the packets untouched.');
      disciplineWarn('The RUN CONTRACT asks the builder for exactly one SLICE_COMPLETION_PACKET for this slice, with an outcome and an explicit GATE_STATE.');
      if (!alreadyFinished) safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'incomplete' });
      return RUN_EXIT.INCOMPLETE;
    };

    const built = preflightPackets(root, opts.slice, packetsWrittenSince(root, packetsBeforeBuild));
    if (!built.ok) { releaseLease(); return incomplete(built.reason, false); }
    if (!built.plan.completion) {
      releaseLease();
      return incomplete('the builder wrote no SLICE_COMPLETION_PACKET for it', false);
    }
    let completionPath = built.plan.completion;
    await applyPlanUnderLock(root, built.plan.patches);

    // (h) Gate + repair loop.
    const repairState: RepairState = { attempts: 1, signatures: [], repairMax: autonomy.repairMax };
    let report = runGateAndLog(root, runId, opts.slice, gateBase);

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
      const packetsBeforeRepair = snapshotPackets(root);
      const repairOutcome = await runAdapter(builder, 'builder', repairPrompt, { timeoutMs, cwd: root, extraArgs });
      safeLedger(root, { event: 'step_finished', run_id: runId, step: 'repair', attempt: repairState.attempts, provider: builderName, ...ledgerStepFinished(repairOutcome) });

      if (repairOutcome.status === 'parked') {
        disciplineWarn(`Repair parked: ${repairOutcome.summary}. This did NOT consume the repair budget.`);
        releaseLease();
        safeLedger(root, { event: 'run_finished', run_id: runId, slice: opts.slice, outcome: 'parked' });
        return RUN_EXIT.PARKED;
      }
      if (repairOutcome.sessionId) sessionId = repairOutcome.sessionId;

      // A repair turn may or may not re-emit the packet. What it DOES emit is validated the same
      // way, and a completion it writes replaces the one this run is closing with; writing none
      // leaves the build pass's completion in place, which is still a completion for this slice.
      const repaired = preflightPackets(root, opts.slice, packetsWrittenSince(root, packetsBeforeRepair));
      if (!repaired.ok) { releaseLease(); return incomplete(repaired.reason, true); }
      if (repaired.plan.completion) completionPath = repaired.plan.completion;
      await applyPlanUnderLock(root, repaired.plan.patches);
      report = runGateAndLog(root, runId, opts.slice, gateBase);
    }

    disciplineInfo('Gate is GREEN.');

    // (i) The closure is recorded only now: the gate is what makes it true. If it cannot be
    // recorded, the run is not green, however green the gate is.
    const closure = await recordClosureUnderLock(root, opts.slice, completionPath);
    if (!closure.ok) {
      // terminalStop writes the run_finished event for this path, so `incomplete` must not.
      await terminalStop(root, runId, opts, preTag, 'incomplete');
      releaseLease();
      return incomplete(`the closure could not be recorded: ${closure.reason}`, true, true);
    }

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

/**
 * Run the gate, write its report, and append the gate_result ledger event.
 *
 * A headless run knows exactly what it changed and which slice it is closing, so
 * it uses `gate --changed`: the gates its surfaces call for, plus whatever the
 * packet's `required_gates` demands (the shipped Step 4 template asks for the
 * full `gate`, so this is a superset of the old behavior, not a smaller one),
 * plus the full gate whenever a changed file matches no rule.
 *
 * The point in a headless run is not speed. It is that a builder which touched a
 * surface its packet never declared stops the run instead of closing the slice.
 *
 * A project without `.discipline/gates.json` (or with git unavailable) falls back
 * to the full gate, loudly. Being unable to select a subset is a reason to run
 * everything, never a reason to run less.
 */
function runGateAndLog(root: string, runId: string, slice: string, base: string | null): GateReportLike {
  let report: GateReportLike;
  try {
    disciplineInfo('Running the gate for what changed (deterministic arbiter)...');
    const changed = runChangedGate(root, { slice, base });
    writeGateReportV2(root, changed);
    printChangedGate(changed);
    report = changed;
  } catch (err) {
    if (!(err instanceof GateConfigError || err instanceof ChangedFilesError)) throw err;
    disciplineWarn(`Cannot scope the gate to what changed (${err.message}). Running the full gate instead.`);
    const full = runGateReport(root);
    writeGateReport(root, full);
    report = full;
  }
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

/** What a spawn's packets amount to: the patches to apply and the completion it closes with. */
interface PacketPlan {
  patches: ParsedPatch[];
  /** The single completion packet for the leased slice, or null when this spawn wrote none. */
  completion: string | null;
}
type PacketPreflight = { ok: true; plan: PacketPlan } | { ok: false; reason: string };

/**
 * Read everything this spawn wrote and decide what the run may do, WITHOUT writing a byte.
 *
 * Ordering is the whole point. The plumbing used to apply the patches first and look at the
 * completion afterwards, warning if it was missing, foreign, duplicated or unrecordable, and the
 * run still went on to a green gate and exit 0. So a builder could rewrite the four state files,
 * close somebody else's slice, and the run reported success for a slice it never completed. A
 * completion that cannot close this slice is now a rejection, decided before any patch is staged.
 *
 * ONLY what this spawn wrote is considered: reading the whole directory re-applied the patch
 * blocks of every historical packet on every tick.
 */
function preflightPackets(root: string, sliceId: string, fresh: string[]): PacketPreflight {
  const packetsDir = path.join(root, '.discipline', 'packets');
  const patches: ParsedPatch[] = [];
  const completions: string[] = [];

  for (const name of fresh) {
    const full = path.join(packetsDir, name);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      return { ok: false, reason: `${name} could not be read: ${err instanceof Error ? err.message : err}` };
    }
    try {
      patches.push(...extractEmbeddedPatches(content, full));
    } catch (err) {
      return { ok: false, reason: `malformed patch block in ${name}: ${err instanceof Error ? err.message : err}` };
    }
    if (!name.includes('SLICE_COMPLETION_PACKET')) continue;

    // A completion packet has to prove what it closes, and it has to close THIS slice.
    const identity = resolvePacketIdentity(content, name);
    if (!identity.ok) return { ok: false, reason: identity.message };
    if (!identity.id) return { ok: false, reason: `${name} does not say which slice it closes. Add a SLICE: line naming exactly one slice.` };
    if (normalizeSliceId(identity.id) !== normalizeSliceId(sliceId)) {
      return { ok: false, reason: `${name} closes slice ${identity.id}, and this run leased slice ${sliceId}. A run implements the slice it leased.` };
    }
    // The same refusals the progress engine makes, from the same function, before the patches.
    const reading = readCompletion(content);
    if (!reading.ok) return { ok: false, reason: `${name}: ${reading.reason}` };
    completions.push(full);
  }

  if (completions.length > 1) {
    return { ok: false, reason: `${completions.length} completion packets claim slice ${sliceId} (${completions.map((c) => path.basename(c)).join(', ')}); the run will not pick one for you.` };
  }
  return { ok: true, plan: { patches, completion: completions[0] ?? null } };
}

/**
 * Stage and apply the patches a preflight approved, under the writer lock (the same plumbing watch
 * does). Async: it AWAITS applyPatches so the mutations complete before the gate runs. We hold the
 * SYNC writer lock across the await (single process); applyPatches re-enters it without
 * re-acquiring.
 */
async function applyPlanUnderLock(root: string, patches: ParsedPatch[]): Promise<void> {
  if (patches.length === 0) return;
  const pendingDir = path.join(root, '.discipline', 'patches', 'pending');
  acquireWriterLock(root, { tool: 'discipline:run' });
  try {
    if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });
    for (const patch of patches) {
      const patchFile = path.join(pendingDir, `${new Date().toISOString().slice(0, 10)}_${patch.name}.md`);
      fs.writeFileSync(
        patchFile,
        `## ${patch.name}\n\nTARGET_FILE: ${patch.targetFile}\nPATCH_MODE: ${patch.patchMode}\nANCHOR: ${patch.anchor}\n\n### CONTENT\n${patch.content}`,
        'utf-8',
      );
    }
    disciplineInfo(`Extracted ${patches.length} patch block(s) from this run's packets; applying...`);
    await applyPatches(root);
  } finally {
    releaseWriterLock(root);
  }
}

/**
 * Record the closure, as one transition that either lands whole or leaves progress.md as it was.
 * Runs only after the gate is GREEN, because a green gate is what makes the closure true; recording
 * it before the gate logged slices as closed that the very next step refused.
 */
async function recordClosureUnderLock(root: string, sliceId: string, completionPath: string): Promise<{ ok: boolean; reason?: string }> {
  acquireWriterLock(root, { tool: 'discipline:run' });
  try {
    // A run must CLOSE the slice it leased: a packet that records `partial` has not finished it.
    const result = await recordClosure(root, sliceId, completionPath, { requireConsumption: true });
    if (!result.ok) {
      return { ok: false, reason: result.restored ? `${result.reason} (progress.md restored)` : result.reason };
    }
    disciplineInfo(`Slice ${sliceId} consumed: ${path.basename(result.packet ?? '')} marked status: consumed.`);
    return { ok: true };
  } finally {
    releaseWriterLock(root);
  }
}

/**
 * A content fingerprint of `.discipline/packets/`, so "what this spawn wrote" is a fact rather
 * than a guess. Content, not mtime: a rewritten packet with the same size and timestamp is still
 * a rewritten packet, and a run must not plumb what it did not produce.
 */
function snapshotPackets(root: string): Map<string, string> {
  const dir = path.join(root, '.discipline', 'packets');
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(dir)) return snapshot;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    try {
      snapshot.set(name, crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, name))).digest('hex'));
    } catch {
      snapshot.set(name, 'unreadable');
    }
  }
  return snapshot;
}

/** The packet files added or rewritten since `before`, in name order. */
function packetsWrittenSince(root: string, before: Map<string, string>): string[] {
  return [...snapshotPackets(root).entries()]
    .filter(([name, digest]) => before.get(name) !== digest)
    .map(([name]) => name)
    .sort();
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
