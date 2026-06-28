/**
 * Discipline Loop Security Gate — No CORS Wildcard
 *
 * Scans server-side code for `Access-Control-Allow-Origin: *` or equivalent.
 * Wildcard CORS in production is a security risk — origins must be explicit.
 *
 * Heuristic: scan known server dirs (api/, server/, functions/, pages/api/)
 * for CORS headers with wildcard values.
 *
 * Exceptions: files explicitly named *.test.* or under tests/ are exempt.
 *
 * Enforces Discipline Loop NN #17.3 (Security Baseline: CORS explicito, no wildcard).
 *
 * Exit 0 = pass, Exit 1 = wildcard CORS detected.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Directories where server-side code typically lives. Add more if the project
// uses a non-standard layout (Hono workers, FastAPI backend, etc.).
const SERVER_DIRS = [
  'api',
  'server',
  'backend',
  'workers',
  'hono',
  'functions',
  'pages/api',
  'app/api',
  path.join('src', 'api'),
  path.join('src', 'server'),
  path.join('src', 'backend'),
  path.join('src', 'workers'),
  path.join('supabase', 'functions'),
];

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go']);

// Wildcard CORS patterns. Case-insensitive, tolerant of whitespace/quotes.
const WILDCARD_PATTERNS = [
  {
    pattern: /access-control-allow-origin['":\s]+['"]\*['"]/i,
    label: 'Access-Control-Allow-Origin header set to wildcard "*"',
  },
  {
    pattern: /['"]?origin['"]?\s*:\s*['"]\*['"]/i,
    label: 'CORS config origin set to "*"',
  },
  {
    pattern: /cors\s*\(\s*\{\s*origin\s*:\s*true/i,
    label: 'CORS middleware with `origin: true` (reflects request origin, effectively wildcard)',
  },
  {
    // 2-arg setHeader/header form: res.setHeader('Access-Control-Allow-Origin', '*')
    pattern: /(?:set)?header\s*\(\s*['"]access-control-allow-origin['"]\s*,\s*['"]\*['"]/i,
    label: 'setHeader/header("Access-Control-Allow-Origin", "*") — wildcard via 2-arg form',
  },
  {
    // cors() with no options defaults to Access-Control-Allow-Origin: * (permissive).
    pattern: /\bcors\s*\(\s*\)/i,
    label: 'cors() called with no options (defaults to allow all origins)',
  },
];

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

console.log('--- Security Gate: No CORS Wildcard ---');

const files = [];
for (const dir of SERVER_DIRS) {
  files.push(...walkDir(path.join(ROOT, dir)));
}

if (files.length === 0) {
  console.log('\x1b[33m[SKIP]\x1b[0m No server-side directories found (pure frontend project).');
  process.exit(0);
}

const violations = [];
for (const file of files) {
  if (isTestFile(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('#')) continue;
    for (const { pattern, label } of WILDCARD_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          label,
          content: line.trim().slice(0, 120),
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m Scanned ${files.length} server file(s); no wildcard CORS detected.`);
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m ${violations.length} wildcard CORS occurrence(s):\n`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    Issue: ${v.label}`);
  console.log(`    Line:  ${v.content}`);
  console.log('');
}
console.log('Fix: list allowed origins explicitly, e.g. `origin: [process.env.APP_URL, "https://app.example.com"]`.');
console.log('Reference: Discipline Loop NN #17.3 Security Baseline.');
process.exit(1);
