/**
 * Discipline Loop Query Discipline Gate — List Queries Must Bound
 *
 * Heuristic: finds Supabase query chains like `.from(x).select(...)` that
 * do not include a bounding modifier (`.limit()`, `.range()`, `.single()`,
 * or `.maybeSingle()`). Flags them as potential unbounded reads.
 *
 * This is a SEMI warning (fuzzy heuristic with --strict option).
 *
 * Enforces Discipline Loop NN #23.1 (Query Discipline: listas con limit, sin N+1).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const STRICT = process.argv.includes('--strict');

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', 'coverage', '.vite']);

// Modifiers that bound the result set (any presence counts as "bounded").
const BOUNDING_MODIFIERS = [
  '.limit(',
  '.range(',
  '.single(',
  '.maybeSingle(',
  '.count(',
  // `.limit` passed through a helper or template variable
  'limit:',
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...walk(full));
      continue;
    }
    if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function findQueryChains(content) {
  // Locate `.from(...)` positions; for each, scan forward up to 800 chars
  // or until a terminating `;` / closing brace matching the chain depth.
  const chains = [];
  const re = /\.from\s*\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const startIdx = match.index;
    // Slice forward a window that likely contains the chain terminator.
    const window = content.slice(startIdx, startIdx + 1200);
    // Only consider chains that include .select (we care about reads).
    if (!/\.select\s*\(/.test(window)) continue;
    chains.push({
      table: match[1],
      startIdx,
      window,
    });
  }
  return chains;
}

function chainIsBounded(chain) {
  for (const marker of BOUNDING_MODIFIERS) {
    if (chain.window.includes(marker)) return true;
  }
  return false;
}

function lineOfIndex(content, idx) {
  return content.slice(0, idx).split('\n').length;
}

console.log('--- Query Discipline Gate: Unbounded Lists ---');

if (!fs.existsSync(SRC_DIR)) {
  console.log('\x1b[33m[SKIP]\x1b[0m No src/ directory.');
  process.exit(0);
}

const files = walk(SRC_DIR);
const violations = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const chains = findQueryChains(content);
  for (const chain of chains) {
    if (chainIsBounded(chain)) continue;
    const lineNum = lineOfIndex(content, chain.startIdx);
    const lineContent = content.split('\n')[lineNum - 1] ?? '';
    violations.push({
      file: path.relative(ROOT, file),
      line: lineNum,
      table: chain.table,
      content: lineContent.trim().slice(0, 120),
    });
  }
}

if (violations.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m Scanned ${files.length} file(s); all list queries appear bounded.`);
  process.exit(0);
}

const severity = STRICT ? '[FAIL]' : '[WARN]';
const color = STRICT ? '\x1b[31m' : '\x1b[33m';
console.log(`${color}${severity}\x1b[0m ${violations.length} potentially unbounded list query (queries) detected:\n`);
for (const v of violations.slice(0, 30)) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    Table: ${v.table}`);
  console.log(`    Line:  ${v.content}`);
  console.log('');
}
if (violations.length > 30) {
  console.log(`  ... and ${violations.length - 30} more.`);
}
console.log('Fix: add `.limit(<N>)`, `.range(from, to)`, `.single()`, or `.maybeSingle()` to every .select() chain that could return a list.');
console.log('Reference: Discipline Loop NN #23.1 Query Discipline.');
process.exit(STRICT ? 1 : 0);
