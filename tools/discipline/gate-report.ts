import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { appendLedger, errorSignature } from './lib/ledger.js';

/**
 * Machine-readable gate runner. The gate itself stays the single source of
 * truth: this parses the repo's own package.json "gate" script, splits it into
 * its ` && ` steps, and runs each step sequentially from the repo root,
 * capturing exit code, duration, and the first error-looking output line.
 *
 * It writes `.discipline/gate-report.json` (schema discipline.gate_report.v1)
 * and appends a `gate_result` ledger event. The process exit code is 0 iff all
 * steps passed, so hooks / CI / a future reconciler can gate on it without
 * parsing human text.
 *
 * This does NOT change what the gate runs or its LLM-free nature; it re-runs the
 * same commands the gate already runs.
 */

export const GATE_REPORT_SCHEMA = 'discipline.gate_report.v1';

export interface GateStepResult {
  cmd: string;
  exit: number;
  ms: number;
  firstError: string | null;
}

export interface GateReport {
  schema: string;
  ts: string;
  passed: boolean;
  duration_ms: number;
  steps: GateStepResult[];
  failed_checks: string[];
  error_signature: string | null;
}

/**
 * Split a package.json "gate" script string into its sequential steps.
 * Steps are joined by ` && `; we keep them verbatim (each is later run with a
 * shell). Returns [] for an empty/whitespace string.
 */
export function parseGateSteps(gateScript: string): string[] {
  if (!gateScript || !gateScript.trim()) return [];
  return gateScript
    .split(' && ')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

/**
 * Read the "gate" script from a package.json at root and parse its steps.
 * If parsing yields fewer than 2 steps, fall back to running the whole gate as
 * one step (`npm run gate`) so we never silently under-run the gate.
 */
export function resolveGateSteps(root: string): string[] {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
  const gateScript = pkg.scripts?.gate ?? '';
  const steps = parseGateSteps(gateScript);
  if (steps.length < 2) return ['npm run gate'];
  return steps;
}

/** Pick the first output line that looks like an error/failure, if any. */
function firstErrorLine(stdout: string, stderr: string): string | null {
  const haystack = `${stderr}\n${stdout}`;
  const lines = haystack.split(/\r?\n/);
  const errorish = /error|fail(ed|ure)?|not found|cannot|exception|✖|×/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (line && errorish.test(line)) return line;
  }
  // No explicit error marker: fall back to the first non-empty stderr line.
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return null;
}

export function runGateReport(root: string): GateReport {
  const steps = resolveGateSteps(root);
  const results: GateStepResult[] = [];
  let totalMs = 0;
  let firstFailingStep: string | null = null;
  let firstFailingError: string | null = null;

  for (const cmd of steps) {
    const started = Date.now();
    const proc = spawnSync(cmd, { cwd: root, shell: true, stdio: 'pipe', encoding: 'utf-8' });
    const ms = Date.now() - started;
    totalMs += ms;
    const exit = proc.status ?? 1;
    const stepError = firstErrorLine(proc.stdout ?? '', proc.stderr ?? '');
    results.push({ cmd, exit, ms, firstError: exit === 0 ? null : stepError });

    if (exit !== 0 && firstFailingStep === null) {
      firstFailingStep = cmd;
      firstFailingError = stepError ?? `exit ${exit}`;
    }
  }

  const failedChecks = results.filter((r) => r.exit !== 0).map((r) => r.cmd);
  const passed = failedChecks.length === 0;

  return {
    schema: GATE_REPORT_SCHEMA,
    ts: new Date().toISOString(),
    passed,
    duration_ms: totalMs,
    steps: results,
    failed_checks: failedChecks,
    error_signature:
      passed || firstFailingStep === null
        ? null
        : errorSignature(firstFailingStep, firstFailingError ?? ''),
  };
}

export function writeGateReport(root: string, report: GateReport): string {
  const outPath = path.join(root, '.discipline', 'gate-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return outPath;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args['project-dir']);

  disciplineInfo('Running gate steps (this re-runs the gate once)...');
  const report = runGateReport(projectRoot);
  const outPath = writeGateReport(projectRoot, report);

  try {
    appendLedger(projectRoot, {
      event: 'gate_result',
      passed: report.passed,
      failed_checks: report.failed_checks,
      duration_ms: report.duration_ms,
      error_signature: report.error_signature,
    });
  } catch {
    // Ledger is best-effort observability; never fail the gate report because of it.
  }

  for (const step of report.steps) {
    const mark = step.exit === 0 ? 'ok' : `FAIL (exit ${step.exit})`;
    disciplineInfo(`  [${mark}] ${step.cmd} (${step.ms} ms)`);
    if (step.firstError) disciplineInfo(`      ${step.firstError}`);
  }
  disciplineInfo(`Gate ${report.passed ? 'PASSED' : 'FAILED'} in ${report.duration_ms} ms. Report: ${path.relative(projectRoot, outPath)}`);
  if (report.error_signature) disciplineInfo(`Error signature: ${report.error_signature}`);

  process.exit(report.passed ? 0 : 1);
}
