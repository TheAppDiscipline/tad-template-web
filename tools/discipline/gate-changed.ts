import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { appendLedger, errorSignature } from './lib/ledger.js';
import { firstErrorLine, type GateStepResult } from './gate-report.js';
import { GATE_REPORT_SCHEMA_V2, GATE_REPORT_FILE } from './lib/gate-report-io.js';
import {
  loadGatesConfig, gatesForSurfaces, inferSurfaces, readScriptNames, GateConfigError,
  type GatesConfig,
} from './lib/gates-config.js';
import { collectChangedFiles, ChangedFilesError } from './lib/changed-files.js';
import { locateSlicePacket } from './lib/slice-identity.js';
import { declaredSurfaces, AFFECTED_SURFACES, type AffectedSurface } from './lib/step5-schema.js';

/**
 * `gate --changed`: run the gates the change actually needs, and refuse when the
 * change and the packet disagree about what it touched.
 *
 * The full `npm run gate` is unchanged and still the answer that is always right.
 * This is the hybrid: a subset chosen from `.discipline/gates.json`, from the
 * union of committed, staged, unstaged and untracked changes.
 *
 * Every path that could shrink the subset is closed:
 *   - git failing is fatal, because "we could not tell what changed" and "nothing
 *     changed" would otherwise produce the same green;
 *   - a file no rule matches pulls in the FULL gate, because not knowing what
 *     covers a file is a reason to run more;
 *   - a surface the change implies and the packet did not declare STOPS the run
 *     before any gate: the packet is the document a builder works from, and a
 *     surface missing there is a gate nobody was ever going to run;
 *   - a declared surface the change does NOT touch is fine, and its gates run
 *     anyway. Over-declaring costs time; under-declaring costs coverage.
 *
 * The report it writes is `discipline.gate_report.v2`, at the same path v1 uses,
 * carrying the same pass/fail fields plus the files, surfaces and commands the
 * subset was chosen from -- so the choice can be audited, not just trusted.
 */

export const GATE_CHANGED_EXIT = { GREEN: 0, FAILED: 1, REFUSED: 2 } as const;

export interface ChangedGateOptions {
  base?: string | null;
  slice?: string | null;
}

export interface SurfacePlan {
  /** Surfaces the changed files imply. */
  inferred: AffectedSurface[];
  /** Surfaces the slice packet declares, or null when no packet was consulted / it is legacy. */
  declared: AffectedSurface[] | null;
  /** What the run is scoped to: inferred ∪ declared. */
  used: AffectedSurface[];
  /** Inferred but not declared. Any of these refuses the run. */
  omitted: AffectedSurface[];
  /** Declared but not inferred. Harmless; their gates still run. */
  extra: AffectedSurface[];
}

export interface ChangedGatePlan {
  base: string | null;
  slice: string | null;
  files: string[];
  surfaces: SurfacePlan;
  /** Files that matched no rule; they are why `unmapped` (the full gate) is in the list. */
  unmappedFiles: string[];
  /** Files the config says need no gate of their own. */
  excludedFiles: string[];
  /** Which files put each surface on the list. */
  evidence: Record<string, string[]>;
  /** npm scripts to run, in order, deduplicated. */
  scripts: string[];
  /** Why the run cannot proceed, or null. A refusal runs nothing. */
  refusal: string | null;
  /** Anything the operator should know that is not a refusal. */
  notes: string[];
}

export interface GateReportV2 {
  schema: typeof GATE_REPORT_SCHEMA_V2;
  ts: string;
  mode: 'changed';
  passed: boolean;
  duration_ms: number;
  base: string | null;
  slice: string | null;
  files: string[];
  surfaces: SurfacePlan;
  unmapped_files: string[];
  excluded_files: string[];
  steps: GateStepResult[];
  failed_checks: string[];
  error_signature: string | null;
  refusal: string | null;
  notes: string[];
}

/** How a step is executed. Injectable so tests can exercise the selector without running real gates. */
export interface GateExecOps {
  run(root: string, script: string): { status: number; stdout: string; stderr: string };
}

