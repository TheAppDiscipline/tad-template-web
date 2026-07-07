import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { acquireWriterLock, releaseWriterLock } from './lib/locks.js';
import { appendLedger } from './lib/ledger.js';

/**
 * Checkpoints: approval packets that turn a human decision into a git-auditable
 * artifact. A checkpoint is a markdown file under `.discipline/packets/` with
 * YAML frontmatter (`schema: discipline.packet/checkpoint`) and a fixed body:
 * Summary, Gate (from the latest gate report), Diff (git diff --stat HEAD), and
 * a Decision placeholder. `create` writes one in `status: ready-for-human`;
 * `approve` / `reject` locate it, rewrite the status, and fill the Decision.
 *
 * This is deterministic and LLM-free. It reuses the Phase-0 substrate: the
 * writer lock guards edits, the ledger records `checkpoint_created` /
 * `checkpoint_decided`, and the gate section is read from
 * `.discipline/gate-report.json` (schema discipline.gate_report.v1). No network.
 */

export const CHECKPOINT_SCHEMA = 'discipline.packet/checkpoint';
export const CHECKPOINT_VERSION = '1.0.0';
export type CheckpointKind = 'pre-commit' | 'scope' | 'deploy';
export type CheckpointStatus = 'ready-for-human' | 'approved' | 'rejected';

const VALID_KINDS: CheckpointKind[] = ['pre-commit', 'scope', 'deploy'];

export interface CheckpointFrontmatter {
  schema: string;
  version: string;
  id: string;
  slice: string;
  kind: CheckpointKind;
  status: CheckpointStatus;
  produced_by: { tool: string };
}

// --- Small deterministic helpers -------------------------------------------

/** yyyymmdd-hhmmss in local time, matching diff-report's timestampSlug idiom. */
export function timestampSlug(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Filesystem-safe slice token (same policy as the slice lease file naming). */
function safeSlice(sliceId: string): string {
  return String(sliceId).replace(/[^A-Za-z0-9._-]/g, '_');
}

function packetsDir(root: string): string {
  return path.join(root, '.discipline', 'packets');
}

/**
 * Write a file while holding the writer lock, synchronously. We use the sync
 * acquire/release pair (not the async withWriterLock helper) so the whole
 * checkpoint flow stays synchronous: the CLI calls process.exit() right after,
 * and an awaited-but-voided async lock could exit before its write/release
 * settled. try/finally guarantees the lock is released even on write failure.
 */
function writeUnderWriterLock(root: string, filePath: string, content: string): void {
  acquireWriterLock(root, { tool: 'discipline:checkpoint' });
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } finally {
    releaseWriterLock(root);
  }
}

/** Read the latest gate report if present; tolerate malformed JSON. */
function readGateSection(root: string): string {
  const reportPath = path.join(root, '.discipline', 'gate-report.json');
  if (!fs.existsSync(reportPath)) return 'No gate report (run `npm run discipline -- gate --json`).';
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      passed?: boolean;
      failed_checks?: string[];
      ts?: string;
    };
    const passed = report.passed === true ? 'PASSED' : 'FAILED';
    const failed = Array.isArray(report.failed_checks) && report.failed_checks.length
      ? report.failed_checks.map((c) => `  - ${c}`).join('\n')
      : '  (none)';
    const ts = report.ts ? ` at ${report.ts}` : '';
    return `passed: ${passed}${ts}\nfailed_checks:\n${failed}`;
  } catch {
    return 'Gate report present but unreadable (malformed JSON).';
  }
}

/** `git diff --stat HEAD` from the repo root; a clear note if git is unavailable. */
function readDiffStat(root: string): string {
  const proc = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd: root, encoding: 'utf-8' });
  if (proc.status !== 0) {
    const err = (proc.stderr || '').trim();
    return `git diff --stat HEAD unavailable${err ? `: ${err}` : ''}.`;
  }
  const out = (proc.stdout || '').trim();
  return out || '(no changes vs HEAD)';
}

// --- Frontmatter (self-contained; not the warn-only packet-meta validator) --

/**
 * Serialize checkpoint frontmatter deterministically. We emit a small, fixed
 * key set (no external YAML dump dependency) so the file shape is stable and
 * easy to rewrite in place on approve/reject.
 */
export function serializeFrontmatter(fm: CheckpointFrontmatter): string {
  return [
    '---',
    `schema: ${fm.schema}`,
    `version: ${fm.version}`,
    `id: ${fm.id}`,
    `slice: ${fm.slice}`,
    `kind: ${fm.kind}`,
    `status: ${fm.status}`,
    'produced_by:',
    `  tool: ${fm.produced_by.tool}`,
    '---',
  ].join('\n');
}

