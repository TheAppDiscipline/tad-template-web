/**
 * Discipline Loop Security Gate — Dependency Audit (production deps)
 *
 * Runs `npm audit --omit=dev --audit-level=high` and FAILS if any high/critical
 * advisory affects a *shipped* (production) dependency. Build-only devDependency
 * advisories are tracked separately (they never reach users) — see KNOWN-ISSUES.
 *
 * If the registry is unreachable (offline sandbox), it SKIPs rather than failing
 * the whole launch gate on a network hiccup; CI runs it with network.
 *
 * Part of `gate:launch` (M7). Exit 0 = pass/skip, Exit 1 = high/critical in prod deps.
 */

import { spawnSync } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log('--- Security Gate: npm audit (production deps, high+) ---');

const res = spawnSync(npmCmd, ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

let parsed;
try {
  parsed = JSON.parse(res.stdout);
} catch {
  console.log('\x1b[33m[SKIP]\x1b[0m Could not parse `npm audit` output (offline registry?). Run in CI with network access.');
  if (res.stderr) console.log('  ' + res.stderr.split('\n').slice(0, 3).join('\n  '));
  process.exit(0);
}

const vulns = parsed?.metadata?.vulnerabilities ?? {};
const high = vulns.high ?? 0;
const critical = vulns.critical ?? 0;

if (high === 0 && critical === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m No high/critical advisories in production dependencies (moderate: ${vulns.moderate ?? 0}, low: ${vulns.low ?? 0}).`);
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m ${critical} critical + ${high} high advisory(ies) in production dependencies.`);
const advisories = parsed?.vulnerabilities ?? {};
for (const [name, info] of Object.entries(advisories)) {
  if (info?.severity === 'high' || info?.severity === 'critical') {
    console.log(`  ${name} — ${info.severity}`);
  }
}
console.log('Fix: `npm audit fix`, bump the offending dependency, or replace it before launch.');
console.log('(devDependency-only advisories do not ship; track them in KNOWN-ISSUES instead of blocking here.)');
process.exit(1);
