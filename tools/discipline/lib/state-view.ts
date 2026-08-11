import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectDisciplineDocuments, type DocumentHealth } from './document-health.js';
import { readGateReportFile } from './gate-report-io.js';
import { readMetricRecords, type SliceMetricRecord } from './metrics.js';
import {
  activeSlicePackets,
  findSliceHeadings,
  isSliceConsumed,
  normalizeSliceId,
  parseReadySlicesTable,
  resolveSlice,
  sectionStatusOf,
  type ActiveSlicePacket,
} from './slice-identity.js';
import { declaredSurfaces, readStep5Packet } from './step5-schema.js';

export const STATE_VIEW_SCHEMA = 'discipline.state_view.v1';
export const STATE_VIEW_FILE = path.join('.discipline', 'views', 'current-state.md');

export type SliceViewStatus = 'ready' | 'in-progress' | 'consumed' | 'blocked' | 'planned' | 'unknown';

export interface SliceStateView {
  id: string;
  title: string | null;
  status: SliceViewStatus;
  plan_status: string | null;
  packet: {
    file: string;
    status: string | null;
    affected_surfaces: string[];
    required_gates: string[];
  } | null;
  latest_metric: {
    recorded_at: string;
    changed_lines: number;
    max_changed_lines: number;
    split_decision: string | null;
    signature: string;
  } | null;
}

export interface DisciplineStateView {
  schema: typeof STATE_VIEW_SCHEMA;
  slices: SliceStateView[];
  blockers: string[];
  gate: {
    schema: string | null;
    passed: boolean | null;
    timestamp: string | null;
    mode: string | null;
    failed_checks: string[];
    surfaces: string[] | null;
  };
  documents: DocumentHealth[];
}

function normalizedStatus(raw: string | null): SliceViewStatus {
  const value = (raw ?? '').trim().toLowerCase().replace(/[_ ]+/g, '-');
  if (value === 'ready') return 'ready';
  if (['in-progress', 'active', 'implementing'].includes(value)) return 'in-progress';
  if (['consumed', 'done', 'shipped', 'complete', 'completed'].includes(value)) return 'consumed';
  if (['blocked', 'parked'].includes(value)) return 'blocked';
  if (['planned', 'draft', 'pending'].includes(value)) return 'planned';
  return 'unknown';
}

function progressBlockers(root: string): string[] {
  const file = path.join(root, 'progress.md');
  if (!fs.existsSync(file)) return ['progress.md is missing.'];
  const content = fs.readFileSync(file, 'utf-8');
  const match = content.match(/^\s*-\s*Blockers:\s*(.*?)\s*$/im);
  if (!match) return ['progress.md does not declare Blockers in Current Status.'];
  const value = match[1].trim();
  return /^(none|n\/a|na|-|\(none\))$/i.test(value) ? [] : [value];
}

function latestMetricBySlice(records: SliceMetricRecord[]): Map<string, SliceMetricRecord> {
  const result = new Map<string, SliceMetricRecord>();
  for (const record of records) result.set(normalizeSliceId(record.slice), record);
  return result;
}

function packetBySlice(packets: ActiveSlicePacket[], blockers: string[]): Map<string, ActiveSlicePacket> {
  const result = new Map<string, ActiveSlicePacket>();
  for (const packet of packets) {
    if (packet.identityError) {
      blockers.push(`${packet.fileName}: ${packet.identityError}`);
      continue;
    }
    if (!packet.sliceId) {
      blockers.push(`${packet.fileName} does not identify a slice.`);
      continue;
    }
    if (result.has(packet.sliceId)) {
      blockers.push(`Slice ${packet.sliceId} has more than one active Step 5 packet.`);
      continue;
    }
    result.set(packet.sliceId, packet);
  }
  return result;
}

function packetDetails(root: string, packet: ActiveSlicePacket, blockers: string[]): SliceStateView['packet'] {
  const content = fs.readFileSync(packet.path, 'utf-8');
  const declaration = declaredSurfaces(content);
  const reading = readStep5Packet(content, packet.fileName);
  for (const finding of reading.findings.filter((item) => item.severity === 'error')) blockers.push(finding.message);
  if (declaration.invalid.length) blockers.push(`${packet.fileName} declares invalid surfaces: ${declaration.invalid.join(', ')}.`);
  return {
    file: path.relative(root, packet.path).replace(/\\/g, '/'),
    status: packet.status,
    affected_surfaces: declaration.surfaces ?? [],
    required_gates: declaration.requiredGates,
  };
}

function metricSummary(record: SliceMetricRecord | undefined): SliceStateView['latest_metric'] {
  if (!record) return null;
  return {
    recorded_at: record.recorded_at,
    changed_lines: record.actual.changed_lines,
    max_changed_lines: record.estimate.max_changed_lines,
    split_decision: record.estimate.split_decision,
    signature: record.signature,
  };
}