/**
 * Read the `status:` value from a checkpoint's frontmatter block. Returns null
 * if there is no leading `---` frontmatter or no status line inside it.
 */
export function readStatus(markdown: string): string | null {
  const text = markdown.replace(/^\uFEFF/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break; // end of frontmatter
    const m = lines[i].match(/^status:\s*(.+)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Rewrite the `status:` line inside the frontmatter block only. Pure string
 * transform; leaves the body untouched. Returns the new markdown, or throws if
 * there is no frontmatter status line to rewrite.
 */
export function rewriteStatus(markdown: string, next: CheckpointStatus): string {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') throw new Error('Checkpoint has no frontmatter.');
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) throw new Error('Checkpoint frontmatter is not terminated.');
  let replaced = false;
  for (let i = 1; i < closeIdx; i++) {
    if (/^status:\s*/.test(lines[i])) {
      lines[i] = `status: ${next}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) throw new Error('Checkpoint frontmatter has no status line.');
  return lines.join('\n');
}

/**
 * Replace the body's `## Decision` section content with the given text,
 * preserving the heading and anything after the next `## ` heading. Pure.
 */
export function fillDecision(markdown: string, decisionText: string): string {
  const lines = markdown.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Decision');
  if (idx === -1) {
    // No Decision section: append one rather than lose the record.
    return `${markdown.replace(/\s+$/, '')}\n\n## Decision\n${decisionText}\n`;
  }
  let endIdx = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { endIdx = i; break; }
  }
  const before = lines.slice(0, idx + 1);
  const after = lines.slice(endIdx);
  const rebuilt = [...before, decisionText, ...(after.length ? ['', ...after] : [])];
  return rebuilt.join('\n').replace(/\s+$/, '') + '\n';
}

// --- Create -----------------------------------------------------------------

export interface CreateOptions {
  slice: string;
  kind: CheckpointKind;
  summary?: string;
}

/**
 * Build the full checkpoint markdown (frontmatter + body). Pure given the
 * pre-read gate/diff strings, so it is testable without spawns.
 */
export function buildCheckpointMarkdown(
  fm: CheckpointFrontmatter,
  opts: { summary?: string; gate: string; diff: string },
): string {
  const summary = (opts.summary && opts.summary.trim()) || `${fm.kind} checkpoint for slice ${fm.slice}.`;
  return [
    serializeFrontmatter(fm),
    '',
    `# CHECKPOINT ${fm.kind.toUpperCase()} - slice ${fm.slice}`,
    '',
    '## Summary',
    summary,
    '',
    '## Gate',
    opts.gate,
    '',
    '## Diff',
    '```',
    opts.diff,
    '```',
    '',
    '## Decision',
    'PENDING',
    '',
  ].join('\n');
}

export function createCheckpoint(root: string, opts: CreateOptions): string {
  if (!VALID_KINDS.includes(opts.kind)) {
    disciplineError(`Invalid --kind "${opts.kind}". Use one of: ${VALID_KINDS.join(' | ')}.`);
  }
  if (!opts.slice) disciplineError('Missing --slice <id>.');

  const slug = timestampSlug();
  const slice = safeSlice(opts.slice);
  const fileName = `CHECKPOINT_${opts.kind.toUpperCase().replace(/-/g, '_')}_${slice}_${slug}.md`;
  const id = `checkpoint-${opts.kind}-${slice}-${slug}`;

  const fm: CheckpointFrontmatter = {
    schema: CHECKPOINT_SCHEMA,
    version: CHECKPOINT_VERSION,
    id,
    slice: opts.slice,
    kind: opts.kind,
    status: 'ready-for-human',
    produced_by: { tool: 'discipline:checkpoint' },
  };

  const gate = readGateSection(root);
  const diff = readDiffStat(root);
  const markdown = buildCheckpointMarkdown(fm, { summary: opts.summary, gate, diff });

  const dir = packetsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, fileName);

  // The writer lock guards concurrent artifact writers (watch, apply-patch).
  writeUnderWriterLock(root, outPath, markdown);

  try {
    appendLedger(root, { event: 'checkpoint_created', id, slice: opts.slice, kind: opts.kind, file: fileName });
  } catch {
    // Ledger is best-effort observability; never fail the command because of it.
  }

  disciplineInfo(`Checkpoint created: ${path.relative(root, outPath)} (status: ready-for-human).`);
  return outPath;
}

// --- Locate -----------------------------------------------------------------

/**
 * Resolve a packet argument to an absolute path. Accepts: an absolute/relative
 * path to an existing file, a bare filename in `.discipline/packets/`, or a
 * checkpoint id (matched against the `id:` frontmatter of checkpoint files).
 */
export function locateCheckpoint(root: string, arg: string): string | null {
  if (!arg) return null;
  // Direct path (absolute or relative to cwd/root).
  for (const candidate of [arg, path.resolve(root, arg), path.join(packetsDir(root), arg)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  // Otherwise treat it as an id and scan the packets dir.
  const dir = packetsDir(root);
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('CHECKPOINT_') || !name.endsWith('.md')) continue;
    const full = path.join(dir, name);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      const m = content.match(/^id:\s*(.+)\s*$/m);
      if (m && m[1].trim() === arg.trim()) return full;
    } catch {
      // Unreadable file: skip.
    }
  }
  return null;
}

// --- Decide (approve / reject) ----------------------------------------------

export interface DecideOptions {
  reason?: string;
}

function applyDecision(root: string, filePath: string, next: 'approved' | 'rejected', reason?: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const current = readStatus(content);
  if (current !== 'ready-for-human') {
    disciplineError(
      `Refusing to ${next === 'approved' ? 'approve' : 'reject'}: checkpoint status is "${current ?? 'unknown'}", ` +
        `not "ready-for-human". A checkpoint can only be decided once.`,
    );
  }

  const iso = new Date().toISOString();
  const verb = next === 'approved' ? 'APPROVED' : 'REJECTED';
  const decisionLines = [`${verb} at ${iso}`];
  if (reason && reason.trim()) decisionLines.push(`Reason: ${reason.trim()}`);
  const decisionText = decisionLines.join('\n');

  const updated = fillDecision(rewriteStatus(content, next), decisionText);

  writeUnderWriterLock(root, filePath, updated);

  const idMatch = updated.match(/^id:\s*(.+)\s*$/m);
  try {
    appendLedger(root, {
      event: 'checkpoint_decided',
      id: idMatch ? idMatch[1].trim() : path.basename(filePath),
      decision: next,
      file: path.basename(filePath),
      reason: reason && reason.trim() ? reason.trim() : null,
    });
  } catch {
    // Best-effort.
  }

  disciplineInfo(`Checkpoint ${next}: ${path.relative(root, filePath)}.`);
}

export function approveCheckpoint(root: string, arg: string, opts: DecideOptions = {}): void {
  const filePath = locateCheckpoint(root, arg);
  if (!filePath) disciplineError(`Checkpoint not found: "${arg}". Pass a packet file or its id.`);
  applyDecision(root, filePath, 'approved', opts.reason);
}

export function rejectCheckpoint(root: string, arg: string, opts: DecideOptions = {}): void {
  const filePath = locateCheckpoint(root, arg);
  if (!filePath) disciplineError(`Checkpoint not found: "${arg}". Pass a packet file or its id.`);
  applyDecision(root, filePath, 'rejected', opts.reason);
}

// --- CLI --------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  discipline:checkpoint -- create --slice <id> --kind pre-commit|scope|deploy [--summary "..."]',
  '  discipline:checkpoint -- approve <packet-file-or-id>',
  '  discipline:checkpoint -- reject  <packet-file-or-id> [--reason "..."]',
].join('\n');

export function runCheckpoint(root: string, argv: string[]): number {
  const args = minimist(argv, { string: ['slice', 'kind', 'summary', 'reason'] });
  const action = String(args._[0] ?? '');

  switch (action) {
    case 'create': {
      createCheckpoint(root, {
        slice: args.slice ? String(args.slice) : '',
        kind: (args.kind ? String(args.kind) : '') as CheckpointKind,
        summary: args.summary ? String(args.summary) : undefined,
      });
      return 0;
    }
    case 'approve': {
      const target = args._[1] !== undefined ? String(args._[1]) : '';
      if (!target) { disciplineWarn(`Missing <packet-file-or-id>.\n${USAGE}`); return 1; }
      approveCheckpoint(root, target);
      return 0;
    }
    case 'reject': {
      const target = args._[1] !== undefined ? String(args._[1]) : '';
      if (!target) { disciplineWarn(`Missing <packet-file-or-id>.\n${USAGE}`); return 1; }
      rejectCheckpoint(root, target, { reason: args.reason ? String(args.reason) : undefined });
      return 0;
    }
    default:
      disciplineWarn(`Unknown or missing action "${action}".\n${USAGE}`);
      return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2), { string: ['slice', 'kind', 'summary', 'reason', 'project-dir'] });
  const projectRoot = resolveProjectRoot(args['project-dir']);
  try {
    process.exit(runCheckpoint(projectRoot, process.argv.slice(2)));
  } catch (err) {
    disciplineError(err instanceof Error ? err.message : String(err));
  }
}
