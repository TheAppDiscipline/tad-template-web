import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withWriterLock } from './locks.js';
import { locateSlicePacket, normalizeSliceId } from './slice-identity.js';
import {
  declaredSurfaces, evaluateAsV2, isEvasiveDeclaration, plainDeclaration, readStep5Packet,
  sectionLines,
} from './step5-schema.js';

export const METRICS_SCHEMA = 'discipline.slice_metric.v1';
export const METRICS_FILE = path.join('.discipline', 'metrics', 'slices.jsonl');
export const METRIC_CATEGORIES = ['production', 'tests', 'fixtures-config', 'documentation'] as const;

export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

export interface LineTotals {
  files: number;
  additions: number;
  deletions: number;
  changed_lines: number;
  binary_files: number;
}

export interface EstimateContract {
  raw: string;
  max_changed_lines: number;
  basis: string;
  split_decision: 'split' | 'exception-approved' | null;
  duplicate_metrics: 'allowed' | null;
}

export interface SliceMetricRecord {
  schema: typeof METRICS_SCHEMA;
  recorded_at: string;
  slice: string;
  base: { requested: string; resolved: string };
  packet: { file: string; sha256: string };
  affected_surfaces: string[];
  estimate: EstimateContract;
  actual: LineTotals & {
    paths: string[];
    categories: Record<MetricCategory, LineTotals>;
  };
  signature: string;
}

interface NumstatEntry {
  file: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

function declarationValues(lines: string[], key: string): string[] {
  const matcher = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, 'i');
  const values: string[] = [];
  for (const raw of lines) {
    const match = plainDeclaration(raw).match(matcher);
    if (match) values.push(match[1].trim());
  }
  return values;
}

export function readEstimateContract(packet: string): EstimateContract {
  const lines = sectionLines(packet, 'Estimate');
  if (!lines) throw new Error('STEP_5_SLICE_PACKET has no Estimate section.');
  const raw = lines.join('\n').trim();
  const maximums = declarationValues(lines, 'MAX_CHANGED_LINES');
  const maxRaw = maximums[0];
  if (maximums.length !== 1 || !maxRaw || !/^\d+$/.test(maxRaw) || Number(maxRaw) <= 0) {
    throw new Error('Estimate must declare exactly one MAX_CHANGED_LINES: <positive integer> so measured scope has a falsifiable maximum.');
  }
  const bases = declarationValues(lines, 'BASIS');
  const basis = bases[0];
  if (bases.length !== 1 || !basis || isEvasiveDeclaration(basis)) {
    throw new Error('Estimate must declare exactly one substantive BASIS with comparable surfaces, or a concrete rationale when no comparable history exists.');
  }
  const splitValues = declarationValues(lines, 'SPLIT_DECISION');
  const splitRaw = splitValues[0];
  if (splitValues.length > 1) throw new Error('Estimate must not declare SPLIT_DECISION more than once.');
  if (splitRaw && splitRaw !== 'split' && splitRaw !== 'exception-approved') {
    throw new Error('SPLIT_DECISION must be split or exception-approved.');
  }
  const duplicateValues = declarationValues(lines, 'DUPLICATE_METRICS');
  const duplicateRaw = duplicateValues[0];
  if (duplicateValues.length > 1) throw new Error('Estimate must not declare DUPLICATE_METRICS more than once.');
  if (duplicateRaw && duplicateRaw !== 'allowed') {
    throw new Error('DUPLICATE_METRICS, when present, must be allowed.');
  }
  return {
    raw,
    max_changed_lines: Number(maxRaw),
    basis,
    split_decision: (splitRaw as EstimateContract['split_decision']) ?? null,
    duplicate_metrics: duplicateRaw === 'allowed' ? 'allowed' : null,
  };
}

