import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * One reader for `.discipline/gate-report.json`, whichever schema wrote it.
 *
 * Two schemas share that path: `v1` (the whole `gate` script, step by step) and
 * `v2` (the subset `gate --changed` selected, plus the files and surfaces it
 * selected it from). Every consumer -- the Stop hook, checkpoints, the runner --
 * asks the same question of both: did it pass, what failed, and how fresh is it.
 *
 * A schema this file does not know is NOT read as green. Trusting an unknown
 * report would mean validating tomorrow's format against today's assumptions,
 * which is how a report that means something else passes for a pass.
 */

export const GATE_REPORT_SCHEMA_V1 = 'discipline.gate_report.v1';
export const GATE_REPORT_SCHEMA_V2 = 'discipline.gate_report.v2';
export const KNOWN_GATE_REPORT_SCHEMAS = [GATE_REPORT_SCHEMA_V1, GATE_REPORT_SCHEMA_V2] as const;

export const GATE_REPORT_FILE = path.join('.discipline', 'gate-report.json');

/** The fields every schema carries, plus what v2 adds. */
export interface GateReportSummary {
  schema: string;
  passed: boolean;
  failed_checks: string[];
  ts: string | null;
  mtimeMs: number;
  /** v2 only: how the step list was chosen. */
  mode: string | null;
  /** v2 only: the changed files the run was scoped to. */
  files: string[] | null;
  /** v2 only: the surfaces those files (and the packet) implied. */
  surfaces: string[] | null;
}

export type GateReportRead =
  | { ok: true; report: GateReportSummary }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown-schema'; detail: string };

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Read + classify a gate report. Never throws: every failure is a reason a caller can print. */
export function readGateReportFile(root: string): GateReportRead {
  const file = path.join(root, GATE_REPORT_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'missing', detail: `${GATE_REPORT_FILE} does not exist.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: `${GATE_REPORT_FILE} is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: `${GATE_REPORT_FILE} is not a JSON object.` };
  }
  const obj = parsed as Record<string, unknown>;
  const schema = typeof obj.schema === 'string' ? obj.schema : '';
  if (!(KNOWN_GATE_REPORT_SCHEMAS as readonly string[]).includes(schema)) {
    return {
      ok: false,
      reason: 'unknown-schema',
      detail:
        `${GATE_REPORT_FILE} declares schema ${JSON.stringify(obj.schema ?? null)}; ` +
        `this tooling reads ${KNOWN_GATE_REPORT_SCHEMAS.join(' and ')}. Re-run the gate with this version.`,
    };
  }
  return {
    ok: true,
    report: {
      schema,
      passed: obj.passed === true,
      failed_checks: stringArray(obj.failed_checks),
      ts: typeof obj.ts === 'string' ? obj.ts : null,
      mtimeMs: stat.mtimeMs,
      mode: typeof obj.mode === 'string' ? obj.mode : null,
      files: schema === GATE_REPORT_SCHEMA_V2 ? stringArray(obj.files) : null,
      surfaces: schema === GATE_REPORT_SCHEMA_V2 ? stringArray((obj.surfaces as Record<string, unknown>)?.used) : null,
    },
  };
}
