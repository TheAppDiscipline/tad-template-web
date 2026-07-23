import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePacketFile } from './lib/parse-packet.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

// The gate result is modelled as an explicit state, not inferred from a single positive word:
// only 'passed' is a green, and watch advances the pipeline only on 'passed'.
export type GateState = 'passed' | 'failed' | 'unverified';

export async function updateProgress(root: string): Promise<{ gate: GateState }> {
  const progressPath = path.join(root, 'progress.md');
  const packetPath = path.join(root, '.discipline', 'packets', 'SLICE_COMPLETION_PACKET.md');
  if (!fs.existsSync(progressPath)) disciplineError('progress.md not found. Run discipline:hydrate first.');
  if (!fs.existsSync(packetPath)) disciplineError('SLICE_COMPLETION_PACKET.md not found in .discipline/packets/');

  const packet = parsePacketFile(packetPath, fs.readFileSync(packetPath, 'utf-8'));
  const body = packet.body;

  const sliceNumber = packet.slice || extractSliceNumber(body);
  const sliceName = extractSliceName(body) || `Slice ${sliceNumber}`;
  const outcome = extractOutcome(body);
  const gate = extractGates(body);
  const scopeDelivered = joinItems(sectionItems(body, 'Scope delivered'));
  const openIssues = meaningfulItems(sectionItems(body, 'Open issues'));
  const nextRec = firstMeaningful(
    inlineField(body, 'NEXT') || inlineField(body, 'RECOMMENDATION'),
    sectionItems(body, 'Next recommendation'),
  );

  // Fail-closed: refuse to record a completion whose outcome or gate result is not stated,
  // instead of defaulting to an optimistic shipped/yes (that default is itself a false green).
  // Throw (not disciplineError, which process.exit()s) so watch/run tolerate it as a warning and
  // keep the process alive; the CLI path turns the throw into a clear non-zero exit.
  if (!outcome) throw new Error('SLICE_COMPLETION_PACKET has no "### Outcome" (done | partial | blocked). Refusing to record a slice with an unknown outcome.');
  if (!gate) throw new Error('SLICE_COMPLETION_PACKET has no "### Gates passed" section. Refusing to record a slice with an unknown gate result.');
  const gatesPassed = gateLabel(gate);

  // Preserve the file's existing newline style: reading the template on Windows yields CRLF,
  // and re-emitting with bare '\n' used to leave the untouched lines on CRLF and the injected
  // ones on LF (a mixed-EOL file that reads as fully modified). Work in LF, restore on write.
  const raw = fs.readFileSync(progressPath, 'utf-8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let progress = raw.replace(/\r\n/g, '\n');

  const date = new Date().toISOString().slice(0, 10);

  let nextSlice = 'pending';
  const tpPath = path.join(root, 'task_plan.md');
  if (fs.existsSync(tpPath)) {
    nextSlice = detectNextSlice(fs.readFileSync(tpPath, 'utf-8').replace(/\r\n/g, '\n'), sliceNumber) || 'all slices completed';
  }

  // Each mutation below is individually idempotent, so reprocessing the SAME packet is a no-op
  // while a genuine edit (e.g. a newly added open issue) still lands. The old whole-packet
  // early-return skipped these mutations entirely, so a later-added open issue was silently lost.
  progress = updateField(progress, 'Working on:', nextSlice);
  progress = updateField(progress, 'Next:', nextRec || 'pending');
  progress = updateField(progress, 'Blockers:', openIssues.length ? 'see Open Errors' : 'none');
  if (openIssues.length) progress = mergeOpenErrors(progress, openIssues);
  progress = shiftHistory(progress, sliceName, outcome, `${sliceName} — ${date} — ${outcome}`);

  // The log block is keyed on a date-independent fingerprint (slice name + body), so reprocessing
  // the same packet on a later day never stacks a duplicate; a changed body inserts a fresh block.
  const logBody = buildLogBody(outcome, gatesPassed, scopeDelivered, nextRec);
  if (!progress.includes(`— ${sliceName}\n${logBody}`)) {
    progress = insertLog(progress, `### ${date} — ${sliceName}\n${logBody}`);
  }

  fs.writeFileSync(progressPath, progress.replace(/\n/g, eol), 'utf-8');
  disciplineInfo(`progress.md updated: ${sliceName} (${outcome}, gates: ${gatesPassed}). Next: ${nextSlice}`);
  return { gate: gate.state };
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function firstLine(s: string): string { return s.split('\n')[0].trim(); }
function cleanBullet(s: string): string { return s.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim(); }

// A value that carries no information: empty, "none", "n/a", any punctuation/case.
function isNone(text: string): boolean {
  const bare = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return bare === '' || bare === 'none' || bare === 'na';
}

// Raw text under a "## Name" or "### Name" heading (case-insensitive), up to the next heading.
function sectionText(body: string, name: string): string | null {
  return body.match(new RegExp(`#{2,3}\\s+${escapeRe(name)}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`, 'i'))?.[1]?.trim() || null;
}

// THE bullet parser of this file: top-level bullets with their wrapped continuation lines rejoined.
// Every caller goes through here so a "bullet" means the same thing on both sides of a merge. The
// destructive Open Errors truncation came from a second, line-at-a-time parser that disagreed with
// this one; do not reintroduce one.
function collectBullets(rawLines: string[]): string[] {
  const items: string[] = [];
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*[-*]\s+/.test(line)) {
      items.push(cleanBullet(line));
    } else if (line.trim() !== '' && !/^#{1,6}\s/.test(line)) {
      // continuation of the previous bullet, or a bare (bulletless) paragraph
      if (items.length) items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`.replace(/\s+/g, ' ').trim();
      else items.push(line.trim());
    }
  }
  return items.map((s) => s.trim()).filter(Boolean);
}

// Top-level bullets of a section. This is the canonical SLICE_COMPLETION_PACKET shape the
// discipline-step5-slice skill teaches: "### Scope delivered\n- item one\n  wrapped\n- item two".
function sectionItems(body: string, name: string): string[] {
  const text = sectionText(body, name);
  return text ? collectBullets(text.split('\n')) : [];
}

// Legacy inline "KEY: value" field (pre-skill packet shape); still honored for back-compat.
function inlineField(body: string, name: string): string | null {
  return body.match(new RegExp(`^[-*]?\\s*${escapeRe(name)}[:\\s]+(.+)`, 'im'))?.[1]?.trim() || null;
}

function meaningfulItems(items: string[]): string[] {
  return items.map(cleanBullet).filter((s) => s && !isNone(s));
}

function firstMeaningful(inline: string | null, items: string[]): string | null {
  if (inline && !isNone(inline)) return cleanBullet(inline);
  return meaningfulItems(items)[0] || null;
}

function joinItems(items: string[]): string | null {
  const kept = meaningfulItems(items);
  return kept.length ? kept.join('; ') : null;
}

function extractSliceName(body: string): string | null {
  const inline = inlineField(body, 'SLICE_NAME');
  if (inline) return cleanBullet(inline);
  const items = sectionItems(body, 'Slice');
  return items.length ? items[0] : null;
}

function extractSliceNumber(body: string): number {
  const fromName = extractSliceName(body)?.match(/(\d+)/)?.[1];
  if (fromName) return parseInt(fromName, 10);
  return parseInt(body.match(/slice[^\S\n]*[:#-]?[^\S\n]*(\d+)/i)?.[1] || '0', 10);
}

// Read the real outcome instead of assuming success. Returns null when no outcome is stated so
// the caller refuses to record the slice, rather than defaulting to an optimistic "shipped".
function extractOutcome(body: string): string | null {
  const raw = firstMeaningful(inlineField(body, 'OUTCOME'), sectionItems(body, 'Outcome'));
  if (!raw) return null;
  const known = ['done', 'shipped', 'partial', 'blocked', 'ready', 'wip', 'in-progress'];
  const hit = known.find((k) => raw.toLowerCase().startsWith(k));
  return hit || raw.split(/[.;,]/)[0].trim().slice(0, 40) || null;
}

const GATE_STATE_PREFIX = /^gate[_\s-]?state\s*[:=]/i;
const GATE_STATE_EXACT = /^gate[_\s-]?state\s*[:=]\s*(passed|failed|unverified)\s*$/i;

// The recorded gate state comes ONLY from an explicit, machine-readable GATE_STATE declaration; it is
// never inferred from evidence prose. Free text is language-dependent and collides across locales (an
// English failure-word blocklist read Spanish "sin red"/"0 errores" and even English "0 errors" as a
// failure, recording a false red that stalls a green pipeline), and any positive-word allowlist leaks
// the mirror-image false green ("cannot pass", "NOT PASSED"). So: exactly one declaration whose value
// is exactly one of passed|failed|unverified wins; a missing, placeholder, trailing-prose, non-exact,
// or conflicting declaration is 'unverified' (fail-closed). Evidence bullets explain a state to a
// human but never create one.
function gateStateOf(items: string[]): GateState {
  const declarations = items.map((it) => it.trim()).filter((it) => GATE_STATE_PREFIX.test(it));
  if (declarations.length !== 1) return 'unverified';
  const match = declarations[0].match(GATE_STATE_EXACT);
  return match ? (match[1].toLowerCase() as GateState) : 'unverified';
}

// Returns the gate state + its raw text, or null when no gate section exists (caller refuses).
function extractGates(body: string): { state: GateState; raw: string } | null {
  const inline = inlineField(body, 'GATES');
  const items = inline ? [cleanBullet(inline)] : meaningfulItems(sectionItems(body, 'Gates passed').concat(sectionItems(body, 'Gates')));
  if (!items.length) return null;
  return { state: gateStateOf(items), raw: items.join('; ') };
}

// Re-derive the current SLICE_COMPLETION_PACKET's gate state from disk. The watcher calls this on
// EVERY event (not a per-event boolean) so a stale non-green completion left in .discipline/packets/
// cannot be advanced past by a later, unrelated packet event.
export function completionGateState(root: string): GateState {
  const packetPath = path.join(root, '.discipline', 'packets', 'SLICE_COMPLETION_PACKET.md');
  if (!fs.existsSync(packetPath)) return 'unverified';
  try {
    const gate = extractGates(parsePacketFile(packetPath, fs.readFileSync(packetPath, 'utf-8')).body);
    return gate ? gate.state : 'unverified';
  } catch {
    return 'unverified';
  }
}

// Human-readable gate label for the progress log.
function gateLabel(gate: { state: GateState; raw: string }): string {
  if (gate.state === 'passed') return 'yes';
  if (gate.state === 'failed') return `no (${firstLine(gate.raw).slice(0, 60)})`;
  return `unverified (${firstLine(gate.raw).slice(0, 60)})`;
}

// The body of a log entry, derived only from the packet (no date), so it doubles as a stable
// idempotency fingerprint for reprocessing the same packet on a later day.
function buildLogBody(outcome: string, gates: string, scope: string | null, next: string | null): string {
  const parts = [`- **Status:** ${outcome}`, `- **Gates:** ${gates}`];
  if (scope) parts.push(`- **Scope:** ${scope}`);
  if (next) parts.push(`- **Next:** ${next}`);
  return parts.join('\n');
}

// Insert the newest log block right after the "---" separator. Idempotent: re-running the same
// packet (as discipline:watch can) no longer stacks a duplicate block.
function insertLog(progress: string, logEntry: string): string {
  if (progress.includes(logEntry)) return progress;
  const marker = '\n---\n';
  const block = `\n${logEntry}\n`;
  const sepIdx = progress.indexOf(marker);
  if (sepIdx === -1) return `${progress.replace(/\n*$/, '')}\n\n---\n${block}`;
  const insertAt = sepIdx + marker.length;
  return progress.slice(0, insertAt) + block + progress.slice(insertAt);
}

// A Current Status field is single-line state OWNED by the engine: every close overwrites the value.
// So the whole value is replaced, wrapped continuation lines included. Replacing only the first line
// (the old `\s*.+`) welded the tail of the old value under the new one and produced text that reads
// as a statement but is nobody's: "- Blockers: see Open Errors" followed by an orphaned "are both
// pending as of 2026-07-22". Anchored to the start of a line, so "- **Next:** ..." inside a log
// block is never mistaken for the header field, and `[^\n]*` cannot run past the end of the line
// into the next one when the field is empty. A continuation is a non-empty, non-heading, non-bullet
// line; an indented sub-bullet is left in place rather than silently deleted, since deleting it
// here would repeat the Open Errors mistake.
//
// A blank line does NOT end the value on its own: markdown lets a list item hold several
// paragraphs, so "- Blockers: x\n\n  second paragraph" is all one value and stopping at the blank
// left that paragraph orphaned (the very defect this function exists to fix). But a blank line DOES
// end it when what follows is unindented, because that is free prose the human wrote under the
// section, not part of any field. Consuming "to the next bullet or ## heading" without that
// distinction would delete it, which is the Open Errors mistake in a new place. Indentation is the
// signal, and only after a blank: a line pressed directly against the field is a lazy continuation
// whether or not it is indented.
function updateField(content: string, field: string, value: string): string {
  const lines = content.split('\n');
  const head = new RegExp(`^(\\s*[-*]?\\s*${escapeRe(field)})[^\\n]*$`, 'i');
  const idx = lines.findIndex((l) => head.test(l));
  if (idx === -1) return content;
  let end = idx + 1;
  let blankSeen = false;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { blankSeen = true; continue; } // kept only if a continuation follows
    if (/^\s*[-*]\s/.test(line) || /^\s*#{1,6}\s/.test(line)) break; // next bullet or heading
    if (blankSeen && !/^\s/.test(line)) break; // unindented prose after a blank belongs to nobody
    end = i + 1;
  }
  return [...lines.slice(0, idx), lines[idx].replace(head, `$1 ${value}`), ...lines.slice(end)].join('\n');
}

// Push newEntry to the top of the 3-slot "## Last Completed Slices" list. Preserves the blank
// line before the next heading (the old version consumed it, welding the list to the heading).
// Idempotent across dates: if the top entry is already this slice at the same outcome it is left
// untouched (the entry text carries the date, so a naive compare would refresh it every day); an
// outcome change refreshes it in place; a different slice is prepended.
function shiftHistory(content: string, sliceName: string, outcome: string, newEntry: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('## Last Completed Slices'));
  if (idx === -1) return content;
  const entries: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\d+\)\s+(.+)/);
    if (m) { if (!m[1].startsWith('(empty)')) entries.push(m[1].trim()); }
    else if (lines[i].trim() === '') continue;
    else break;
  }
  if (entries[0] && entries[0].startsWith(`${sliceName} —`)) {
    if (!entries[0].endsWith(`— ${outcome}`)) entries[0] = newEntry; // same slice, changed outcome
  } else {
    entries.unshift(newEntry);
  }
  const top3 = entries.slice(0, 3);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (lines[i].trim().startsWith('## Last Completed Slices')) {
      for (let k = 0; k < 3; k++) out.push(`${k + 1}) ${top3[k] || '(empty)'}`);
      let j = i + 1;
      while (j < lines.length && /^\s*\d+\)\s/.test(lines[j])) j++; // skip only the old numbered lines
      i = j - 1;
    }
  }
  return out.join('\n');
}

// Surface real open issues under "## Open Errors" so "Blockers: see Open Errors" points at
// something. Replaces the "(none)" placeholder; otherwise appends issues not already listed.
//
// Unlike a Current Status field, this section is HUMAN-OWNED and accumulative, so the existing block
// is copied VERBATIM and never re-emitted from parsed text. Parsing is used only to compare against
// the incoming issues for duplicates. The old version kept just the lines starting with a bullet
// marker and rebuilt the section from them, which lost two different ways at once: every wrapped
// continuation line was dropped (evidence, hypothesis and next probe of an entry, ~130 lines in the
// 2026-07-22 incident), and indented sub-bullets, which do pass the marker test, came back at top
// level, turning two open errors into four with two of them subjectless. Re-emitting through
// cleanBullet would also flatten a multi-line entry into one long line even with a correct parser,
// so preserving the lines is the fix, not a better rewrite.
function mergeOpenErrors(content: string, issues: string[]): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase().startsWith('## open errors'));
  if (idx === -1) return content;
  let end = idx + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const existingBlock = lines.slice(idx + 1, end);
  const existing = collectBullets(existingBlock);
  const placeholderOnly = existing.length === 0 || existing.every((b) => isNone(b));

  const seen = placeholderOnly ? [] : existing.map((e) => e.toLowerCase());
  const additions: string[] = [];
  for (const iss of issues) {
    if (seen.includes(iss.toLowerCase())) continue;
    seen.push(iss.toLowerCase());
    additions.push(`- ${iss}`);
  }
  if (!additions.length) return content; // nothing new: leave the file byte-identical

  const kept = placeholderOnly ? [] : [...existingBlock];
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop(); // append inside the section
  return [...lines.slice(0, idx + 1), ...kept, ...additions, '', ...lines.slice(end)].join('\n');
}

// Slice headings are buyer-authored, so tolerate ## or ###, an ASCII hyphen / en dash / em dash /
// colon separator, a letter-suffixed number ("Slice 3A"), and a trailing " · [status]" marker.
// The old matcher accepted only "## Slice N - " and silently missed real next slices written in any
// other style, mislabeling "Working on" as "all slices completed".
function detectNextSlice(taskPlan: string, current: number): string | null {
  const slices: { name: string; num: number }[] = [];
  let m; const p = /^#{2,3}\s+(Slice\s+(\d+)[A-Za-z]?[^\n]*)/gim;
  while ((m = p.exec(taskPlan)) !== null) {
    slices.push({ name: m[1].replace(/\s*·.*$/, '').trim(), num: parseInt(m[2], 10) });
  }
  return slices.find((s) => s.num > current)?.name || null;
}

// Only execute as CLI when invoked directly (npm run discipline:progress).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  updateProgress(projectRoot).catch((e) => disciplineError(e.message));
}
