import * as fs from 'node:fs';
import * as path from 'node:path';
import { AFFECTED_SURFACES, type AffectedSurface } from './step5-schema.js';

/**
 * `.discipline/gates.json`: which gates a change has to pass, given what it touched.
 *
 * The lane's `gate` script stays the full, always-correct answer. This file is the
 * map that lets `gate --changed` run a SUBSET of it, and the only place that map
 * exists. It is read, never inferred: a surface this file does not mention is a
 * gate nobody runs, so a config that omits one is refused rather than defaulted.
 *
 * Three rules keep the subset from becoming a false green:
 *   1. Every surface in `AFFECTED_SURFACES` must have an entry, even an empty one.
 *      Silence is how a surface stops being checked without anybody deciding it.
 *   2. Every script named here must exist in package.json. A gate that cannot be
 *      run is not a gate.
 *   3. A changed file that matches no rule is `unmapped`, and unmapped means the
 *      FULL gate runs. Not knowing what covers a file is a reason to run more,
 *      never a reason to run less.
 */

export const GATES_CONFIG_SCHEMA = 'discipline.gates.v1';
export const GATES_CONFIG_FILE = path.join('.discipline', 'gates.json');

/** A file-to-surface rule. `prefixes` match the start of the POSIX path; `extensions` match its end. */
export interface GateMapRule {
  surface: AffectedSurface;
  prefixes: string[];
  extensions: string[];
}

export interface GatesConfig {
  schema: string;
  /** Scripts that run on every `gate --changed`, whatever changed. */
  base: string[];
  /** Scripts each surface adds. Every surface has an entry; an empty list is a decision. */
  surfaces: Record<AffectedSurface, string[]>;
  rules: GateMapRule[];
  /** Paths that need no gate of their own (build output, pipeline state). */
  exclude: string[];
  /** The script to run when a changed file matches no rule. The full gate, by design. */
  unmapped: string;
}

/** Config problems are the operator's to fix, and every message names the file. */
export class GateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateConfigError';
  }
}

const SURFACE_SET = new Set<string>(AFFECTED_SURFACES);

/** Path as the config writes them: POSIX separators, no leading `./`. */
export function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new GateConfigError(`${GATES_CONFIG_FILE}: ${where} must be an array of strings.`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new GateConfigError(`${GATES_CONFIG_FILE}: ${where} must hold non-empty strings (found ${JSON.stringify(entry)}).`);
    }
    out.push(entry.trim());
  }
  return out;
}

/** Scripts declared in the project's package.json, or null when it cannot be read. */
export function readScriptNames(root: string): Set<string> | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

/**
 * Parse and validate the config. Throws GateConfigError on anything it cannot
 * read as a complete map: this runs before any gate, so a broken map stops the
 * command instead of quietly shrinking what it checks.
 */
