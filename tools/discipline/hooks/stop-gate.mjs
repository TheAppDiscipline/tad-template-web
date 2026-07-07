#!/usr/bin/env node
/**
 * Stop gate (Claude Code Stop hook).
 *
 * Purpose: the session should not end with edited code and a non-green gate.
 * When the agent tries to stop, if the git working tree has modified/added
 * tracked files and the gate report is missing, stale, or failing, this hook
 * BLOCKS the stop with a reason telling the agent to run the machine-readable
 * gate and fix the failures (respecting the Repair Budget). Otherwise it allows.
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

/**
 * Parse `git status --porcelain` output into the tracked files that are
 * modified or added (staged or unstaged). Untracked-only entries ("?? path")
 * are ignored: a session that only created new untracked files is not "edited
 * code" for the purpose of the gate.
 *
 * Porcelain v1 format: 2 status chars, a space, then the path (rename shows
 * "orig -> new"; we take the destination).
 */
export function parsePorcelainModified(porcelain) {
  const files = [];
  for (const rawLine of String(porcelain ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const x = rawLine[0];
    const y = rawLine[1];
    if (x === '?' && y === '?') continue; // untracked
    if (x === '!' && y === '!') continue; // ignored
    let rest = rawLine.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) rest = rest.slice(arrow + 4).trim();
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
  let passed = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    passed = parsed?.passed === true;
  } catch {
    // Malformed JSON: treat as missing (do not trust it as green).
    return { exists: false, mtimeMs: 0, passed: false };
  }
  return { exists: true, mtimeMs: stat.mtimeMs, passed };
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

    const proc = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' });
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
