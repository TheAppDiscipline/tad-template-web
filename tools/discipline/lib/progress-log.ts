import { normalizeSliceId } from './slice-identity.js';

export interface ProgressLogBody {
  sliceId: string;
  outcome: string;
  gates: string;
  scope: string | null;
  next: string | null;
}

export interface ProgressLogEntry {
  sliceId: string | null;
  outcome: string | null;
  gates: string | null;
  identitySource: 'field' | 'legacy-heading' | 'missing';
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

function field(block: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`^\\s*-\\s*\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, 'im'))?.[1]?.trim() ?? null;
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
    const explicit = field(block, 'Slice');
    const fallback = explicit ? null : legacyHeadingSlice(heading[1]);
    return {
      sliceId: explicit ? normalizeSliceId(explicit) : fallback,
      outcome: field(block, 'Status')?.toLowerCase() ?? null,
      gates: field(block, 'Gates')?.toLowerCase() ?? null,
      identitySource: explicit ? 'field' : fallback ? 'legacy-heading' : 'missing',
    };
  });
}

export function progressRecordsClosure(content: string | null, sliceId: string): boolean {
  if (content === null) return false;
  const wanted = normalizeSliceId(sliceId);
  return readProgressLog(content).some((entry) =>
    entry.sliceId === wanted
    && ['done', 'shipped'].includes(entry.outcome ?? '')
    && entry.gates === 'yes');
}
