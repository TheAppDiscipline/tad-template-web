/**
 * Cross-validation report packet: the advisory verdict from a family-different
 * validator that reviewed a slice's diff read-only. The report is a markdown
 * file with packet frontmatter (schema `discipline.packet/cross_validation`)
 * that passes the warn-only packet-meta validation, plus a human-readable body.
 *
 * Verdict parsing is tolerant: the validator is asked for
 * {"verdict":"pass"|"concerns","notes":[...]} but may reply with prose. When no
 * JSON is found we wrap the whole reply as a single note and mark the verdict
 * "concerns" (advisory, conservative). This never blocks the run.
 */

export const CROSS_VALIDATION_SCHEMA = 'discipline.packet/cross_validation';
export const CROSS_VALIDATION_VERSION = '1.0.0';

export type Verdict = 'pass' | 'concerns';

export interface ParsedVerdict {
  verdict: Verdict;
  notes: string[];
}

/**
 * Extract a verdict from a validator reply. Looks for a JSON object with a
 * `verdict` field anywhere in the text; falls back to keyword sniffing, then to
 * wrapping the reply as a note with verdict "concerns".
 */
export function parseVerdict(reply: string): ParsedVerdict {
  const text = (reply ?? '').trim();
  if (!text) return { verdict: 'concerns', notes: ['(empty validator reply)'] };

  // Try to find a JSON object (possibly inside a ```json fence or prose).
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(text);

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && typeof obj.verdict === 'string') {
        const verdict: Verdict = /^pass$/i.test(obj.verdict.trim()) ? 'pass' : 'concerns';
        const notes = Array.isArray(obj.notes)
          ? obj.notes.map((n) => String(n)).filter((n) => n.trim().length > 0)
          : [];
        return { verdict, notes: notes.length ? notes : ['(no notes provided)'] };
      }
    } catch {
      // not this candidate
    }
  }

  // No JSON verdict. Keyword sniff, then wrap the reply as a note.
  const lower = text.toLowerCase();
  const looksPass = /\bpass(ed)?\b|\blgtm\b|no (issues|concerns|problems)/.test(lower) && !/\bconcern|\bissue|\bproblem|\bfail/.test(lower);
  return { verdict: looksPass ? 'pass' : 'concerns', notes: [text.slice(0, 1000)] };
}

export interface CrossValidationReportInput {
  slice: string;
  runId: string;
  validator: string;
  builder: string;
  verdict: Verdict;
  notes: string[];
  rawSummary: string;
}

function safeSlice(sliceId: string): string {
  return String(sliceId).replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Serialize the frontmatter with the fixed key set (no external YAML dumper). */
function serializeFrontmatter(input: CrossValidationReportInput): string {
  const id = `cross-validation-${safeSlice(input.slice)}-${input.runId}`;
  return [
    '---',
    `schema: ${CROSS_VALIDATION_SCHEMA}`,
    `version: ${CROSS_VALIDATION_VERSION}`,
    `id: ${id}`,
    'status: ready',
    `slice: ${input.slice}`,
    'produced_by:',
    '  tool: discipline:run',
    `  validator: ${input.validator}`,
    `  builder: ${input.builder}`,
    '---',
  ].join('\n');
}

/** Build the full cross-validation report markdown (frontmatter + body). Pure. */
export function buildCrossValidationReport(input: CrossValidationReportInput): string {
  const notes = input.notes.length ? input.notes.map((n) => `- ${n}`).join('\n') : '- (none)';
  return [
    serializeFrontmatter(input),
    '',
    `# CROSS-VALIDATION REPORT - slice ${input.slice}`,
    '',
    `Advisory review by \`${input.validator}\` (a different model family than the builder \`${input.builder}\`).`,
    'This is advisory only: it never blocks the run.',
    '',
    '## Verdict',
    input.verdict,
    '',
    '## Notes',
    notes,
    '',
    '## Raw validator summary',
    '```',
    (input.rawSummary || '(none)').slice(0, 2000),
    '```',
    '',
  ].join('\n');
}