export function buildStateView(root: string): DisciplineStateView {
  const blockers = progressBlockers(root);
  const planPath = path.join(root, 'task_plan.md');
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf-8') : '';
  const headings = findSliceHeadings(plan);
  const tableRows = parseReadySlicesTable(plan);
  const packets = packetBySlice(activeSlicePackets(root), blockers);
  let metrics: SliceMetricRecord[] = [];
  try { metrics = readMetricRecords(root); } catch (err) { blockers.push((err as Error).message); }
  const latestMetrics = latestMetricBySlice(metrics);
  const ids = new Set<string>([
    ...headings.map((heading) => heading.id),
    ...tableRows.map((row) => row.id),
    ...packets.keys(),
    ...latestMetrics.keys(),
  ]);

  for (const id of ids) {
    const resolution = resolveSlice(plan, id);
    if (!resolution.ok && resolution.reason !== 'not-found') blockers.push(resolution.message);
  }

  const slices: SliceStateView[] = [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((id) => {
    const heading = headings.find((item) => item.id === id);
    const table = tableRows.find((item) => item.id === id);
    const planStatus = heading ? sectionStatusOf(plan, heading) ?? table?.status ?? null : table?.status ?? null;
    const packet = packets.get(id);
    const packetView = packet ? packetDetails(root, packet, blockers) : null;
    const consumed = packet?.status === 'consumed' || isSliceConsumed(root, id).consumed;
    let status = consumed ? 'consumed' as const : normalizedStatus(planStatus ?? packet?.status ?? null);
    if (status === 'unknown' && packet?.status === 'ready') status = 'ready';
    return {
      id,
      title: heading?.title || null,
      status,
      plan_status: planStatus,
      packet: packetView,
      latest_metric: metricSummary(latestMetrics.get(id)),
    };
  });

  const gateRead = readGateReportFile(root);
  if (!gateRead.ok) blockers.push(gateRead.detail.replace(/\\/g, '/'));
  else if (!gateRead.report.passed) blockers.push(`Latest gate failed: ${gateRead.report.failed_checks.join(', ') || 'unknown check'}.`);
  for (const slice of slices) {
    if (slice.latest_metric?.split_decision === 'split') blockers.push(`Slice ${slice.id} declares SPLIT_DECISION: split.`);
  }

  const gate = gateRead.ok ? {
    schema: gateRead.report.schema,
    passed: gateRead.report.passed,
    timestamp: gateRead.report.ts,
    mode: gateRead.report.mode,
    failed_checks: gateRead.report.failed_checks,
    surfaces: gateRead.report.surfaces,
  } : { schema: null, passed: null, timestamp: null, mode: null, failed_checks: [], surfaces: null };

  return {
    schema: STATE_VIEW_SCHEMA,
    slices,
    blockers: [...new Set(blockers)].sort((a, b) => a.localeCompare(b)),
    gate,
    documents: inspectDisciplineDocuments(root),
  };
}

function cell(value: string | null | undefined): string {
  return (value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderSliceTable(slices: SliceStateView[]): string[] {
  if (slices.length === 0) return ['- None'];
  return [
    '| Slice | Title | Plan status | Packet | Surfaces | Required gates | Latest metric |',
    '|---|---|---|---|---|---|---|',
    ...slices.map((slice) => {
      const metric = slice.latest_metric
        ? `${slice.latest_metric.changed_lines}/${slice.latest_metric.max_changed_lines} lines @ ${slice.latest_metric.recorded_at}; split=${slice.latest_metric.split_decision ?? 'none'}; sig=${slice.latest_metric.signature}`
        : '—';
      const packet = slice.packet ? `${slice.packet.file} (${slice.packet.status ?? 'no status'})` : '—';
      return `| ${cell(slice.id)} | ${cell(slice.title)} | ${cell(slice.plan_status)} | ${cell(packet)} | ${cell(slice.packet?.affected_surfaces.join(', '))} | ${cell(slice.packet?.required_gates.join(', '))} | ${metric} |`;
    }),
  ];
}

export function renderStateView(state: DisciplineStateView): string {
  const lines = [
    '# Current Discipline State',
    '',
    '> Derived view. Regenerate with `discipline state-view`; packets and Markdown state remain canonical.',
    `> Schema: ${state.schema}`,
    '',
  ];
  for (const [title, status] of [['Ready', 'ready'], ['In progress', 'in-progress'], ['Consumed', 'consumed']] as const) {
    lines.push(`## ${title}`, '', ...renderSliceTable(state.slices.filter((slice) => slice.status === status)), '');
  }
  const other = state.slices.filter((slice) => !['ready', 'in-progress', 'consumed'].includes(slice.status));
  lines.push('## Other slices', '', ...renderSliceTable(other), '', '## Blockers', '');
  lines.push(...(state.blockers.length ? state.blockers.map((blocker) => `- ${blocker}`) : ['- None']), '');
  lines.push(
    '## Latest gate', '',
    `- Schema: ${state.gate.schema ?? 'none'}`,
    `- Passed: ${state.gate.passed === null ? 'unknown' : state.gate.passed ? 'yes' : 'no'}`,
    `- Timestamp: ${state.gate.timestamp ?? 'none'}`,
    `- Mode: ${state.gate.mode ?? 'full or unknown'}`,
    `- Surfaces: ${state.gate.surfaces?.join(', ') || 'none recorded'}`,
    `- Failed checks: ${state.gate.failed_checks.join(', ') || 'none'}`,
    '',
    '## Document sizes', '',
    '| File | Exists | Bytes | Lines | Warning |',
    '|---|---|---:|---:|---|',
    ...state.documents.map((doc) => `| ${doc.file} | ${doc.exists ? 'yes' : 'no'} | ${doc.bytes} | ${doc.lines} | ${doc.warning ?? 'none'} |`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function writeStateView(root: string, state = buildStateView(root)): string {
  const output = path.join(root, STATE_VIEW_FILE);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderStateView(state), 'utf-8');
  return output;
}