function git(root: string, args: string[]): string {
  const safe = path.resolve(root).replace(/\\/g, '/');
  const result = spawnSync('git', ['-c', `safe.directory=${safe}`, ...args], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const first = record.indexOf('\t');
    const second = first === -1 ? -1 : record.indexOf('\t', first + 1);
    if (first === -1 || second === -1) throw new Error(`Could not parse git diff --numstat record: ${JSON.stringify(record)}`);
    const addRaw = record.slice(0, first);
    const delRaw = record.slice(first + 1, second);
    const file = record.slice(second + 1).replace(/\\/g, '/');
    const binary = addRaw === '-' || delRaw === '-';
    entries.push({
      file,
      additions: binary ? 0 : Number(addRaw),
      deletions: binary ? 0 : Number(delRaw),
      binary,
    });
  }
  return entries;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

function untrackedEntries(root: string): NumstatEntry[] {
  const raw = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return raw.split('\0').filter(Boolean).map((file) => {
    const normalized = file.replace(/\\/g, '/');
    const bytes = fs.readFileSync(path.join(root, file));
    const binary = isBinary(bytes);
    const text = binary ? '' : bytes.toString('utf-8');
    const additions = binary || text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
    return { file: normalized, additions, deletions: 0, binary };
  });
}

export function classifyMetricPath(file: string): MetricCategory {
  const value = file.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(value);
  // A fixture remains a fixture even when it lives below tests/. Classifying the parent first
  // made tests/fixtures/data.json look like executable test coverage.
  if (/(^|\/)(fixtures?|mocks?|test-data)(\/|$)/.test(value)
    || /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.(toml|lock)|tsconfig[^/]*\.json|eslint[^/]*|prettier[^/]*|babel\.config[^/]*|metro\.config[^/]*|vite\.config[^/]*|vitest\.config[^/]*|jest\.config[^/]*|playwright[^/]*\.config[^/]*|tailwind\.config[^/]*|postcss\.config[^/]*|wxt\.config[^/]*|webpack\.config[^/]*)$/.test(value)
    || /(^|\/)(app|eas|firebase|vercel|netlify)\.json$/.test(value)
    || /(^|\/)app\.config\.[^/]+$/.test(value)
    || /(^|\/)src-tauri\/tauri\.conf\.json$/.test(value)
    || /(^|\/)(public\/)?manifest\.json$/.test(value)
    || /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(value)
    || /(^|\/)\.env(?:\.[^/]+)?\.example$/.test(value)
    || /(^|\/)dockerfile(?:\.[^/]+)?$/.test(value)
    || /(^|\/)\.discipline\/gates\.json$/.test(value)) return 'fixtures-config';
  if (/(^|\/)(tests?|__tests__|specs?|e2e|a11y)(\/|$)/.test(value) || /\.(test|spec)\.[^.]+$/.test(base)) return 'tests';
  if (/\.(md|mdx|rst|adoc|txt)$/.test(base) || /(^|\/)(docs?|documentation)(\/|$)/.test(value)) return 'documentation';
  return 'production';
}

function emptyTotals(): LineTotals {
  return { files: 0, additions: 0, deletions: 0, changed_lines: 0, binary_files: 0 };
}

function addEntry(total: LineTotals, entry: NumstatEntry): void {
  total.files++;
  total.additions += entry.additions;
  total.deletions += entry.deletions;
  total.changed_lines += entry.additions + entry.deletions;
  if (entry.binary) total.binary_files++;
}

