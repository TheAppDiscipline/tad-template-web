import * as fs from 'node:fs';
import * as path from 'node:path';
import minimist from 'minimist';
import yaml from 'js-yaml';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { disciplineError, disciplineInfo } from './lib/types.js';

/**
 * Gate D/E — Scorecard-as-Code Validator
 *
 * Reads .discipline/scorecard.yaml and applies the validation rules documented
 * in the vault at 65a - Launch vs PROD + Scorecard as Code:
 *
 *   --mode=launch  (Gate D, pre-public release)
 *     - launch.critical items must be `done`; never `deferred`.
 *     - launch.recommended `deferred` must have `deferred_reason` + `expires_on` not expired.
 *
 *   --mode=prod    (Gate E, pre-commercial activation)
 *     - Everything above PLUS
 *     - prod.critical items must be `done`; never `deferred` (unless blocking: false, rare).
 *     - prod.conditional items evaluate `applies_when` against discipline.md switches.
 *
 * Exit 0 = gate passes, Exit 1 = gate fails.
 */

type ItemStatus = 'done' | 'not_done' | 'deferred' | 'not_applicable';
type Severity = 'CRITICAL' | 'RECOMMENDED';
export type ScorecardMode = 'launch' | 'prod';

interface ScorecardItem {
  id: string;
  name: string;
  status: ItemStatus;
  severity?: Severity;
  blocking?: boolean;
  evidence?: string | null;
  notes?: string | null;
  deferred_reason?: string;
  expires_on?: string;
  applies_when?: string;
  sop?: string;
}

export interface Scorecard {
  meta?: {
    project?: string;
    version?: string;
    profile_target?: 'LAUNCH' | 'PROD';
    last_updated?: string;
    next_review?: string;
  };
  launch?: {
    critical?: ScorecardItem[];
    recommended?: ScorecardItem[];
  };
  prod?: {
    critical?: ScorecardItem[];
    conditional?: ScorecardItem[];
  };
}

interface EvalResult {
  errors: string[];
  warnings: string[];
  passed: number;
  total: number;
}

export interface ScorecardSectionReport {
  label: string;
  prefix: string;
  result: EvalResult;
}

export interface ScorecardValidationReport {
  mode: ScorecardMode;
  project: string;
  target: string;
  errors: string[];
  warnings: string[];
  sections: ScorecardSectionReport[];
}

function fail(message: string): never {
  throw new Error(message);
}

