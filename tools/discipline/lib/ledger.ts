import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Append-only JSONL ledger for pipeline runs, plus a stable error signature.
 *
 * Files: `.discipline/ledger/YYYY-MM.jsonl`, one compact JSON object per line.
 * Every event auto-gets a UTC timestamp and a per-process sequence number, so a
 * single run's events keep their relative order even if timestamps collide.
 *
 * errorSignature() normalizes away the volatile parts of an error (absolute
 * paths, line:col numbers, ISO timestamps, whitespace, case) so the same
 * underlying failure hashes to the same value. That makes the Repair Budget
 * rule ("2 identical signatures with no material change -> stop") computable.
 *
 * No network, no external dependency: sha1 comes from node:crypto.
 */

let seqCounter = 0;

export type LedgerEvent = Record<string, unknown>;

function ledgerFilePath(root: string, date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return path.join(root, '.discipline', 'ledger', `${yyyy}-${mm}.jsonl`);
}

/**
 * Append one event as a single JSON line to the current month's ledger file.
 * The stored object is {ts, seq, ...event}; ts and seq are always injected and
 * take precedence so callers cannot accidentally omit them.
 */
export function appendLedger(root: string, event: LedgerEvent): void {
  const filePath = ledgerFilePath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const record = {
    ...event,
    ts: new Date().toISOString(),
    seq: seqCounter++,
  };
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}

/**
 * Normalize a single line so cosmetic differences do not change the hash:
 * strip absolute Windows/POSIX paths, strip :line:col and :line numbers, strip
 * ISO-8601 timestamps, collapse runs of whitespace, trim, and lowercase.
 */
function normalizeErrorText(text: string): string {
  return text
    // ISO timestamps: 2026-07-05T12:34:56(.789)(Z|+02:00)
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi, '<ts>')
    // Absolute Windows paths: E:\a\b\c or E:/a/b/c
    .replace(/[a-z]:[\\/][^\s:]*/gi, '<path>')
    // Absolute POSIX paths: /a/b/c (at least one segment)
    .replace(/(?:^|[\s(])\/(?:[^\s/:]+\/)*[^\s/:]+/g, ' <path>')
    // Trailing :line:col or :line coordinates on any remaining token
    .replace(/:\d+(?::\d+)?/g, ':<n>')
    // Collapse whitespace and normalize case
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Stable sha1 hex over the (normalized) first failing step and first error
 * line. Two runs that fail the same way in different working directories, on
 * different line numbers, or at different times produce the same signature; a
 * different failing step produces a different signature.
 */
export function errorSignature(firstFailingStep: string, firstErrorLine: string): string {
  const normalized = `${normalizeErrorText(firstFailingStep)}\n${normalizeErrorText(firstErrorLine)}`;
  return crypto.createHash('sha1').update(normalized, 'utf-8').digest('hex');
}
