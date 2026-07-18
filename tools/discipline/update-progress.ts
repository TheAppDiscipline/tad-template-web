import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePacketFile } from './lib/parse-packet.js';

const args = minimist(process.argv.slice(2));
const projectRoot = resolveProjectRoot(args['project-dir']);

export async function updateProgress(root: string): Promise<void> {
  const progressPath = path.join(root, 'progress.md');
  const packetPath = path.join(root, '.discipline', 'packets', 'SLICE_COMPLETION_PACKET.md');
  if (!fs.existsSync(progressPath)) disciplineError('progress.md not found. Run discipline:hydrate first.');
  if (!fs.existsSync(packetPath)) disciplineError('SLICE_COMPLETION_PACKET.md not found in .discipline/packets/');

  const packet = parsePacketFile(packetPath, fs.readFileSync(packetPath, 'utf-8'));
  const body = packet.body;

  const sliceNumber = packet.slice || extractSliceNumber(body);
  const sliceName = extractSliceName(body) || `Slice ${sliceNumber}`;
  const outcome = extractOutcome(body);
  const gatesPassed = extractGates(body);
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
  if (!gatesPassed) throw new Error('SLICE_COMPLETION_PACKET has no "### Gates passed" section. Refusing to record a slice with an unknown gate result.');

  // Preserve the file's existing newline style: reading the template on Windows yields CRLF,
  // and re-emitting with bare '\n' used to leave the untouched lines on CRLF and the injected
  // ones on LF (a mixed-EOL file that reads as fully modified). Work in LF, restore on write.
  const raw = fs.readFileSync(progressPath, 'utf-8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let progress = raw.replace(/\r\n/g, '\n');

  const date = new Date().toISOString().slice(0, 10);

  // Idempotency keyed on a stable packet fingerprint (slice name + log body, both derived only
  // from the packet, never the date), so reprocessing the same packet on a LATER day is still a
  // no-op. The slice name disambiguates two slices that happen to share the same body.
  const logBody = buildLogBody(outcome, gatesPassed, scopeDelivered, nextRec);
  if (progress.includes(`— ${sliceName}\n${logBody}`)) {
    disciplineInfo(`progress.md already records ${sliceName} (${outcome}); no change.`);
    return;
  }

  let nextSlice = 'pending';
  const tpPath = path.join(root, 'task_plan.md');
  if (fs.existsSync(tpPath)) {
    nextSlice = detectNextSlice(fs.readFileSync(tpPath, 'utf-8').replace(/\r\n/g, '\n'), sliceNumber) || 'all slices completed';
  }

  progress = updateField(progress, 'Working on:', nextSlice);
  progress = updateField(progress, 'Next:', nextRec || 'pending');
  progress = updateField(progress, 'Blockers:', openIssues.length ? 'see Open Errors' : 'none');
  if (openIssues.length) progress = mergeOpenErrors(progress, openIssues);
  progress = shiftHistory(progress, sliceName, `${sliceName} — ${date} — ${outcome}`);

  progress = insertLog(progress, `### ${date} — ${sliceName}\n${logBody}`);

  fs.writeFileSync(progressPath, progress.replace(/\n/g, eol), 'utf-8');
  disciplineInfo(`progress.md updated: ${sliceName} (${outcome}). Next: ${nextSlice}`);
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

// Top-level bullets of a section, each with wrapped continuation lines rejoined. This is the
// canonical SLICE_COMPLETION_PACKET shape the discipline-step5-slice skill teaches:
// "### Scope delivered\n- item one\n  wrapped\n- item two".
function sectionItems(body: string, name: string): string[] {
  const text = sectionText(body, name);
  if (!text) return [];
  const items: string[] = [];
  for (const rawLine of text.split('\n')) {
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

// Reflect the real gate result. Returns null when no gate result is stated (caller refuses).
// Any failure OR non-execution signal ("FAILED", "NOT RUN", "skipped", "pending"...) is treated
// as not-green, so an un-run or unknown gate is never logged as "yes" (that was a false green).
function extractGates(body: string): string | null {
  const raw = firstMeaningful(inlineField(body, 'GATES'), sectionItems(body, 'Gates passed').concat(sectionItems(body, 'Gates')));
  if (!raw) return null;
  if (/\b(fail|failed|failing|error|errors|red|broken|not\s*run|not\s*executed|notrun|un-?run|skip|skipped|pending|todo|n\/?a|unknown)\b/i.test(raw) || /[✗✘]/.test(raw)) {
    return `no (${firstLine(raw).slice(0, 60)})`;
  }
  return 'yes';
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

function updateField(content: string, field: string, value: string): string {
  const p = new RegExp(`(${escapeRe(field)})\\s*.+`, 'i');
  return p.test(content) ? content.replace(p, `$1 ${value}`) : content;
}

// Push newEntry to the top of the 3-slot "## Last Completed Slices" list. Preserves the blank
// line before the next heading (the old version consumed it, welding the list to the heading)
// and is idempotent across dates (refreshes the top entry when it is for the same slice instead
// of stacking a second one, since the entry text carries the date).
function shiftHistory(content: string, sliceName: string, newEntry: string): string {
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
  if (entries[0] && entries[0].startsWith(`${sliceName} —`)) entries[0] = newEntry;
  else entries.unshift(newEntry);
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
function mergeOpenErrors(content: string, issues: string[]): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase().startsWith('## open errors'));
  if (idx === -1) return content;
  let end = idx + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const existing = lines.slice(idx + 1, end).filter((l) => /^\s*[-*]\s+/.test(l)).map(cleanBullet);
  const placeholderOnly = existing.length === 0 || existing.every((b) => isNone(b));
  const merged = placeholderOnly ? [] : [...existing];
  for (const iss of issues) if (!merged.some((m) => m.toLowerCase() === iss.toLowerCase())) merged.push(iss);
  const block = merged.map((m) => `- ${m}`);
  return [...lines.slice(0, idx + 1), ...block, '', ...lines.slice(end)].join('\n');
}

function detectNextSlice(taskPlan: string, current: number): string | null {
  const slices: { name: string; num: number }[] = [];
  let m; const p = /^## (Slice (\d+) - .+)/gm;
  while ((m = p.exec(taskPlan)) !== null) slices.push({ name: m[1], num: parseInt(m[2], 10) });
  return slices.find((s) => s.num > current)?.name || null;
}

// Only execute as CLI when invoked directly (npm run discipline:progress).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  updateProgress(projectRoot).catch((e) => disciplineError(e.message));
}