const DEFAULT_EXEC: GateExecOps = {
  run(root, script) {
    const proc = spawnSync(`npm run ${script}`, { cwd: root, shell: true, stdio: 'pipe', encoding: 'utf-8' });
    return { status: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
  },
};

const sortSurfaces = (surfaces: Iterable<AffectedSurface>): AffectedSurface[] => {
  const set = new Set(surfaces);
  return AFFECTED_SURFACES.filter((s) => set.has(s));
};

/** Read the packet's declaration for `slice`, or explain why there is none to read. */
function readDeclaration(
  root: string,
  slice: string,
): { ok: true; surfaces: AffectedSurface[] | null; requiredGates: string[]; note: string | null } | { ok: false; reason: string } {
  const taskPlanPath = path.join(root, 'task_plan.md');
  const taskPlan = fs.existsSync(taskPlanPath) ? fs.readFileSync(taskPlanPath, 'utf-8') : undefined;
  const located = locateSlicePacket(root, slice, taskPlan);
  if (!located.ok) return { ok: false, reason: located.message };

  const content = fs.readFileSync(located.path, 'utf-8');
  const declaration = declaredSurfaces(content);
  if (declaration.invalid.length) {
    return {
      ok: false,
      reason:
        `${path.basename(located.path)} declares ${declaration.invalid.map((s) => `"${s}"`).join(', ')} in affected_surfaces, ` +
        `which is not a surface. Valid: ${AFFECTED_SURFACES.join(', ')}. A surface nobody recognizes routes no gate.`,
    };
  }
  if (declaration.surfaces === null) {
    return {
      ok: true,
      surfaces: null,
      requiredGates: declaration.requiredGates,
      note:
        `${path.basename(located.path)} is a ${declaration.format} packet and declares no affected_surfaces, ` +
        'so there is nothing to check the change against. The gates below come from the changed files alone.',
    };
  }
  return { ok: true, surfaces: declaration.surfaces, requiredGates: declaration.requiredGates, note: null };
}

/**
 * Decide what to run, without running anything. Every refusal is decided here,
 * before a single gate starts: a run that is going to be refused should cost
 * seconds, not the length of a test suite.
 */
export function planChangedGate(root: string, options: ChangedGateOptions, config?: GatesConfig): ChangedGatePlan {
  const gates = config ?? loadGatesConfig(root);
  const changed = collectChangedFiles(root, options.base ?? null);
  const inference = inferSurfaces(gates, changed.files);
  const notes: string[] = [];
  const slice = options.slice ?? null;

  let declared: AffectedSurface[] | null = null;
  let requiredGates: string[] = [];
  let refusal: string | null = null;

  if (slice) {
    const declaration = readDeclaration(root, slice);
    if (!declaration.ok) {
      refusal = declaration.reason;
    } else {
      declared = declaration.surfaces;
      requiredGates = declaration.requiredGates;
      if (declaration.note) notes.push(declaration.note);
    }
  }

  const inferred = inference.surfaces;
  const omitted = declared === null ? [] : inferred.filter((s) => !declared.includes(s));
  const extra = declared === null ? [] : declared.filter((s) => !inferred.includes(s));
  const used = sortSurfaces([...inferred, ...(declared ?? [])]);

  const scripts = gatesForSurfaces(gates, used);
  // required_gates is what the packet asks for on top of its surfaces. It is
  // additive by construction: this list only ever grows the run.
  for (const script of requiredGates) if (!scripts.includes(script)) scripts.push(script);
  if (inference.unmapped.length && !scripts.includes(gates.unmapped)) scripts.push(gates.unmapped);

  if (refusal === null && slice && changed.files.length === 0) {
    refusal =
      `no committed, staged, unstaged or untracked change for slice "${slice}". ` +
      'A slice that changed nothing cannot have been implemented, so there is nothing for a gate to prove.';
  }

  if (refusal === null && omitted.length) {
    const detail = omitted
      .map((s) => `  - ${s}: ${(inference.evidence[s] ?? []).slice(0, 5).join(', ')}${(inference.evidence[s] ?? []).length > 5 ? ', ...' : ''}`)
      .join('\n');
    refusal =
      `the change touches ${omitted.length} surface(s) the packet for slice "${slice}" does not declare:\n${detail}\n` +
      `  declared: ${declared?.length ? declared.join(', ') : '(none)'}\n` +
      'Add the missing surface(s) to affected_surfaces, or take those files out of the slice. ' +
      'An undeclared surface is a gate this slice was never going to run.';
  }

  if (refusal === null) {
    const available = readScriptNames(root);
    const absent = available ? scripts.filter((script) => !available.has(script)) : [];
    if (absent.length) {
      refusal =
        `package.json does not define ${absent.map((s) => `"${s}"`).join(', ')}, ` +
        'named by the packet\'s required_gates. A gate that cannot be run is not a gate.';
    }
  }

  if (inference.unmapped.length) {
    notes.push(
      `${inference.unmapped.length} changed file(s) match no rule in ${path.join('.discipline', 'gates.json')}, ` +
        `so the full "${gates.unmapped}" runs: ${inference.unmapped.slice(0, 8).join(', ')}${inference.unmapped.length > 8 ? ', ...' : ''}`,
    );
  }
  if (!slice) {
    notes.push('No --slice given: the gates come from the changed files alone, with no packet declaration to check them against.');
  }

  return {
    base: changed.base,
    slice,
    files: changed.files,
    surfaces: { inferred, declared, used, omitted, extra },
    unmappedFiles: inference.unmapped,
    excludedFiles: inference.excluded,
    evidence: inference.evidence,
    scripts: refusal === null ? scripts : [],
    refusal,
    notes,
  };
}

/** Run the planned scripts sequentially and build the v2 report. A refusal runs nothing. */
export function runChangedGate(root: string, options: ChangedGateOptions, ops: GateExecOps = DEFAULT_EXEC): GateReportV2 {
  const plan = planChangedGate(root, options);
  const steps: GateStepResult[] = [];
  let totalMs = 0;
  let firstFailingStep: string | null = null;
  let firstFailingError: string | null = null;

  if (plan.refusal === null) {
    for (const script of plan.scripts) {
      const cmd = `npm run ${script}`;
      const started = Date.now();
      const proc = ops.run(root, script);
      const ms = Date.now() - started;
      totalMs += ms;
      const stepError = firstErrorLine(proc.stdout, proc.stderr);
      steps.push({ cmd, exit: proc.status, ms, firstError: proc.status === 0 ? null : stepError });
      if (proc.status !== 0 && firstFailingStep === null) {
        firstFailingStep = cmd;
        firstFailingError = stepError ?? `exit ${proc.status}`;
      }
    }
  }

  const failedChecks = steps.filter((s) => s.exit !== 0).map((s) => s.cmd);
  // A refusal is a failure with a name: it keeps its own signature so the Repair
  // Budget counts "the same undeclared surface, twice" as the repeat it is.
  const passed = plan.refusal === null && failedChecks.length === 0;

  return {
    schema: GATE_REPORT_SCHEMA_V2,
    ts: new Date().toISOString(),
    mode: 'changed',
    passed,
    duration_ms: totalMs,
    base: plan.base,
    slice: plan.slice,
    files: plan.files,
    surfaces: plan.surfaces,
    unmapped_files: plan.unmappedFiles,
    excluded_files: plan.excludedFiles,
    steps,
    failed_checks: plan.refusal === null ? failedChecks : ['gate --changed (refused before running anything)'],
    error_signature:
      plan.refusal !== null
        ? errorSignature('gate --changed', plan.refusal)
        : passed || firstFailingStep === null
          ? null
          : errorSignature(firstFailingStep, firstFailingError ?? ''),
    refusal: plan.refusal,
    notes: plan.notes,
  };
}

export function writeGateReportV2(root: string, report: GateReportV2): string {
  const outPath = path.join(root, GATE_REPORT_FILE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return outPath;
}

/** Print the report the way the operator reads it: what was chosen, then what happened. */
export function printChangedGate(report: GateReportV2): void {
  const surfaces = report.surfaces;
  disciplineInfo(`Changed files: ${report.files.length}${report.base ? ` (base ${report.base})` : ''}`);
  disciplineInfo(`  inferred surfaces: ${surfaces.inferred.length ? surfaces.inferred.join(', ') : '(none)'}`);
  if (surfaces.declared !== null) {
    disciplineInfo(`  declared surfaces: ${surfaces.declared.length ? surfaces.declared.join(', ') : '(none)'}`);
    if (surfaces.extra.length) disciplineInfo(`  declared but not touched (running anyway): ${surfaces.extra.join(', ')}`);
  }
  for (const note of report.notes) disciplineWarn(note);

  if (report.refusal !== null) {
    disciplineWarn(`gate --changed REFUSED: ${report.refusal}`);
    disciplineInfo(`Nothing was run. Report: ${GATE_REPORT_FILE}`);
    return;
  }

  for (const step of report.steps) {
    const mark = step.exit === 0 ? 'ok' : `FAIL (exit ${step.exit})`;
    disciplineInfo(`  [${mark}] ${step.cmd} (${step.ms} ms)`);
    if (step.firstError) disciplineInfo(`      ${step.firstError}`);
  }
  disciplineInfo(
    `Gate (changed) ${report.passed ? 'PASSED' : 'FAILED'} in ${report.duration_ms} ms over ${report.steps.length} step(s). ` +
      `Report: ${GATE_REPORT_FILE}`,
  );
  if (report.error_signature) disciplineInfo(`Error signature: ${report.error_signature}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2), { string: ['base', 'slice', 'project-dir'] });
  const projectRoot = resolveProjectRoot(args['project-dir']);

  let report: GateReportV2;
  try {
    report = runChangedGate(projectRoot, { base: args.base ?? null, slice: args.slice ?? null });
  } catch (err) {
    // A config or git problem is not a gate result: nothing was measured, so
    // nothing is written. Writing a failing report here would let the next
    // reader believe the gate ran and failed.
    if (err instanceof GateConfigError || err instanceof ChangedFilesError) {
      disciplineWarn(`gate --changed cannot run: ${err.message}`);
      process.exit(GATE_CHANGED_EXIT.REFUSED);
    }
    throw err;
  }

  writeGateReportV2(projectRoot, report);
  try {
    appendLedger(projectRoot, {
      event: 'gate_result',
      mode: 'changed',
      passed: report.passed,
      failed_checks: report.failed_checks,
      duration_ms: report.duration_ms,
      error_signature: report.error_signature,
      surfaces: report.surfaces.used,
    });
  } catch {
    // Ledger is best-effort observability; never fail the gate because of it.
  }

  printChangedGate(report);
  process.exit(report.passed ? GATE_CHANGED_EXIT.GREEN : report.refusal !== null ? GATE_CHANGED_EXIT.REFUSED : GATE_CHANGED_EXIT.FAILED);
}
