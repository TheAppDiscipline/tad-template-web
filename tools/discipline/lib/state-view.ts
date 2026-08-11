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
import { declaredSurfaces, evaluateAsV2, readStep5Packet } from './step5-schema.js';
import { meaningfulItems, sectionItems } from './completion-packet.js';
import { progressClosureState, progressIntegrityBlockers } from './progress-log.js';

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
    affected_surfaces: string[];
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

function progressContent(root: string): string | null {
  const file = path.join(root, 'progress.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

function progressBlockers(content: string | null): string[] {
  if (content === null) return ['progress.md is missing.'];
  const match = content.match(/^\s*-\s*Blockers:\s*(.*?)\s*$/im);
  if (!match) return ['progress.md does not declare Blockers in Current Status.'];
  const value = match[1].trim();
  if (/^(none|n\/a|na|-|\(none\))$/i.test(value)) return [];
  if (/^(see|refer to)\s+(the\s+)?open errors\.?$/i.test(value)) {
    const openErrors = meaningfulItems(sectionItems(content, 'Open Errors'));
    return openErrors.length ? openErrors : ['progress.md points to Open Errors, but that section has no blocker details.'];
  }
  return [value];
}

function latestMetricBySlice(records: SliceMetricRecord[]): Map<string, SliceMetricRecord> {
  const result = new Map<string, SliceMetricRecord>();
  for (const record of records) result.set(normalizeSliceId(record.slice), record);
  return result;
}

function packetBySlice(packets: ActiveSlicePacket[], blockers: string[]): {
  packets: Map<string, ActiveSlicePacket>;
  duplicates: Set<string>;
} {
  const result = new Map<string, ActiveSlicePacket>();
  const duplicates = new Set<string>();
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
      duplicates.add(packet.sliceId);
      continue;
    }
    result.set(packet.sliceId, packet);
  }
  return { packets: result, duplicates };
}

function packetDetails(root: string, packet: ActiveSlicePacket, blockers: string[]): {
  view: SliceStateView['packet'];
  valid: boolean;
} {
  const content = fs.readFileSync(packet.path, 'utf-8');
  const declaration = declaredSurfaces(content);
  const reading = readStep5Packet(content, packet.fileName);
  const structuralErrors = reading.format === 'v2'
    ? evaluateAsV2(content, packet.fileName)
    : reading.findings.filter((item) => item.severity === 'error');
  for (const finding of structuralErrors) blockers.push(finding.message);
  if (declaration.invalid.length) blockers.push(`${packet.fileName} declares invalid surfaces: ${declaration.invalid.join(', ')}.`);
  return {
    view: {
      file: path.relative(root, packet.path).replace(/\\/g, '/'),
      status: packet.status,
      affected_surfaces: declaration.surfaces ?? [],
      required_gates: declaration.requiredGates,
    },
    valid: structuralErrors.length === 0 && declaration.invalid.length === 0,
  };
}

function metricSummary(record: SliceMetricRecord | undefined): SliceStateView['latest_metric'] {
  if (!record) return null;
  return {
    recorded_at: record.recorded_at,
    affected_surfaces: [...record.affected_surfaces],
    changed_lines: record.actual.changed_lines,
    max_changed_lines: record.estimate.max_changed_lines,
    split_decision: record.estimate.split_decision,
    signature: record.signature,
  };
}

export function buildStateView(root: string): DisciplineStateView {
  const progress = progressContent(root);
  const blockers = [...progressBlockers(progress), ...progressIntegrityBlockers(progress)];
  const planPath = path.join(root, 'task_plan.md');
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf-8') : '';
  const headings = findSliceHeadings(plan);
  const tableRows = parseReadySlicesTable(plan);
  const inventory = packetBySlice(activeSlicePackets(root), blockers);
  const packets = inventory.packets;
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
    const packetHealth = packet ? packetDetails(root, packet, blockers) : null;
    const packetView = packetHealth?.view ?? null;
    const completion = isSliceConsumed(root, id);
    const packetMarked = packet?.status === 'consumed';
    const progressState = progressClosureState(progress, id);
    const progressMarked = progressState.closed;
    const planMarked = normalizedStatus(planStatus) === 'consumed';
    const packetUnique = !inventory.duplicates.has(id);
    const consumed = packetMarked && packetUnique && Boolean(packetHealth?.valid) && completion.consumed && progressMarked;
    if (!consumed && (packetMarked || completion.consumed || progressMarked || planMarked)) {
      blockers.push(
        `Slice ${id} has an incomplete consumption transition: packet=${packetMarked ? 'consumed' : packet?.status ?? 'missing'}, `
        + `completion=${completion.consumed ? 'terminal-green' : completion.reason}, progress=${progressMarked ? 'recorded' : 'not-recorded'}.`,
      );
    }
    const planState = normalizedStatus(planStatus);
    const planReady = planState === 'ready';
    const packetReady = packet?.status === 'ready';
    const implementableReady = planReady && packetReady && packetUnique && Boolean(packetHealth?.valid);
    if (planReady && !packet) blockers.push(`Slice ${id} is plan-ready but has no active Step 5 packet.`);
    else if (planReady && !packetUnique) { /* duplicate blocker already names the slice */ }
    else if (planReady && !packetReady) blockers.push(`Slice ${id} is plan-ready but its packet status is ${packet?.status ?? 'missing'}.`);
    else if (planReady && !packetHealth?.valid) blockers.push(`Slice ${id} is plan-ready but its Step 5 packet is invalid.`);
    if (packetReady && !planReady) {
      blockers.push(`Slice ${id} has a ready Step 5 packet but plan status is ${planStatus ?? 'missing'}.`);
    }

    let status: SliceViewStatus;
    if (consumed) status = 'consumed';
    else if (planMarked || packetMarked || completion.consumed || progressMarked) status = 'blocked';
    else if (implementableReady) status = 'ready';
    else if (planReady || packetReady || !packetUnique) status = 'blocked';
    else status = planState === 'unknown' ? normalizedStatus(packet?.status ?? null) : planState;
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
        ? `${slice.latest_metric.changed_lines}/${slice.latest_metric.max_changed_lines} lines @ ${slice.latest_metric.recorded_at}; surfaces=${slice.latest_metric.affected_surfaces.join(', ') || 'none'}; split=${slice.latest_metric.split_decision ?? 'none'}; sig=${slice.latest_metric.signature}`
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
