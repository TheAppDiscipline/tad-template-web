/**
 * Discipline Loop Security Gate — No HTTP URLs in Production Paths
 *
 * Scans for hardcoded `http://` URLs (non-localhost, non-example) in
 * production-bound code/config. All production traffic must be HTTPS.
 *
 * Exemptions:
 *   - localhost / 127.0.0.1 / 0.0.0.0 / example.com (doc URLs)
 *   - *.test.*, *.spec.*, tests/** (test fixtures)
 *   - comments
 *
 * Enforces Discipline Loop NN #17.4 (Security Baseline: HTTPS obligatorio en produccion).
 *
 * Exit 0 = pass, Exit 1 = production HTTP reference detected.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const SCAN_DIRS = [
  'src',
  'api',
  'server',
  'functions',
  path.join('supabase', 'config'),
];

const SCAN_ROOT_FILES = [
  'vercel.json',
  'netlify.toml',
  'wrangler.toml',
  'app.json',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
];

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.toml', '.yaml', '.yml']);

const EXEMPT_HOSTS = /(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.com|example\.org|schema\.org|w3\.org|mozilla\.org)/i;

// Match http://... until quote/space/newline. Allow minor variations.
const HTTP_REGEX = /\bhttp:\/\/[^\s"'`<>)]+/gi;

function walkDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDir(full));
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(file) {
  const rel = path.relative(ROOT, file);
  if (rel.includes(path.sep + 'tests' + path.sep)) return true;
  const base = path.basename(file);
  return /\.(test|spec)\.[a-z]+$/i.test(base);
}

function stripLineComment(line) {
  // Strip a trailing `//` line comment, but only when the `//` actually starts a
  // comment: it must NOT be a URL scheme (`http://`, i.e. preceded by ':') and NOT
  // sit inside a string literal (single, double or backtick quotes). The previous
  // version only guarded double quotes, so `const u = 'http://insecure.example'`
  // was truncated to `const u = 'http:` and the http:// URL was never flagged.
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '"') inDouble = false; continue; }
    if (inBacktick) { if (c === '`') inBacktick = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') { inBacktick = true; continue; }
    if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
      return line.slice(0, i);
    }
  }
  return line;
}

console.log('--- Security Gate: No HTTP in Production Paths ---');

const files = [];
for (const dir of SCAN_DIRS) files.push(...walkDir(path.join(ROOT, dir)));
for (const f of SCAN_ROOT_FILES) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) files.push(full);
}

const violations = [];
for (const file of files) {
  if (isTestFile(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripLineComment(raw);
    if (!line.trim()) continue;
    if (line.trim().startsWith('*') || line.trim().startsWith('#')) continue;
    const matches = line.match(HTTP_REGEX);
    if (!matches) continue;
    for (const match of matches) {
      if (EXEMPT_HOSTS.test(match)) continue;
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        url: match,
        content: raw.trim().slice(0, 120),
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m Scanned ${files.length} file(s); no HTTP URLs in production paths.`);
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m ${violations.length} HTTP URL(s) in production paths:\n`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    URL:   ${v.url}`);
  console.log(`    Line:  ${v.content}`);
  console.log('');
}
console.log('Fix: replace http:// with https:// or move to .env / localhost-only paths.');
console.log('Reference: Discipline Loop NN #17.4 Security Baseline (HTTPS obligatorio en produccion).');
process.exit(1);
