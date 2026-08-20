import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePacketFile } from './lib/parse-packet.js';
import {
  cleanBullet, completionGate, escapeRe, firstMeaningful, inlineField, readCompletion,
  collectBullets, isNone, meaningfulItems, sectionItems, type GateState,
} from './lib/completion-packet.js';
import { compareSliceIds, findSliceHeadings, isSliceConsumed, markSliceConsumed, normalizeSliceId, resolveConsumptionTarget, resolvePacketIdentity } from './lib/slice-identity.js';
import { buildProgressLogBody } from './lib/progress-log.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

// The gate result is modelled as an explicit state, not inferred from a single positive word:
// only 'passed' is a green, and watch advances the pipeline only on 'passed'.
export type { GateState };

/**
 * Record a completion packet in progress.md. The caller passes the EXACT packet it validated:
 * defaulting to the canonical filename let the watcher validate one file and record another.
 */
export async function updateProgress(root: string, completionPacketPath?: string): Promise<{ gate: GateState }> {
  const progressPath = path.join(root, 'progress.md');
  // The caller passes the packet it validated; the canonical name is only the fallback.
  const packetPath = completionPacketPath ?? path.join(root, '.discipline', 'packets', 'SLICE_COMPLETION_PACKET.md');
  // Throw, never exit: run.ts and watch.ts import this, and exiting kills their tick.
  if (!fs.existsSync(progressPath)) throw new Error('progress.md not found. Run discipline:hydrate first.');
  if (!fs.existsSync(packetPath)) throw new Error(`Completion packet not found: ${packetPath}`);

  const fileContent = fs.readFileSync(packetPath, 'utf-8');
  const packet = parsePacketFile(packetPath, fileContent);
  const body = packet.body;

  // WHICH slice this packet closes comes from the one identity resolver, not from a second regex
  // over a body the packet parser may have truncated. A packet whose only declaration is a root
  // `SLICE: 13` line lost it there and was logged as "Slice 0".
  //
  // The id stays a STRING, normalized, all of it. Turning it into a number collapsed `S27E2b` to 27
  // and `13.2` to 13, so the slice right after a composite id was invisible to detectNextSlice and
  // progress.md announced "all slices completed" with work still in the plan.
  const identity = resolvePacketIdentity(fileContent, packetPath);
  const legacyNumber = packet.slice || extractSliceNumber(body);
  const sliceId = (identity.ok ? identity.id : null) ?? (legacyNumber ? normalizeSliceId(String(legacyNumber)) : null);
  // The LABEL keeps the id as the packet wrote it (`S27E2b`, not the comparison form `27e2b`), so
  // progress.md reads like the plan it belongs to. The filename is not a name.
  const declared = identity.ok ? identity.declarations.find((d) => d.source !== 'filename') : undefined;
  const declaredLabel = declared ? declared.raw.replace(/^slice\s+/i, '').trim() : null;
  const sliceName = extractSliceName(body)
    || (declaredLabel ? `Slice ${declaredLabel}` : null)
    || (sliceId ? `Slice ${sliceId}` : `Slice ${legacyNumber}`);
  // The same refusals the watcher's preflight ran BEFORE it wrote anything, from the same
  // function: what the progress engine will not record, nothing else may act on either. Throw (not
  // disciplineError, which process.exit()s) so watch/run tolerate it and keep the process alive;
  // the CLI path turns the throw into a clear non-zero exit.
  const reading = readCompletion(fileContent);
  if (!reading.ok) throw new Error(reading.reason);
  const { outcome, gate } = reading;
  const scopeDelivered = joinItems(sectionItems(body, 'Scope delivered'));
  const openIssues = meaningfulItems(sectionItems(body, 'Open issues'));
  const nextRec = firstMeaningful(
    inlineField(body, 'NEXT') || inlineField(body, 'RECOMMENDATION'),
    sectionItems(body, 'Next recommendation'),
  );

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
    nextSlice = detectNextSlice(fs.readFileSync(tpPath, 'utf-8').replace(/\r\n/g, '\n'), sliceId) || 'all slices completed';
  }

  // Each mutation below is individually idempotent, so reprocessing the SAME packet is a no-op
  // while a genuine edit (e.g. a newly added open issue) still lands. The old whole-packet
  // early-return skipped these mutations entirely, so a later-added open issue was silently lost.
  progress = updateField(progress, 'Working on:', nextSlice);
  progress = updateField(progress, 'Next:', nextRec || 'pending');
  progress = updateField(progress, 'Blockers:', openIssues.length ? 'see Open Errors' : 'none');
  if (openIssues.length) progress = mergeOpenErrors(progress, openIssues);
  progress = shiftHistory(progress, sliceName, outcome, `${sliceName} - ${date} - ${outcome}`);

  // The log block is keyed on a date-independent fingerprint (slice name + body), so reprocessing
  // the same packet on a later day never stacks a duplicate; a changed body inserts a fresh block.
  const logBody = buildProgressLogBody({ sliceId: sliceId!, outcome, gates: gatesPassed, scope: scopeDelivered, next: nextRec });
  if (!progress.includes(` - ${sliceName}\n${logBody}`)) {
    progress = insertLog(progress, `### ${date} - ${sliceName}\n${logBody}`);
  }

  fs.writeFileSync(progressPath, progress.replace(/\n/g, eol), 'utf-8');
  disciplineInfo(`progress.md updated: ${sliceName} (${outcome}, gates: ${gatesPassed}). Next: ${nextSlice}`);
  return { gate: gate.state };
}

