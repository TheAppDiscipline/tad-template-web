#!/usr/bin/env npx tsx
/**
 * discipline:step4-origin - resolve the Step 4 origin (input | reentry | feedback | hardening)
 * from the SAME shared resolver the watcher uses. Fail-loud: it decides only when there is
 * exactly one coherent origin; otherwise it stops and reports.
 *
 * Usage:
 *   npm run discipline:step4-origin -- [--mode 4|4-reentry|4-feedback|4-hardening] [--json] [--project-dir <path>]
 *
 * Exit codes (consumed by the /discipline-step4 skill):
 *   0  chosen    - proceed with the reported mode
 *   3  ambiguous - two or more reentry handoffs; re-run with --mode
 *   2  invalid   - resolved mode is not coherent (or nothing to expand)
 */
import minimist from 'minimist';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { resolveStep4Origin, type Step4Mode } from './lib/step4-origin.js';
import { disciplineInfo, disciplineWarn } from './lib/types.js';

const VALID_MODES: Step4Mode[] = ['4', '4-reentry', '4-feedback', '4-hardening'];

const args = minimist(process.argv.slice(2));
const root = resolveProjectRoot(args['project-dir']);
const asJson = Boolean(args.json);

let requestedMode: Step4Mode | undefined;
if (args.mode !== undefined) {
  const m = String(args.mode);
  if (!VALID_MODES.includes(m as Step4Mode)) {
    console.error(`discipline:step4-origin: --mode must be one of ${VALID_MODES.join(' | ')} (got "${m}").`);
    process.exit(2);
  }
  requestedMode = m as Step4Mode;
}

const result = resolveStep4Origin(root, { mode: requestedMode });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (result.status === 'chosen') {
    disciplineInfo(`Step 4 origin: ${result.mode}`);
    for (const line of result.evidence) disciplineInfo(`  ${line}`);
  } else if (result.status === 'ambiguous') {
    disciplineWarn(`Step 4 origin is AMBIGUOUS: ${result.candidates?.join(', ')}`);
    for (const line of result.evidence) disciplineWarn(`  ${line}`);
  } else {
    disciplineWarn(`Step 4 origin is INVALID: ${result.reason ?? 'unknown'}`);
    for (const line of result.evidence) disciplineWarn(`  ${line}`);
  }
}

process.exit(result.status === 'chosen' ? 0 : result.status === 'ambiguous' ? 3 : 2);
