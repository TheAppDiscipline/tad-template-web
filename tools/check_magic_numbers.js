/**
 * Discipline Loop Visual Gate — No Magic Numbers in UI
 *
 * Heuristic scan for hardcoded typography / spacing / shadow values inside
 * JSX style props or styled-component / template-literal CSS. The goal is
 * to catch drift away from the design tokens (NN #9).
 *
 * This check is a SEMI warning (fuzzy heuristic). It exits 0 on violations
 * but prints them prominently; a project can gate it to hard-error by
 * chaining with `npm run check-magic -- --strict` (see CLI flag below).
 *
 * Enforces Discipline Loop NN #9 (UI Token Discipline beyond colors).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const STRICT = process.argv.includes('--strict');

const ALLOWED_FILES = new Set([
  path.normalize(path.join(SRC_DIR, 'styles', 'tokens.css')),
  path.normalize(path.join(SRC_DIR, 'styles', 'tokens.ts')),
]);

const SCAN_EXT = new Set(['.tsx', '.jsx', '.ts']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', 'coverage', '.vite']);

// Props where inline numeric px values usually indicate magic numbers.
const STYLE_PROPS = [
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'padding',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'gap',
  'rowGap',
  'columnGap',
  'borderRadius',
  'boxShadow',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
];

// Exempt: 0, 1 (often booleans / edges), values inside tokens.*.
const EXEMPT_VALUES = new Set(['0', '1', '-1']);

// Match: propName: 16 | propName: "16px" | propName: '1.5rem'
const PROP_RE = new RegExp(
  `\\b(${STYLE_PROPS.join('|')})\\s*:\\s*(?:(-?\\d+(?:\\.\\d+)?)(?:px|rem|em|%)?|(['"])-?\\d+(?:\\.\\d+)?(?:px|rem|em|%)?\\3)`,
  'g'
);

// Match: style={{ fontSize: 16 }} but allow tokens.text.md or vars(--...)
const TOKEN_CALL = /tokens?\.|var\s*\(/;

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
    if (!SCAN_EXT.has(path.extname(entry.name))) continue;
    const normalized = path.normalize(full);
    if (ALLOWED_FILES.has(normalized)) continue;
    out.push(full);
  }
  return out;
}

console.log('--- Visual Gate: No Magic Numbers in UI ---');

if (!fs.existsSync(SRC_DIR)) {
  console.log('\x1b[33m[SKIP]\x1b[0m No src/ directory.');
  process.exit(0);
}

const files = walk(SRC_DIR);
const violations = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    // Skip entire line if it references a token.
    if (TOKEN_CALL.test(line)) continue;

    let match;
    const re = new RegExp(PROP_RE.source, 'g');
    while ((match = re.exec(line)) !== null) {
      const prop = match[1];
      const rawValue = match[2] ?? match[0];
      const numericPart = (rawValue ?? '').toString().replace(/['"]/g, '').replace(/(px|rem|em|%)$/, '');
      if (EXEMPT_VALUES.has(numericPart)) continue;
      violations.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        prop,
        value: rawValue,
        content: line.trim().slice(0, 120),
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m Scanned ${files.length} UI file(s); no magic numbers detected in style props.`);
  process.exit(0);
}

const severity = STRICT ? '[FAIL]' : '[WARN]';
const color = STRICT ? '\x1b[31m' : '\x1b[33m';
console.log(`${color}${severity}\x1b[0m ${violations.length} magic-number occurrence(s) in UI style props:\n`);
for (const v of violations.slice(0, 30)) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    Prop:  ${v.prop}  =  ${v.value}`);
  console.log(`    Line:  ${v.content}`);
  console.log('');
}
if (violations.length > 30) {
  console.log(`  ... and ${violations.length - 30} more.`);
}
console.log('Fix: replace literal values with tokens from src/styles/tokens.{ts,css}.');
console.log('Reference: Discipline Loop NN #9 UI Token Discipline (typography/spacing/shadows).');

process.exit(STRICT ? 1 : 0);