/** Injectable so a test can fail the LAST write of the transition and check what survives. */
export interface ClosureOps {
  mark: (root: string, sliceId: string) => { ok: true; path: string } | { ok: false; reason: string };
}

export type ClosureResult =
  | { ok: true; consumed: boolean; packet?: string }
  | { ok: false; reason: string; restored: boolean };

/**
 * Record a completion as ONE transition: progress.md and, when the packet closes the slice, the
 * consumption marker. It either lands whole or leaves progress.md byte-identical.
 *
 * The order used to be write-then-check: progress.md was updated and only afterwards did the
 * engine ask whether the slice could be consumed. When it could not (an earlier completion packet
 * that disagrees, a packet that can no longer be edited), progress.md declared the slice complete
 * while the packet still said `ready`, the command exited non-zero, and nothing on disk agreed
 * with anything else. So: prove the target AND every completion packet first, and if a later write
 * still fails, put the previous bytes back.
 *
 * `requireConsumption` is the difference between the two callers. A run must CLOSE the slice it
 * leased, so a non-terminal outcome is a failure there. The watcher records whatever the packet
 * says: `Outcome: partial` is a legitimate entry in the log that consumes nothing.
 */
export async function recordClosure(
  root: string,
  sliceId: string,
  completionPacketPath: string,
  options: { requireConsumption: boolean },
  ops: ClosureOps = { mark: markSliceConsumed },
): Promise<ClosureResult> {
  // 1. Everything that can be known without writing, is known before writing.
  const target = resolveConsumptionTarget(root, sliceId);
  if (!target.ok) return { ok: false, reason: target.reason, restored: false };
  const verdict = isSliceConsumed(root, sliceId);
  if (options.requireConsumption && !verdict.consumed) {
    return { ok: false, reason: verdict.reason, restored: false };
  }

  // 2. The previous bytes of BOTH files this transition writes, kept exactly (BOM, CRLF and all)
  // so a restore is a restore. Backing up progress.md alone left the packet corrupt when the
  // marker write failed HALFWAY: the failure that matters is the one that already wrote something.
  const progressPath = path.join(root, 'progress.md');
  const packetPath = target.packet.path;
  const backups: Array<{ file: string; bytes: Buffer }> = [];
  for (const file of [progressPath, packetPath]) {
    if (fs.existsSync(file)) backups.push({ file, bytes: fs.readFileSync(file) });
  }

  try {
    await updateProgress(root, completionPacketPath);
    // A packet that does not close the slice is recorded and nothing else: that is the whole
    // difference between logging what happened and declaring the work finished.
    if (!verdict.consumed) return { ok: true, consumed: false };
    const marked = ops.mark(root, sliceId);
    if (!marked.ok) throw new Error(marked.reason);
    return { ok: true, consumed: true, packet: marked.path };
  } catch (err) {
    // Every backup goes back, or `restored` says it did not: a partial restore reported as a
    // restore is the same lie as the partial write it was meant to undo.
    let restored = backups.length > 0;
    for (const backup of backups) {
      try { fs.writeFileSync(backup.file, backup.bytes); } catch { restored = false; }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), restored };
  }
}