export function collectLineMetrics(root: string, base: string): {
  resolvedBase: string;
  totals: SliceMetricRecord['actual'];
} {
  const resolvedBase = git(root, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const tracked = parseNumstat(git(root, ['diff', '--numstat', '--no-renames', '-z', resolvedBase, '--']));
  // The measurement record is evidence about the slice, not part of the slice. Without this
  // exclusion an explicitly approved second measurement counts the first JSONL record as new
  // production code and grows merely because it was measured.
  const generated = new Set([METRICS_FILE.replace(/\\/g, '/'), '.discipline/views/current-state.md']);
  const entries = [...tracked, ...untrackedEntries(root)]
    .filter((entry) => !generated.has(entry.file))
    .sort((a, b) => a.file.localeCompare(b.file));
  const categories = Object.fromEntries(METRIC_CATEGORIES.map((category) => [category, emptyTotals()])) as Record<MetricCategory, LineTotals>;
  const total = emptyTotals();
  for (const entry of entries) {
    addEntry(total, entry);
    addEntry(categories[classifyMetricPath(entry.file)], entry);
  }
  return { resolvedBase, totals: { ...total, paths: entries.map((entry) => entry.file), categories } };
}

export function readMetricRecords(root: string): SliceMetricRecord[] {
  const file = path.join(root, METRICS_FILE);
  if (!fs.existsSync(file)) return [];
  const records: SliceMetricRecord[] = [];
  for (const [index, line] of fs.readFileSync(file, 'utf-8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (err) {
      throw new Error(`${METRICS_FILE}:${index + 1} is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).schema !== METRICS_SCHEMA) {
      throw new Error(`${METRICS_FILE}:${index + 1} is not a ${METRICS_SCHEMA} record.`);
    }
    const candidate = parsed as Record<string, unknown>;
    const actual = candidate.actual as Record<string, unknown> | undefined;
    const estimate = candidate.estimate as Record<string, unknown> | undefined;
    if (typeof candidate.slice !== 'string'
      || !actual || typeof actual.changed_lines !== 'number'
      || !estimate || typeof estimate.max_changed_lines !== 'number'
      || typeof estimate.basis !== 'string' || isEvasiveDeclaration(estimate.basis)
      || !Array.isArray(candidate.affected_surfaces)
      || candidate.affected_surfaces.some((surface) => typeof surface !== 'string')
      || typeof candidate.signature !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.signature)) {
      throw new Error(`${METRICS_FILE}:${index + 1} is missing slice, substantive estimate BASIS, surfaces, actual, or signature fields.`);
    }
    const { signature, ...unsigned } = parsed as SliceMetricRecord;
    const expected = recordSignature(unsigned);
    if (signature !== expected) {
      throw new Error(`${METRICS_FILE}:${index + 1} signature mismatch (expected ${expected}, found ${signature}).`);
    }
    records.push(parsed as SliceMetricRecord);
  }
  return records;
}

export function recordSignature(record: Omit<SliceMetricRecord, 'signature'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function atomicWriteMetricRecords(output: string, records: SliceMetricRecord[]): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  const payload = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const fd = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(fd, payload, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, output);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the original error */ }
    throw err;
  }
}

export async function recordSliceMetrics(
  root: string,
  slice: string,
  base: string,
  recordedAt = new Date().toISOString(),
): Promise<SliceMetricRecord> {
  return await withWriterLock(root, { tool: 'discipline:metrics' }, () => recordSliceMetricsLocked(root, slice, base, recordedAt));
}

function recordSliceMetricsLocked(root: string, slice: string, base: string, recordedAt: string): SliceMetricRecord {
  const normalizedSlice = normalizeSliceId(slice);
  if (!normalizedSlice) throw new Error('--slice must identify one slice.');
  const taskPlanPath = path.join(root, 'task_plan.md');
  const taskPlan = fs.existsSync(taskPlanPath) ? fs.readFileSync(taskPlanPath, 'utf-8') : undefined;
  const located = locateSlicePacket(root, normalizedSlice, taskPlan);
  if (!located.ok) throw new Error(located.message);
  const packet = fs.readFileSync(located.path, 'utf-8');
  const reading = readStep5Packet(packet, located.path);
  if (reading.format === 'unsupported') {
    throw new Error(reading.findings.map((finding) => finding.message).join('; '));
  }
  const declaration = declaredSurfaces(packet);
  if (reading.format === 'v2') {
    const invalid = evaluateAsV2(packet, located.path);
    if (invalid.length > 0) {
      throw new Error(`Cannot record metrics for an invalid v2 packet: ${invalid.map((finding) => finding.message).join('; ')}`);
    }
    if (!declaration.surfaces || declaration.surfaces.length === 0 || declaration.invalid.length > 0) {
      throw new Error('Cannot record metrics for a v2 packet without valid affected_surfaces.');
    }
  }
  const estimate = readEstimateContract(packet);
  const records = readMetricRecords(root);
  const prior = records.filter((record) => normalizeSliceId(record.slice) === normalizedSlice);
  if (prior.length > 0 && estimate.duplicate_metrics !== 'allowed') {
    throw new Error(`Metrics already contain ${prior.length} record(s) for slice ${normalizedSlice}. Declare DUPLICATE_METRICS: allowed in Estimate before appending another measurement.`);
  }
  const { resolvedBase, totals } = collectLineMetrics(root, base);
  if (totals.changed_lines > estimate.max_changed_lines && estimate.split_decision === null) {
    throw new Error(
      `Slice ${normalizedSlice} changed ${totals.changed_lines} lines, above MAX_CHANGED_LINES ${estimate.max_changed_lines}. `
      + 'Declare SPLIT_DECISION: split or SPLIT_DECISION: exception-approved in Estimate.',
    );
  }
  const surfaces = declaration.surfaces ?? [];
  const unsigned: Omit<SliceMetricRecord, 'signature'> = {
    schema: METRICS_SCHEMA,
    recorded_at: recordedAt,
    slice: normalizedSlice,
    base: { requested: base, resolved: resolvedBase },
    packet: {
      file: path.relative(root, located.path).replace(/\\/g, '/'),
      sha256: crypto.createHash('sha256').update(packet).digest('hex'),
    },
    affected_surfaces: [...surfaces],
    estimate,
    actual: totals,
  };
  const record: SliceMetricRecord = { ...unsigned, signature: recordSignature(unsigned) };
  const output = path.join(root, METRICS_FILE);
  // The duplicate check and durable write are inside one writer lock. Rewriting the complete
  // append-only log through a same-directory temporary file makes a crash leave either the old
  // valid file or the old records plus this one, never a truncated JSON line.
  atomicWriteMetricRecords(output, [...records, record]);
  return record;
}
