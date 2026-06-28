/**
 * Discipline Loop Security Gate — No Secrets in Frontend
 *
 * Scans client-shipped code for API keys, server-only key references, and
 * secret-like literals. Server tooling and Edge Functions may reference env var
 * names, but still fail on hardcoded secret values.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'public', 'tools', pathJoin('supabase', 'functions')];
const CLIENT_ROOTS = ['src', 'public'];
// Client-shipped files that live at the repo root (mobile entrypoint, Expo config,
// EAS build config). A leaked service-role key here ships to the client just the
// same, so scan them explicitly — A4.
const CLIENT_ROOT_FILES = [
  'App.tsx', 'App.jsx', 'App.ts', 'App.js', 'index.tsx', 'index.jsx',
  'app.json', 'app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs',
  'eas.json',
];

const LITERAL_PATTERNS = [
  { pattern: /sb_secret_[a-zA-Z0-9_-]{20,}/, label: 'Hardcoded Supabase secret key' },
  { pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/, label: 'Hardcoded OpenAI project secret key' },
  { pattern: /sk-[a-zA-Z0-9_-]{32,}/, label: 'Hardcoded API secret key' },
  { pattern: /sk[-_]live[-_][a-zA-Z0-9]{20,}/, label: 'Hardcoded Stripe secret key' },
  { pattern: /sk[-_]test[-_][a-zA-Z0-9]{20,}/, label: 'Hardcoded Stripe test secret key' },
  { pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/, label: 'Hardcoded JWT-like token' },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: 'Hardcoded private key' },
  { pattern: /(?:secret|password|credential|token)\s*[:=]\s*['"][^'"]{10,}['"]/i, label: 'Possible hardcoded secret/password/token' },
];

const CLIENT_REFERENCE_PATTERNS = [
  // Any token containing SERVICE_ROLE (service_role, SUPABASE_SERVICE_ROLE_KEY,
  // and crucially the prefixed VITE_SERVICE_ROLE_KEY / EXPO_PUBLIC_SERVICE_ROLE_KEY
  // that the old `\bSERVICE_ROLE_KEY\b` missed — A4).
  { pattern: /service[_-]?role/i, label: 'Server-only service_role reference in client code' },
  { pattern: /process\.env\.(?!VITE_|EXPO_PUBLIC_)[A-Z0-9_]+/, label: 'Server-only process.env reference in client code' },
  { pattern: /process\.env\[\s*['"](?!VITE_|EXPO_PUBLIC_)[A-Za-z_]/, label: 'Server-only process.env[...] bracket reference in client code' },
  // Vite/WXT expose only public-prefixed vars; reading a non-public name via
  // import.meta.env (dot OR bracket notation) is an attempt to pull a server secret (A4).
  { pattern: /import\.meta\.env\.(?!(?:VITE_|EXPO_PUBLIC_|WXT_|NEXT_PUBLIC_|PUBLIC_)|(?:MODE|DEV|PROD|SSR|BASE_URL)\b)[A-Za-z_][A-Za-z0-9_]*/, label: 'Non-public import.meta.env reference in client code' },
  { pattern: /import\.meta\.env\[\s*['"](?!(?:VITE_|EXPO_PUBLIC_|WXT_|NEXT_PUBLIC_|PUBLIC_|MODE|DEV|PROD|SSR|BASE_URL))[A-Za-z_]/, label: 'Non-public import.meta.env[...] bracket reference in client code' },
];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function pathJoin(...parts) {
  return parts.join('/');
}

function walkDir(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.git') continue;
    if (statSync(full).isDirectory()) files.push(...walkDir(full));
    else if (SCAN_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) files.push(full);
  }
  return files;
}

function isClientFile(file) {
  const rel = relative('.', file).replace(/\\/g, '/');
  if (CLIENT_ROOT_FILES.includes(rel)) return true;
  return CLIENT_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

console.log('--- Security Gate: No Secrets in Frontend ---');

const files = ROOTS.flatMap((dir) => {
  try {
    return walkDir(dir);
  } catch {
    return [];
  }
});
for (const rootFile of CLIENT_ROOT_FILES) {
  try {
    if (statSync(rootFile).isFile()) files.push(rootFile);
  } catch {
    // not present in this lane; skip
  }
}
const violations = [];

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const patterns = isClientFile(file)
    ? [...LITERAL_PATTERNS, ...CLIENT_REFERENCE_PATTERNS]
    : LITERAL_PATTERNS;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

    for (const { pattern, label } of patterns) {
      if (pattern.test(line)) {
        violations.push({
          file: relative('.', file),
          line: i + 1,
          label,
          content: line.trim().slice(0, 100),
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log('\x1b[32m[PASS]\x1b[0m No secrets or server-only keys found in client-shipped code.');
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m Found ${violations.length} potential secret(s) in frontend code:\n`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    Issue: ${v.label}`);
  console.log(`    Line:  ${v.content}`);
  console.log('');
}
console.log('Fix: move secrets to server-side code or .env without public client prefixes.');
process.exit(1);
