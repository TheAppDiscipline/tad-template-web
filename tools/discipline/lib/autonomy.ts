/**
 * Autonomy configuration for headless runs.
 *
 * Parses an OPTIONAL `## Autonomy` section from discipline.md. The section is
 * NOT part of the shipped template: absence -> all defaults. Keys are a simple
 * `- key: value` list:
 *
 *   ## Autonomy
 *   - level: 1
 *   - builder: claude
 *   - validator: gemini
 *   - repair_max: 2
 *   - per_run_usd: 0.50
 *
 * Rules:
 *  - Effective level = min(configured ceiling, --autonomy flag if given). Flags
 *    can only LOWER the level, never raise it (the ceiling lives in discipline.md
 *    and is changed only by a reviewable patch).
 *  - The validator family MUST differ from the builder family. If the config
 *    violates this, warn and pick the default validator of a different family in
 *    a deterministic order (gemini -> codex -> claude, first family-different).
 *  - Malformed values fall back to defaults and are collected as warnings; a bad
 *    config never throws (the manual flow must keep working).
 *
 * No LLM, no network. `findSectionBounds` reuses the same anchor logic the patch
 * engine uses, so the section is located identically to every other heading.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSectionBounds } from './anchors.js';
import { PROVIDER_MATRIX, familyOf, type ProviderFamily } from './providers/types.js';

export type ProviderName = 'claude' | 'codex' | 'gemini' | 'cursor';

export const DEFAULT_AUTONOMY = {
  level: 1,
  builder: 'claude' as ProviderName,
  validator: 'gemini' as ProviderName,
  repairMax: 2,
  perRunUsd: null as number | null,
};

/** Deterministic preference order when auto-picking a family-different validator. */
export const VALIDATOR_FALLBACK_ORDER: ProviderName[] = ['gemini', 'codex', 'claude'];

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 3; // L4 is the GitHub cloud lane only, never local.

export interface AutonomyConfig {
  level: number;
  builder: ProviderName;
  validator: ProviderName;
  repairMax: number;
  perRunUsd: number | null;
  /** Non-fatal problems found while parsing/resolving (surfaced to the user). */
  warnings: string[];
}

const PROVIDER_NAMES = new Set<string>(Object.keys(PROVIDER_MATRIX));

function isProviderName(v: string): v is ProviderName {
  return PROVIDER_NAMES.has(v);
}

/** Parse the `- key: value` lines of an already-sliced Autonomy section. */
function parseKeyValueLines(sectionLines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of sectionLines) {
    const m = line.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2].replace(/#.*$/, '').trim();
  }
  return out;
}

/**
 * Resolve raw parsed keys into a validated config. Pure over the raw map so it
 * is unit-testable without the filesystem. `flagLevel` (from --autonomy) can
 * only lower the effective level.
 */
