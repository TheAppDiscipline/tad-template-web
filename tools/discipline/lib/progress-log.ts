import { normalizeSliceId } from './slice-identity.js';
import { plainDeclaration } from './step5-schema.js';

export interface ProgressLogBody {
  sliceId: string;
  outcome: string;
  gates: string;
  scope: string | null;
  next: string | null;
}

export interface ProgressLogEntry {
  sliceId: string | null;
  candidateSliceIds: string[];
  outcome: string | null;
  gates: string | null;
  identitySource: 'field' | 'legacy-heading' | 'missing';
  problems: string[];
}

export interface ProgressClosureReading {
  closed: boolean;
  state: 'closed' | 'missing' | 'invalid' | 'contradictory' | 'open';
  reason: string;
}

/** Canonical, date-independent log body written by update-progress. */
export function buildProgressLogBody(input: ProgressLogBody): string {
  const parts = [
    `- **Slice:** ${normalizeSliceId(input.sliceId)}`,
    `- **Status:** ${input.outcome}`,
    `- **Gates:** ${input.gates}`,
  ];
  if (input.scope) parts.push(`- **Scope:** ${input.scope}`);
  if (input.next) parts.push(`- **Next:** ${input.next}`);
  return parts.join('\n');
}

function fieldValues(block: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escaped}\\s*:\\s*(.*)$`, 'i');
  return block.split(/\r?\n/)
    .map((line) => plainDeclaration(line).match(matcher)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
}

function legacyHeadingSlice(label: string): string | null {
  // Old logs carried identity only in the visible title. Keep reading their composite IDs and all
  // separators update-progress historically emitted, but never use this fallback for new writes.
  const match = label.match(/^(?:slice\s+)?([A-Za-z][A-Za-z0-9._-]*|\d[A-Za-z0-9._-]*)(?=\s|[-—:]|$)/i);
  return match ? normalizeSliceId(match[1]) : null;
}

/** One parser for both state-view and future progress consumers. */
export function readProgressLog(content: string): ProgressLogEntry[] {
  const headings = [...content.matchAll(/^###\s+\d{4}-\d{2}-\d{2}\s+(?:—|-|:)\s+(.+?)\s*$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index ?? content.length : content.length;
    const block = content.slice(start, end);
    const slices = fieldValues(block, 'Slice');
    const statuses = fieldValues(block, 'Status');
    const gates = fieldValues(block, 'Gates');
    const fallback = slices.length === 0 ? legacyHeadingSlice(heading[1]) : null;
    const candidateSliceIds = [...new Set(
      (slices.length > 0 ? slices.map(normalizeSliceId) : [fallback]).filter((value): value is string => Boolean(value)),
    )];
    const problems: string[] = [];
    if (slices.length > 1) problems.push(`Slice has ${slices.length} declarations`);
    if (slices.length === 1 && !normalizeSliceId(slices[0])) problems.push('Slice is empty or invalid');
    if (slices.length === 0 && !fallback) problems.push('Slice is missing and the legacy heading has no identity');
    if (statuses.length !== 1) problems.push(`Status has ${statuses.length} declarations`);
    if (gates.length !== 1) problems.push(`Gates has ${gates.length} declarations`);
    return {
      sliceId: candidateSliceIds.length === 1 ? candidateSliceIds[0] : null,
      candidateSliceIds,
      outcome: statuses.length === 1 ? statuses[0].toLowerCase() : null,
      gates: gates.length === 1 ? gates[0].toLowerCase() : null,
      identitySource: slices.length > 0 ? 'field' : fallback ? 'legacy-heading' : 'missing',
      problems,
    };
  });
}

/** Validate the whole append-only log, including entries that do not currently appear in the plan. */
export function progressIntegrityBlockers(content: string | null): string[] {
  if (content === null) return [];
  const entries = readProgressLog(content);
  const blockers: string[] = [];
  entries.forEach((entry, index) => {
    if (entry.problems.length === 0) return;
    const owner = entry.candidateSliceIds[0] ? `Slice ${entry.candidateSliceIds[0]}` : `progress.md entry ${index + 1}`;
    blockers.push(`${owner} progress log is invalid: ${entry.problems.join('; ')}.`);
  });

  const validBySlice = new Map<string, ProgressLogEntry[]>();
  for (const entry of entries) {
    if (entry.problems.length > 0 || !entry.sliceId) continue;
    validBySlice.set(entry.sliceId, [...(validBySlice.get(entry.sliceId) ?? []), entry]);
  }
  for (const [slice, sliceEntries] of validBySlice) {
    const verdicts = sliceEntries.map((entry) => `${entry.outcome ?? 'missing'}/${entry.gates ?? 'missing'}`);
    if (new Set(verdicts).size > 1) {
      blockers.push(`Slice ${slice} progress log is contradictory: entries disagree (${verdicts.join(', ')}).`);
    }
  }
  return blockers;
}

export function progressClosureState(content: string | null, sliceId: string): ProgressClosureReading {
  if (content === null) return { closed: false, state: 'missing', reason: 'progress.md is missing' };
  const wanted = normalizeSliceId(sliceId);
  const entries = readProgressLog(content).filter((entry) => entry.candidateSliceIds.includes(wanted));
  if (entries.length === 0) return { closed: false, state: 'missing', reason: `no progress entry for slice ${wanted}` };
  const invalid = entries.flatMap((entry, index) => entry.problems.map((problem) => `entry ${index + 1}: ${problem}`));
  if (invalid.length > 0) return { closed: false, state: 'invalid', reason: invalid.join('; ') };

  const verdicts = entries.map((entry) => `${entry.outcome ?? 'missing'}/${entry.gates ?? 'missing'}`);
  if (new Set(verdicts).size > 1) {
    return { closed: false, state: 'contradictory', reason: `entries disagree (${verdicts.join(', ')})` };
  }
  const [entry] = entries;
  const closed = ['done', 'shipped'].includes(entry.outcome ?? '') && entry.gates === 'yes';
  return closed
    ? { closed: true, state: 'closed', reason: `${entries.length} coherent terminal progress entr${entries.length === 1 ? 'y' : 'ies'}` }
    : { closed: false, state: 'open', reason: `progress records ${verdicts[0]}, not a terminal green closure` };
}

export function progressRecordsClosure(content: string | null, sliceId: string): boolean {
  return progressClosureState(content, sliceId).closed;
}
