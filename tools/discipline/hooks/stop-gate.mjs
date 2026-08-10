#!/usr/bin/env node
/**
 * Stop gate (Claude Code Stop hook).
 *
 * Purpose: the session should not end with edited code and a non-green gate.
 * When the agent tries to stop, if the git working tree has changed files and the
 * gate report is missing, stale, or failing, this hook BLOCKS the stop with a
 * reason telling the agent to run the machine-readable gate and fix the failures
 * (respecting the Repair Budget). Otherwise it allows.
 *
 * Untracked files count. They did not use to: a session that only created new
 * files was not "edited code". `gate --changed` made that wrong, because a new
 * file is exactly what its report can be missing, and a new source file is the
 * most likely thing a session leaves behind unverified. `git status --porcelain`
 * already respects .gitignore, so build output and local scratch never appear.
 *
 * Protocol (Claude Code Stop):
 *   - stdin: the hook JSON payload, including `stop_hook_active`.
 *   - stdout: to block, {"decision":"block","reason":"..."}; to allow, emit
 *     nothing (exit 0). `stop_hook_active` true means we already blocked once and
 *     Claude is looping: allow immediately (single nudge, loop guard).
 *
 * Freshness: we compare the gate report's mtime against the newest mtime among
 * the modified tracked files. If any tracked file was edited AFTER the last gate
 * report, the report no longer reflects the tree and we block. A malformed
 * report is treated as missing.
 *
 * Failure policy (documented): this hook fails OPEN (allows the stop) on any
 * internal error. Blocking a stop is intrusive; a broken Stop hook must not trap
 * the agent in the session. `git` missing or failing -> allow.
 *
 * Pure decision is exported (decide) so tests never need stdin or a real repo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REASON =
  'Stop blocked: the working tree has edited code but the gate is not verified green. ' +
  'Run `npm run discipline -- gate --json` (writes .discipline/gate-report.json) and fix any failures before ending. ' +
  'Repair Budget: after 2 attempts with the same error signature and no material change, stop and escalate instead of looping.';

const REASON_UNCOVERED =
  'Stop blocked: the gate report is green, but it was scoped to changed files that no longer cover this session. ' +
  'Files edited since (or outside) that run were never gated. Re-run `npm run discipline -- gate --changed` (or `gate --json` for the full gate).';

/**
 * Gate report schemas this hook can read. Duplicated from
 * tools/discipline/lib/gate-report-io.ts on purpose: hooks are plain Node with no
 * build step and no imports from the TS tooling. A schema that is not on this
 * list is treated as no report at all, never as a pass.
 */
const KNOWN_GATE_REPORT_SCHEMAS = ['discipline.gate_report.v1', 'discipline.gate_report.v2'];

/**
 * Parse `git status --porcelain` output into the files this session changed:
 * modified, added, and **untracked** ("?? path"). Ignored entries ("!! path")
 * are the only ones dropped, because git was told to ignore them.
 *
 * Untracked files are included on purpose. A brand-new source file is code the
 * gate has to have seen, and it is the case a scoped report is most likely to be
 * missing. Under the old rule a session could create `src/new-component.tsx`
 * after the gate and end cleanly.
 *
 * `.discipline/` is dropped: it is pipeline state written BY the pipeline, and
 * the gate report cannot appear in its own file list, so counting it would block
 * every session forever.
 *
 * Porcelain v1 format: 2 status chars, a space, then the path (rename shows
 * "orig -> new"; we take the destination). Callers must pass `-uall`, or git
 * collapses a new directory into a single `?? src/` entry that no file list can
 * ever match.
 */
export function parsePorcelainModified(porcelain) {
  const files = [];
  for (const rawLine of String(porcelain ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const x = rawLine[0];
    const y = rawLine[1];
    if (x === '!' && y === '!') continue; // ignored by git's own rules
    let rest = rawLine.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) rest = rest.slice(arrow + 4).trim();
    if (rest.replace(/\\/g, '/').startsWith('.discipline/')) continue; // pipeline state, not edited code
    // Porcelain may quote paths with special chars; strip surrounding quotes.
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) files.push(rest);
  }
  return files;
}