export function resolveAutonomy(
  raw: Record<string, string>,
  flagLevel?: number,
): AutonomyConfig {
  const warnings: string[] = [];

  // level (ceiling from config), clamped to [MIN_LEVEL, MAX_LEVEL].
  let level = DEFAULT_AUTONOMY.level;
  if (raw.level !== undefined) {
    const n = Number(raw.level);
    if (!Number.isInteger(n) || n < MIN_LEVEL || n > MAX_LEVEL) {
      warnings.push(`Autonomy: invalid level "${raw.level}" (expected integer ${MIN_LEVEL}-${MAX_LEVEL}); using ${DEFAULT_AUTONOMY.level}.`);
    } else {
      level = n;
    }
  }

  // builder.
  let builder = DEFAULT_AUTONOMY.builder;
  if (raw.builder !== undefined) {
    const v = raw.builder.toLowerCase();
    if (isProviderName(v)) builder = v;
    else warnings.push(`Autonomy: unknown builder "${raw.builder}"; using ${DEFAULT_AUTONOMY.builder}.`);
  }

  // validator (may be corrected below for the family rule).
  let validator = DEFAULT_AUTONOMY.validator;
  if (raw.validator !== undefined) {
    const v = raw.validator.toLowerCase();
    if (isProviderName(v)) validator = v;
    else warnings.push(`Autonomy: unknown validator "${raw.validator}"; using ${DEFAULT_AUTONOMY.validator}.`);
  }

  // repair_max: non-negative integer.
  let repairMax = DEFAULT_AUTONOMY.repairMax;
  if (raw.repair_max !== undefined) {
    const n = Number(raw.repair_max);
    if (!Number.isInteger(n) || n < 0) {
      warnings.push(`Autonomy: invalid repair_max "${raw.repair_max}" (expected non-negative integer); using ${DEFAULT_AUTONOMY.repairMax}.`);
    } else {
      repairMax = n;
    }
  }

  // per_run_usd: optional positive number.
  let perRunUsd = DEFAULT_AUTONOMY.perRunUsd;
  if (raw.per_run_usd !== undefined) {
    const n = Number(raw.per_run_usd);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`Autonomy: invalid per_run_usd "${raw.per_run_usd}" (expected a non-negative number); ignoring.`);
    } else {
      perRunUsd = n;
    }
  }

  // Family rule: validator family MUST differ from builder family. Correct it
  // deterministically if it matches, choosing the first family-different fallback.
  validator = enforceValidatorFamily(builder, validator, warnings);

  // Effective level: --autonomy can only LOWER the ceiling.
  if (flagLevel !== undefined) {
    if (!Number.isInteger(flagLevel) || flagLevel < MIN_LEVEL || flagLevel > MAX_LEVEL) {
      warnings.push(`Autonomy: invalid --autonomy "${flagLevel}" (expected ${MIN_LEVEL}-${MAX_LEVEL}); ignoring the flag.`);
    } else if (flagLevel < level) {
      level = flagLevel;
    } else if (flagLevel > level) {
      warnings.push(`Autonomy: --autonomy ${flagLevel} cannot raise the configured ceiling ${level}; flags can only lower it.`);
    }
  }

  return { level, builder, validator, repairMax, perRunUsd, warnings };
}

/**
 * Ensure validator.family != builder.family. If equal, pick the first provider
 * from VALIDATOR_FALLBACK_ORDER whose family differs from the builder. Pushes a
 * warning when a correction happens.
 */
export function enforceValidatorFamily(
  builder: ProviderName,
  validator: ProviderName,
  warnings: string[],
): ProviderName {
  const builderFamily = familyOf(builder);
  const validatorFamily = familyOf(validator);
  if (builderFamily && validatorFamily && builderFamily !== validatorFamily) {
    return validator; // already family-different
  }
  const picked = VALIDATOR_FALLBACK_ORDER.find((name) => {
    const fam = familyOf(name) as ProviderFamily | null;
    return fam !== null && fam !== builderFamily;
  });
  const fallback = picked ?? DEFAULT_AUTONOMY.validator;
  warnings.push(
    `Autonomy: validator "${validator}" shares the builder family "${builderFamily ?? 'unknown'}"; ` +
      `cross-validation requires a different family. Using "${fallback}" instead.`,
  );
  return fallback;
}

/**
 * Load the autonomy config from discipline.md at `root`. Missing file or missing
 * `## Autonomy` section -> defaults (with the family rule applied). `flagLevel`
 * is the optional --autonomy value that may lower the ceiling.
 */
export function loadAutonomy(root: string, flagLevel?: number): AutonomyConfig {
  const disciplinePath = path.join(root, 'discipline.md');
  let raw: Record<string, string> = {};
  if (fs.existsSync(disciplinePath)) {
    const content = fs.readFileSync(disciplinePath, 'utf-8');
    const lines = content.split('\n');
    const bounds = findSectionBounds(lines, '## Autonomy');
    if (bounds) {
      // Skip the heading line itself; parse the section body.
      raw = parseKeyValueLines(lines.slice(bounds.start + 1, bounds.end));
    }
  }
  return resolveAutonomy(raw, flagLevel);
}