function firstLine(s: string): string { return s.split('\n')[0].trim(); }








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





/** Every completion packet on disk, under any name. */
function completionPacketFiles(root: string): string[] {
  const dir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /SLICE_COMPLETION_PACKET/i.test(name) && name.endsWith('.md'))
    .map((name) => path.join(dir, name));
}

/** True when the project has at least one completion packet, whatever it is called. */
export function hasCompletionPacket(root: string): boolean {
  return completionPacketFiles(root).length > 0;
}

// Re-derive the completion gate state from disk. The watcher calls this on EVERY event (not a
// per-event boolean) so a stale non-green completion left in .discipline/packets/ cannot be
// advanced past by a later, unrelated packet event. It reads EVERY completion packet, not just the
// canonical filename: guarding one name let a completion saved as SLICE_COMPLETION_PACKET_S13.md
// carry a red gate while the watcher advanced straight past it.
export function completionGateState(root: string): GateState {
  const files = completionPacketFiles(root);
  if (files.length === 0) return 'unverified';

  let worst: GateState = 'passed';
  for (const packetPath of files) {
    let state: GateState = 'unverified';
    try {
      const gate = completionGate(fs.readFileSync(packetPath, 'utf-8'));
      state = gate ? gate.state : 'unverified';
    } catch {
      state = 'unverified';
    }
    // Fail closed: one non-green completion holds the pipeline, whatever the others say.
    if (state === 'failed') return 'failed';
    if (state === 'unverified') worst = 'unverified';
  }
  return worst;
}

// Human-readable gate label for the progress log.
function gateLabel(gate: { state: GateState; raw: string }): string {
  if (gate.state === 'passed') return 'yes';
  if (gate.state === 'failed') return `no (${firstLine(gate.raw).slice(0, 60)})`;
  return `unverified (${firstLine(gate.raw).slice(0, 60)})`;
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
  if (entries[0] && entries[0].startsWith(`${sliceName} - `)) {
    if (!entries[0].endsWith(` - ${outcome}`)) entries[0] = newEntry; // same slice, changed outcome
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

// The slices come from findSliceHeadings, the shared resolver, so "which headings are slices" is
// decided in one place (it already tolerates ## / ###, en and em dashes, `## S13`, and a trailing
// `· [status]` marker). The ORDER comes from compareSliceIds, which compares the whole normalized
// id: parseInt read `S27E2b` as 27 and `13.2` as 13, so the slice right after a composite id never
// compared greater and progress.md announced "all slices completed" with work still in the plan.
function detectNextSlice(taskPlan: string, current: string | null): string | null {
  const headings = findSliceHeadings(taskPlan);
  const label = (heading: { raw: string }) => heading.raw.replace(/^#{1,6}\s+/, '').replace(/\s*·.*$/, '').trim();
  if (!current) return headings.length ? label(headings[0]) : null;
  const next = headings.find((heading) => compareSliceIds(heading.id, current) > 0);
  return next ? label(next) : null;
}

// Only execute as CLI when invoked directly (npm run discipline:progress).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  updateProgress(projectRoot).catch((e) => disciplineError(e.message));
}