/**
 * Pure decision core. Inputs are already gathered (no spawns, no fs here) so it
 * is trivially testable:
 *   - stopHookActive: payload.stop_hook_active (loop guard).
 *   - modifiedFiles: tracked files modified/added (from parsePorcelainModified).
 *   - gateReport: { exists, mtimeMs, passed } describing .discipline/gate-report.json.
 *   - newestModifiedMtimeMs: newest mtime among modifiedFiles (or 0).
 * Returns { block: boolean, reason: string }.
 */
export function decideCore({ stopHookActive, modifiedFiles, gateReport, newestModifiedMtimeMs }) {
  if (stopHookActive) return { block: false, reason: '' };
  if (!modifiedFiles || modifiedFiles.length === 0) return { block: false, reason: '' };

  // Edited code present: the gate must exist, be at least as new as the newest
  // edit, and have passed. Any of those failing blocks the stop.
  if (!gateReport || !gateReport.exists) return { block: true, reason: REASON };
  if (gateReport.passed === false) return { block: true, reason: REASON };
  if (typeof gateReport.mtimeMs === 'number' && gateReport.mtimeMs < (newestModifiedMtimeMs ?? 0)) {
    return { block: true, reason: REASON };
  }
  // A v2 report says which files it was scoped to. A green report that never saw
  // a file the session edited is green about something else: mtimes only catch
  // that when the clocks agree, and the file list is the thing that was measured.
  if (Array.isArray(gateReport.files)) {
    const covered = new Set(gateReport.files);
    const uncovered = modifiedFiles.filter((f) => !covered.has(String(f).replace(/\\/g, '/')));
    if (uncovered.length) return { block: true, reason: `${REASON_UNCOVERED} Not covered: ${uncovered.slice(0, 5).join(', ')}` };
  }
  return { block: false, reason: '' };
}

/** Read + parse the gate report, tolerating a missing or malformed file. */
function readGateReport(root) {
  const reportPath = path.join(root, '.discipline', 'gate-report.json');
  let stat;
  try {
    stat = fs.statSync(reportPath);
  } catch {
    return { exists: false, mtimeMs: 0, passed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch {
    // Malformed JSON: treat as missing (do not trust it as green).
    return { exists: false, mtimeMs: 0, passed: false };
  }
  // An unknown schema is not read as a pass: its `passed` may not mean what this
  // hook assumes it means. Treat it as no report, which blocks.
  if (!KNOWN_GATE_REPORT_SCHEMAS.includes(parsed?.schema)) {
    return { exists: false, mtimeMs: 0, passed: false };
  }
  const files = Array.isArray(parsed?.files) ? parsed.files.filter((f) => typeof f === 'string') : null;
  return { exists: true, mtimeMs: stat.mtimeMs, passed: parsed?.passed === true, files };
}

/** Newest mtime (ms) among the given files under root; missing files are skipped. */
function newestMtime(root, files) {
  let newest = 0;
  for (const rel of files) {
    try {
      const m = fs.statSync(path.join(root, rel)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // File may have been deleted (a "D " status): skip it.
    }
  }
  return newest;
}

/**
 * Gather state from the real repo and decide. Separated from decideCore so the
 * pure logic stays testable. Fails OPEN: on any spawn/fs error, returns allow.
 */
export function decide(payload, root) {
  try {
    const stopHookActive = payload?.stop_hook_active === true;
    if (stopHookActive) return { block: false, reason: '' };

    // `-uall` lists every untracked FILE. Without it git collapses a new directory
    // into one `?? src/` entry, which no report's file list can ever match, and the
    // coverage check below would block every session that created a folder.
    const proc = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf-8' });
    if (proc.status !== 0 || typeof proc.stdout !== 'string') {
      return { block: false, reason: '' }; // git missing/failed -> allow
    }
    const modifiedFiles = parsePorcelainModified(proc.stdout);
    const gateReport = readGateReport(root);
    const newestModifiedMtimeMs = newestMtime(root, modifiedFiles);
    return decideCore({ stopHookActive, modifiedFiles, gateReport, newestModifiedMtimeMs });
  } catch {
    return { block: false, reason: '' };
  }
}

// --- Hook I/O ---------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Total parse failure: fail OPEN (allow) and log one line.
    process.stderr.write('[discipline stop-gate] could not parse hook payload; allowing stop.\n');
    process.exit(0);
    return;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = decide(payload, root);
  if (result.block) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }));
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