export function parseGatesConfig(raw: string, available: Set<string> | null): GatesConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new GateConfigError(`${GATES_CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new GateConfigError(`${GATES_CONFIG_FILE} must be a JSON object.`);
  }
  const obj = data as Record<string, unknown>;

  if (obj.schema !== GATES_CONFIG_SCHEMA) {
    throw new GateConfigError(
      `${GATES_CONFIG_FILE} declares schema ${JSON.stringify(obj.schema ?? null)}; this tooling reads ${GATES_CONFIG_SCHEMA}.`,
    );
  }

  const base = asStringArray(obj.base ?? [], '"base"');
  const exclude = asStringArray(obj.exclude ?? [], '"exclude"').map(normalizePath);

  if (typeof obj.unmapped !== 'string' || obj.unmapped.trim() === '') {
    throw new GateConfigError(`${GATES_CONFIG_FILE}: "unmapped" must name the script to run when a changed file matches no rule.`);
  }
  const unmapped = obj.unmapped.trim();

  const surfacesRaw = obj.surfaces;
  if (surfacesRaw === null || typeof surfacesRaw !== 'object' || Array.isArray(surfacesRaw)) {
    throw new GateConfigError(`${GATES_CONFIG_FILE}: "surfaces" must be an object keyed by surface.`);
  }
  const surfaces = {} as Record<AffectedSurface, string[]>;
  for (const [key, value] of Object.entries(surfacesRaw as Record<string, unknown>)) {
    if (!SURFACE_SET.has(key)) {
      throw new GateConfigError(
        `${GATES_CONFIG_FILE}: "surfaces" names "${key}", which is not a surface. Valid: ${AFFECTED_SURFACES.join(', ')}.`,
      );
    }
    surfaces[key as AffectedSurface] = asStringArray(value, `"surfaces.${key}"`);
  }
  // A missing surface is not an empty one: a packet may declare it, and then nothing would run.
  const missing = AFFECTED_SURFACES.filter((s) => !(s in surfaces));
  if (missing.length) {
    throw new GateConfigError(
      `${GATES_CONFIG_FILE}: "surfaces" says nothing about ${missing.join(', ')}. ` +
        'Every surface needs an entry, even an empty list, so that skipping its gates is a decision somebody made.',
    );
  }

  if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
    throw new GateConfigError(`${GATES_CONFIG_FILE}: "rules" must be a non-empty array mapping paths to surfaces.`);
  }
  const rules: GateMapRule[] = [];
  for (const [i, entry] of (obj.rules as unknown[]).entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GateConfigError(`${GATES_CONFIG_FILE}: "rules[${i}]" must be an object.`);
    }
    const rule = entry as Record<string, unknown>;
    if (typeof rule.surface !== 'string' || !SURFACE_SET.has(rule.surface)) {
      throw new GateConfigError(
        `${GATES_CONFIG_FILE}: "rules[${i}].surface" is ${JSON.stringify(rule.surface ?? null)}; valid: ${AFFECTED_SURFACES.join(', ')}.`,
      );
    }
    const prefixes = asStringArray(rule.prefixes ?? [], `"rules[${i}].prefixes"`).map(normalizePath);
    const extensions = asStringArray(rule.extensions ?? [], `"rules[${i}].extensions"`);
    if (prefixes.length === 0 && extensions.length === 0) {
      throw new GateConfigError(`${GATES_CONFIG_FILE}: "rules[${i}]" matches nothing (no prefixes, no extensions).`);
    }
    rules.push({ surface: rule.surface as AffectedSurface, prefixes, extensions });
  }

  // Every script has to exist. A gate named here and missing there would be skipped
  // silently by npm, which is the exact shape of a check nobody notices is gone.
  if (available) {
    const wanted = new Map<string, string>();
    for (const script of base) if (!wanted.has(script)) wanted.set(script, '"base"');
    for (const [surface, scripts] of Object.entries(surfaces)) {
      for (const script of scripts) if (!wanted.has(script)) wanted.set(script, `"surfaces.${surface}"`);
    }
    if (!wanted.has(unmapped)) wanted.set(unmapped, '"unmapped"');
    const absent = [...wanted.entries()].filter(([script]) => !available.has(script));
    if (absent.length) {
      throw new GateConfigError(
        `${GATES_CONFIG_FILE} names ${absent.length} script(s) that package.json does not define: ` +
          absent.map(([script, where]) => `${script} (${where})`).join(', ') +
          '. Add the script or remove it from the map.',
      );
    }
  }

  return { schema: GATES_CONFIG_SCHEMA, base, surfaces, rules, exclude, unmapped };
}

/** Read the config from a project root. Absence is an error: `--changed` has no default map. */
export function loadGatesConfig(root: string): GatesConfig {
  const file = path.join(root, GATES_CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new GateConfigError(
      `${GATES_CONFIG_FILE} not found in ${root}. \`gate --changed\` needs it to know which gates cover which files; ` +
        'run the full `npm run gate` until it exists.',
    );
  }
  return parseGatesConfig(raw, readScriptNames(root));
}

export interface SurfaceInference {
  /** Surfaces the changed files themselves imply, sorted. */
  surfaces: AffectedSurface[];
  /** Which files put each surface on the list, for a message that can be checked. */
  evidence: Record<string, string[]>;
  /** Files that matched no rule: the full gate runs because of them. */
  unmapped: string[];
  /** Files the config says need no gate of their own. */
  excluded: string[];
}

/**
 * Which surfaces a set of changed files touches.
 *
 * Rules are additive, not first-match: a file under `api/` can be both `backend`
 * and `deployment-artifact`, and taking only the first would drop a gate. More
 * matches always mean more gates, so an over-broad rule costs time and an
 * under-broad one costs coverage.
 */
export function inferSurfaces(config: GatesConfig, files: string[]): SurfaceInference {
  const evidence: Record<string, string[]> = {};
  const unmapped: string[] = [];
  const excluded: string[] = [];

  for (const raw of files) {
    const file = normalizePath(raw);
    if (config.exclude.some((prefix) => file.startsWith(prefix))) {
      excluded.push(file);
      continue;
    }
    let matched = false;
    for (const rule of config.rules) {
      const hit =
        rule.prefixes.some((prefix) => file.startsWith(prefix)) ||
        rule.extensions.some((ext) => file.endsWith(ext));
      if (!hit) continue;
      matched = true;
      (evidence[rule.surface] ??= []).push(file);
    }
    if (!matched) unmapped.push(file);
  }

  const surfaces = AFFECTED_SURFACES.filter((s) => evidence[s]?.length);
  return { surfaces: [...surfaces], evidence, unmapped, excluded };
}

/**
 * The scripts to run, in config order, deduplicated. `base` first, then each
 * surface's scripts in the canonical surface order, so two runs over the same
 * change produce the same list in the same order.
 */
export function gatesForSurfaces(config: GatesConfig, surfaces: readonly AffectedSurface[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (script: string) => {
    if (seen.has(script)) return;
    seen.add(script);
    out.push(script);
  };
  for (const script of config.base) push(script);
  for (const surface of AFFECTED_SURFACES) {
    if (!surfaces.includes(surface)) continue;
    for (const script of config.surfaces[surface]) push(script);
  }
  return out;
}
