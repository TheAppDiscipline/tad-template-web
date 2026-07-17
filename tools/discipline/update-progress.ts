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
  const sliceNumber = packet.slice || extractSliceNumber(packet.body);
  const sliceName = extractField(packet.body, 'SLICE_NAME') || `Slice ${sliceNumber}`;
  const outcome = extractField(packet.body, 'OUTCOME') || 'shipped';
  const gatesPassed = extractField(packet.body, 'GATES') || 'yes';
  const scopeDelivered = extractSection(packet.body, 'SCOPE DELIVERED');
  const openIssues = normalizeNone(extractSection(packet.body, 'OPEN ISSUES'));
  const nextRecSource =
    extractField(packet.body, 'NEXT') ||
    extractField(packet.body, 'RECOMMENDATION') ||
    normalizeNone(extractSection(packet.body, 'NEXT RECOMMENDATION'));
  const nextRec = nextRecSource ? firstItem(nextRecSource) : null;

  let progress = fs.readFileSync(progressPath, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);

  let nextSlice = 'pending';
  const tpPath = path.join(root, 'task_plan.md');
  if (fs.existsSync(tpPath)) nextSlice = detectNextSlice(fs.readFileSync(tpPath, 'utf-8'), sliceNumber) || 'all slices completed';

  progress = updateField(progress, 'Working on:', nextSlice);
  progress = updateField(progress, 'Next:', nextRec || 'pending');
  progress = updateField(progress, 'Blockers:', openIssues ? 'see Open Errors' : 'none');
  progress = shiftHistory(progress, `${sliceName} \u2014 ${date} \u2014 ${outcome}`);

  const logEntry = `\n### ${date} \u2014 ${sliceName}\n- **Status:** ${outcome}\n- **Gates:** ${gatesPassed}\n${scopeDelivered ? `- **Scope:** ${firstItem(scopeDelivered)}` : ''}\n${nextRec ? `- **Next:** ${nextRec}` : ''}\n`;
  const sepIdx = progress.indexOf('\n---\n');
  progress = sepIdx !== -1 ? progress.slice(0, sepIdx + 5) + '\n' + logEntry + progress.slice(sepIdx + 5) : progress + '\n---\n' + logEntry;

  fs.writeFileSync(progressPath, progress, 'utf-8');
  disciplineInfo(`progress.md updated: ${sliceName} (${outcome}). Next: ${nextSlice}`);
}

function extractSliceNumber(body: string): number { return parseInt(body.match(/slice[:\s]*(\d+)/i)?.[1] || '0', 10); }
function extractField(body: string, name: string): string | null { return body.match(new RegExp(`^[-*]?\\s*${name}[:\\s]+(.+)`, 'im'))?.[1]?.trim() || null; }
function extractSection(body: string, name: string): string | null { return body.match(new RegExp(`###?\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n###?\\s|$)`, 'i'))?.[1]?.trim() || null; }
// A section whose content is just "none" (any bullet/case/punctuation) counts as empty:
// the skill templates instruct writing "- none" when there is nothing to report.
function normalizeNone(text: string | null): string | null {
  if (!text) return null;
  const bare = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return bare === '' || bare === 'none' || bare === 'na' ? null : text;
}
// First logical item of a section: joins wrapped continuation lines of the first
// bullet instead of truncating at the first physical newline.
function firstItem(text: string): string {
  const lines = text.split('\n');
  const collected = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*[-*]/.test(line) || /^#{1,6}\s/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim();
}
function updateField(content: string, field: string, value: string): string { const p = new RegExp(`(${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*.+`, 'i'); return p.test(content) ? content.replace(p, `$1 ${value}`) : content; }

function shiftHistory(content: string, newEntry: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.trim().startsWith('## Last Completed Slices'));
  if (idx === -1) return content;
  const entries: string[] = [];
  for (let i = idx + 1; i < lines.length && entries.length < 3; i++) {
    const m = lines[i].match(/^\d\)\s+(.+)/);
    if (m && !m[1].startsWith('(empty)')) entries.push(m[1]);
    else if (lines[i].trim().startsWith('#')) break;
  }
  entries.unshift(newEntry);
  const top3 = entries.slice(0, 3);
  let result = ''; let inSection = false;
  for (const line of lines) {
    if (line.trim().startsWith('## Last Completed Slices')) {
      inSection = true; result += line + '\n';
      for (let i = 0; i < 3; i++) result += `${i + 1}) ${top3[i] || '(empty)'}\n`;
      continue;
    }
    if (inSection) { if (line.match(/^\d\)\s/) || line.trim() === '') continue; inSection = false; }
    result += line + '\n';
  }
  return result.trimEnd() + '\n';
}

function detectNextSlice(taskPlan: string, current: number): string | null {
  const slices: { name: string; num: number }[] = [];
  let m; const p = /^## (Slice (\d+) - .+)/gm;
  while ((m = p.exec(taskPlan)) !== null) slices.push({ name: m[1], num: parseInt(m[2], 10) });
  return slices.find(s => s.num > current)?.name || null;
}

// Only execute as CLI when invoked directly (npm run discipline:progress).
// When imported from another module (for example watch.ts), do not auto-execute.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  updateProgress(projectRoot).catch(e => disciplineError(e.message));
}
