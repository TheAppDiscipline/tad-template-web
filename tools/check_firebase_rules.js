/**
 * Discipline Loop Security Gate — Firebase Security Rules Authorization
 *
 * The Firebase lane had no authorization gate (GAP11/F2): `check_rls.js` SKIPs when
 * BACKEND_PROVIDER is not Supabase, and Firestore/Storage rules were never linted.
 * A rule like `allow read: if request.auth != null;` lets ANY signed-in user read
 * every document — the Firebase equivalent of `USING (auth.uid() IS NOT NULL)`.
 *
 * This gate FAILS when an `allow` rule is granted on pure authentication presence
 * (request.auth != null / a signed-in helper) with no ownership/membership scope.
 *
 * Scans firebase/firestore.rules, firebase/storage.rules and root *.rules.
 * Verify the real behaviour with the emulator: `firebase emulators:exec` running a
 * negative test (user B must NOT read user A's doc). This static gate is the floor.
 *
 * Exit 0 = pass/skip, Exit 1 = pure-auth allow rule detected.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const RULES_FILES = [
  path.join('firebase', 'firestore.rules'),
  path.join('firebase', 'storage.rules'),
  'firestore.rules',
  'storage.rules',
];

const ALLOW_MARKER = 'discipline-loop:allow-public';

// Normalize a condition for comparison: strip balanced outer parens, drop whitespace.
function isBalanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

function normalize(cond) {
  let c = cond.trim();
  while (c.startsWith('(') && c.endsWith(')') && isBalanced(c.slice(1, -1))) {
    c = c.slice(1, -1).trim();
  }
  return c.replace(/\s+/g, '');
}

// An expression that only asserts "someone is signed in", with no ownership binding.
const PURE_AUTH_LITERALS = new Set([
  'request.auth!=null',
  'null!=request.auth',
  'request.auth.uid!=null',
  'null!=request.auth.uid',
  'request.auth.uid is string'.replace(/\s+/g, ''),
]);

// A function BODY is an ownership signal only if it inspects the document/owner:
// reads resource data, does a document lookup, or compares request.auth.uid to a
// field. A trivial helper (`return true`) is NOT ownership — that was the bypass.
function bodyIsOwnership(body) {
  return /resource\.data/i.test(body)
    || /\b(?:exists|get|getAfter)\s*\(/i.test(body)
    || /request\.auth\.uid\s*==|==\s*request\.auth\.uid/i.test(body);
}

// Collect user-defined functions, classified by what their body actually does:
//   authOnly   — body is just an auth-presence check (signedIn() -> request.auth != null)
//   ownership  — body inspects the document/owner (isMember() -> exists(...))
// Helpers that are neither (e.g. `alwaysTrue() { return true; }`) count as NEITHER,
// so they cannot launder a pure-auth rule into looking ownership-scoped.
function collectFunctions(content) {
  const authOnly = new Set();
  const ownership = new Set();
  const fnRe = /function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{\s*return\s+([\s\S]*?);\s*\}/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    if (PURE_AUTH_LITERALS.has(normalize(body))) authOnly.add(name);
    else if (bodyIsOwnership(body)) ownership.add(name);
  }
  return { authOnly, ownership };
}

function callsAny(condition, names) {
  for (const name of names) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(condition)) return true;
  }
  return false;
}

// "Auth presence": the condition asserts the caller is merely signed in.
function mentionsAuth(condition, authOnlyFns) {
  return /request\.auth\b/i.test(condition) || callsAny(condition, authOnlyFns);
}

// "Ownership signal": the condition actually checks the document/owner — it reads
// resource data, does a document lookup, or calls a function whose body inspects
// ownership (a trivial/unknown helper does NOT count).
function hasOwnershipSignal(condition, ownershipFns) {
  if (/resource\.data/i.test(condition)) return true;
  if (/\b(?:exists|get|getAfter)\s*\(/i.test(condition)) return true;
  return callsAny(condition, ownershipFns);
}

// Unsafe when the rule grants on authentication presence with NO ownership signal.
// Catches `request.auth != null`, `request.auth != null && true`, `signedIn()`,
// `request.auth.uid != null`, etc. — not just an exact literal match.
function isAuthOnly(condition, fns) {
  return mentionsAuth(condition, fns.authOnly) && !hasOwnershipSignal(condition, fns.ownership);
}

function lintFile(relFile, content) {
  const violations = [];
  const fns = collectFunctions(content);
  const lines = content.split('\n');

  // allow <ops>: if <condition>;
  const allowRe = /allow\s+[a-z,\s]+:\s*if\s+([\s\S]*?);/gi;
  let m;
  while ((m = allowRe.exec(content)) !== null) {
    const condition = m[1];
    const lineIdx = content.substring(0, m.index).split('\n').length - 1;
    const line = lines[lineIdx] || '';
    if (line.includes(ALLOW_MARKER)) continue;
    if (isAuthOnly(condition, fns)) {
      violations.push({
        file: relFile,
        line: lineIdx + 1,
        condition: condition.trim().replace(/\s+/g, ' ').slice(0, 100),
      });
    }
  }
  return violations;
}

console.log('--- Security Gate: Firebase Rules Authorization ---');

const present = RULES_FILES
  .map((rel) => ({ rel, abs: path.join(ROOT, rel) }))
  .filter(({ abs }) => fs.existsSync(abs));

if (present.length === 0) {
  console.log('\x1b[33m[SKIP]\x1b[0m No firebase/*.rules files found (non-Firebase project).');
  process.exit(0);
}

const allViolations = [];
for (const { rel, abs } of present) {
  allViolations.push(...lintFile(rel, fs.readFileSync(abs, 'utf8')));
}

if (allViolations.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m ${present.length} rules file(s); every allow rule is ownership-scoped (no pure request.auth != null).`);
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m ${allViolations.length} allow rule(s) gated only on authentication (no ownership):\n`);
for (const v of allViolations) {
  console.log(`  ${v.file}:${v.line}`);
  console.log(`    Rule: allow ... if ${v.condition}`);
  console.log('');
}
console.log('Fix: scope each allow to ownership/membership, e.g.');
console.log('  allow read: if request.auth.uid == resource.data.user_id;');
console.log(`Intentional public-auth rule? add "// ${ALLOW_MARKER}" on the same line.`);
console.log('Then prove it with the emulator: firebase emulators:exec "<negative cross-user test>".');
console.log('Reference: Discipline Loop NN #17.2 Security Baseline (Firebase Rules).');
process.exit(1);