function loadScorecard(root: string): Scorecard {
  const yamlPath = path.join(root, '.discipline', 'scorecard.yaml');
  if (!fs.existsSync(yamlPath)) {
    fail(
      `.discipline/scorecard.yaml not found. ` +
      `Copy .discipline/scorecard.template.yaml to .discipline/scorecard.yaml and fill it in ` +
      `(schema: 65a - Launch vs PROD + Scorecard as Code).`
    );
  }
  const content = fs.readFileSync(yamlPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    fail(`Failed to parse .discipline/scorecard.yaml as YAML: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    fail('.discipline/scorecard.yaml is empty or not a valid object.');
  }
  return parsed as Scorecard;
}

interface DisciplineSwitches {
  AI_FEATURES?: string;
  PUSH_PLUGIN?: string;
  PROFILE?: string;
  BILLING?: string;
  [key: string]: string | undefined;
}

function readDisciplineSwitches(root: string): DisciplineSwitches {
  const disciplinePath = path.join(root, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) return {};
  const content = fs.readFileSync(disciplinePath, 'utf-8');
  const switches: DisciplineSwitches = {};
  const re = /^-\s+([A-Z_][A-Z0-9_]*)\s*:\s*(.+?)(?:\s*#.*)?$/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    switches[match[1]] = match[2].trim();
  }
  return switches;
}

function evaluateAppliesWhen(expr: string, switches: DisciplineSwitches): boolean {
  // Minimal DSL: "switch.X == value" or "X == value".
  // Example: "discipline.md.AI_FEATURES == enabled" or "AI_FEATURES == enabled" or "cobras == true".
  const normalized = expr.replace(/\bdiscipline.md\./g, '').trim();
  const match = normalized.match(/^([A-Z_][A-Z0-9_]*)\s*(==|!=)\s*(.+)$/i);
  if (!match) return false;
  const key = match[1].toUpperCase();
  const op = match[2];
  const expected = match[3].replace(/['"]/g, '').trim().toLowerCase();
  const actual = (switches[key] ?? '').toLowerCase();
  return op === '==' ? actual === expected : actual !== expected;
}

// A5: only CRITICAL items whose id is on this audited allowlist may downgrade from
// blocking via `blocking: false`. These are the infra-dependent items that genuinely
// cannot be completed locally before a public deploy exists (Sentry, uptime, HSTS).
// Any other CRITICAL item setting blocking:false is ignored (it stays blocking).
const BLOCKING_FALSE_ALLOWLIST = new Set<string>(['L04', 'L05', 'L06b']);

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isPrOrIssueRef(value: string): boolean {
  const t = value.trim();
  return /(^|[\s(])#\d+\b/.test(t) || /\/(?:pull|issues|commit|releases)\//i.test(t) || /\bPR\s*#?\d+\b/i.test(t);
}

function evidenceFileExists(root: string, value: string): boolean {
  // Accept an optional :line or #anchor suffix on a path.
  const cleaned = value.trim().replace(/[#:]L?\d+(?:[-:]\d+)?$/, '').trim();
  if (!cleaned || /\s/.test(cleaned)) return false; // prose, not a path
  const abs = path.isAbsolute(cleaned) ? cleaned : path.join(root, cleaned);
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

// A5: `evidence` must point to something verifiable — a URL, a PR/issue/commit
// reference, or a file that actually exists in the repo. An arbitrary non-empty
// string ("done", "tested manually") no longer counts as evidence.
function evidenceIsValid(item: ScorecardItem, root: string): boolean {
  const e = item.evidence;
  if (typeof e !== 'string' || e.trim().length === 0) return false;
  if (isUrl(e) || isPrOrIssueRef(e)) return true;
  return evidenceFileExists(root, e);
}

function hasEvidence(item: ScorecardItem): boolean {
  return typeof item.evidence === 'string' && item.evidence.trim().length > 0;
}

function evaluateItems(
  items: ScorecardItem[] | undefined,
  severity: Severity,
  today: Date,
  switches: DisciplineSwitches,
  root: string,
): EvalResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let passed = 0;
  let total = 0;

  if (!items) return { errors, warnings, passed, total };

  for (const item of items) {
    // Conditional items: if applies_when is false, item is not required.
    if (item.applies_when) {
      const applies = evaluateAppliesWhen(item.applies_when, switches);
      if (!applies) {
        if (item.status !== 'not_applicable' && item.status !== 'done') {
          // Tolerated: item legitimately skipped.
        }
        continue;
      }
      // If applies_when is true but status is not_applicable -> escape attempt.
      if (item.status === 'not_applicable') {
        errors.push(
          `[${item.id}] ${item.name} — applies_when is true but status=not_applicable (escape attempt)`
        );
        continue;
      }
    }

    total += 1;

    // Reaching here with not_applicable means the item declared no applies_when
    // (the conditional cases both `continue` above), so nothing states WHEN the
    // item stops applying and the validator cannot check the claim. Without this
    // branch the item falls through every case below and passes in silence:
    // Gate D would print "Passed: 0/10" and still exit 0.
    if (item.status === 'not_applicable') {
      const msg =
        `[${item.id}] ${item.name} — not_applicable without applies_when (${severity}); ` +
        `nothing declares when this item stops applying, so the claim is unverifiable. ` +
        `Either add an applies_when condition (syntax: applies_when: "BILLING == true"), ` +
        `or use done / not_done / deferred.`;
      if (severity === 'CRITICAL') errors.push(msg); else warnings.push(msg);
      continue;
    }

    // A5: blocking:false only honored for the audited allowlist.
    const blockingFalseAllowed = item.blocking === false && BLOCKING_FALSE_ALLOWLIST.has(item.id);

    if (item.status === 'done') {
      passed += 1;
      if (!hasEvidence(item)) {
        const msg = `[${item.id}] ${item.name} — done without evidence (${severity})`;
        if (severity === 'CRITICAL') errors.push(msg); else warnings.push(msg);
      } else if (!evidenceIsValid(item, root)) {
        // A5: present but unverifiable (not a URL / PR ref / existing file).
        const msg = `[${item.id}] ${item.name} — done with unverifiable evidence (${severity}): "${item.evidence}". Use a URL, a PR/issue/commit reference, or an existing file path.`;
        if (severity === 'CRITICAL') errors.push(msg); else warnings.push(msg);
      }
      continue;
    }

    if (severity === 'CRITICAL') {
      if (item.status === 'not_done') {
        if (blockingFalseAllowed) {
          warnings.push(`[${item.id}] ${item.name} — not_done (CRITICAL, blocking=false [audited])`);
        } else if (item.blocking === false) {
          errors.push(
            `[${item.id}] ${item.name} — not_done (CRITICAL); blocking:false is NOT permitted for this item ` +
            `(only ${[...BLOCKING_FALSE_ALLOWLIST].join(', ')} may defer). Complete it.`
          );
        } else {
          errors.push(`[${item.id}] ${item.name} — not_done (CRITICAL)`);
        }
        continue;
      }
      if (item.status === 'deferred') {
        if (blockingFalseAllowed) {
          warnings.push(
            `[${item.id}] ${item.name} — deferred (CRITICAL blocking=false [audited]); reason: ${item.deferred_reason ?? '(missing)'}`
          );
        } else {
          errors.push(
            `[${item.id}] ${item.name} — CRITICAL cannot be deferred` +
            (item.blocking === false
              ? ` (blocking:false is not permitted for this item; only ${[...BLOCKING_FALSE_ALLOWLIST].join(', ')} may defer).`
              : ` (blocking default=true). Use an audited blocking:false item, or complete it.`)
          );
        }
        continue;
      }
    }

    if (severity === 'RECOMMENDED') {
      if (item.status === 'not_done') {
        warnings.push(`[${item.id}] ${item.name} — not_done (RECOMMENDED)`);
        continue;
      }
      if (item.status === 'deferred') {
        if (!item.deferred_reason) {
          errors.push(`[${item.id}] ${item.name} — deferred without deferred_reason`);
          continue;
        }
        if (!item.expires_on) {
          errors.push(`[${item.id}] ${item.name} — deferred without expires_on`);
          continue;
        }
        const exp = new Date(item.expires_on);
        if (isNaN(exp.getTime())) {
          errors.push(`[${item.id}] ${item.name} — invalid expires_on: ${item.expires_on}`);
          continue;
        }
        if (exp < today) {
          errors.push(
            `[${item.id}] ${item.name} — expires_on passed (${item.expires_on}). Re-evaluate or re-defer.`
          );
          continue;
        }
        warnings.push(
          `[${item.id}] ${item.name} — deferred until ${item.expires_on}: ${item.deferred_reason}`
        );
      }
    }
  }

  return { errors, warnings, passed, total };
}

function printReport(label: string, result: EvalResult, prefix: string): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  Passed: ${result.passed}/${result.total}`);
  for (const w of result.warnings) console.log(`  \x1b[33m[WARN]\x1b[0m ${prefix} ${w}`);
  for (const e of result.errors) console.log(`  \x1b[31m[FAIL]\x1b[0m ${prefix} ${e}`);
}

function validateTarget(mode: ScorecardMode, target: string, errors: string[]) {
  if (mode === 'prod' && target !== 'PROD') {
    errors.push(`meta.profile_target must be PROD when running Gate E (got: ${target || '(unset)'})`);
  }
  if (mode === 'launch' && target !== 'LAUNCH' && target !== 'PROD') {
    errors.push(`meta.profile_target must be LAUNCH or PROD when running Gate D (got: ${target || '(unset)'})`);
  }
}

export function validateScorecard(root: string, mode: ScorecardMode): ScorecardValidationReport {
  const sc = loadScorecard(root);
  const switches = readDisciplineSwitches(root);
  const today = new Date();
  const target = sc.meta?.profile_target ?? '';

  const aggErrors: string[] = [];
  const aggWarnings: string[] = [];
  const sections: ScorecardSectionReport[] = [];

  validateTarget(mode, target, aggErrors);

  const launchCritical = evaluateItems(sc.launch?.critical, 'CRITICAL', today, switches, root);
  sections.push({ label: 'Gate D: launch.critical', prefix: 'launch', result: launchCritical });
  aggErrors.push(...launchCritical.errors);
  aggWarnings.push(...launchCritical.warnings);

  const launchRecommended = evaluateItems(sc.launch?.recommended, 'RECOMMENDED', today, switches, root);
  sections.push({ label: 'Gate D: launch.recommended', prefix: 'launch', result: launchRecommended });
  aggErrors.push(...launchRecommended.errors);
  aggWarnings.push(...launchRecommended.warnings);

  if (mode === 'prod') {
    const prodCritical = evaluateItems(sc.prod?.critical, 'CRITICAL', today, switches, root);
    sections.push({ label: 'Gate E: prod.critical', prefix: 'prod', result: prodCritical });
    aggErrors.push(...prodCritical.errors);
    aggWarnings.push(...prodCritical.warnings);

    const prodConditional = evaluateItems(sc.prod?.conditional, 'CRITICAL', today, switches, root);
    sections.push({ label: 'Gate E: prod.conditional', prefix: 'prod', result: prodConditional });
    aggErrors.push(...prodConditional.errors);
    aggWarnings.push(...prodConditional.warnings);
  }

  return {
    mode,
    project: sc.meta?.project ?? '(unknown)',
    target: target || '(unset)',
    errors: aggErrors,
    warnings: aggWarnings,
    sections,
  };
}

function main() {
  const args = minimist(process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args['project-dir']);
  const mode = (args.mode as string | undefined) ?? 'launch';

  if (mode !== 'launch' && mode !== 'prod') {
    disciplineError(`--mode must be 'launch' or 'prod' (got: ${mode})`);
  }

  let report: ScorecardValidationReport;
  try {
    report = validateScorecard(projectRoot, mode);
  } catch (err) {
    disciplineError((err as Error).message);
  }

  console.log(`\n=== Gate ${mode === 'launch' ? 'D (Launch)' : 'E (Production)'} ===`);
  console.log(`Project: ${report.project}  |  Target: ${report.target}`);

  for (const section of report.sections) {
    printReport(section.label, section.result, section.prefix);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Errors:   ${report.errors.length}`);
  console.log(`  Warnings: ${report.warnings.length}`);

  if (report.errors.length > 0) {
    console.log(`\n\x1b[31m[GATE ${mode.toUpperCase()} FAIL]\x1b[0m Fix the ${report.errors.length} error(s) above.`);
    console.log(`Reference: 65a - Launch vs PROD + Scorecard as Code §Rules.`);
    process.exit(1);
  }

  disciplineInfo(`Gate ${mode === 'launch' ? 'D' : 'E'} passed with ${report.warnings.length} warning(s).`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]).replace(/\\/g, '/');
  const current = decodeURIComponent(new URL(import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1')
    .replace(/\\/g, '/');
  return invoked === current;
}

if (isMainModule()) {
  main();
}
