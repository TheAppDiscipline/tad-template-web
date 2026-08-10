/**
 * ONE definition of what a STEP_5_SLICE_PACKET has to say, for both versions of the format.
 *
 * The packet is the document an implementer builds from. A v1 packet says what it can and the
 * pipeline warns about the rest, because thousands of them already exist and none of them asked to
 * be rewritten. A **v2 packet whose status is `ready` fails closed**: it declared the newer,
 * stricter contract and then a step is about to hand it to a builder, so a missing acceptance
 * criterion or an empty cell is a spec nobody wrote, not a formatting nit.
 *
 * Everything here is machine-readable on purpose. Fase 1 established why: a state inferred from
 * prose is language-dependent, and the same English word list that reads "0 errors" as a failure
 * also reads "cannot pass" as a success. So the packet DECLARES (`METHOD:`, `APPLIES:`,
 * `RATIONALE:`) and this module reads declarations, never sentiment.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import { parsePacketMeta } from './packet-meta.js';
import { normalizeSliceId } from './slice-identity.js';

/** The surfaces a slice can touch. Fase 3 maps changed files to these; here they are validated. */
export const AFFECTED_SURFACES = [
  'ui', 'authenticated-ui', 'backend', 'schema', 'permissions', 'deployment-artifact', 'ai', 'docs-only',
] as const;

/** How a slice proves it could have failed. One of these, declared, not guessed from prose. */
export const FALSIFIABILITY_METHODS = ['red-evidence', 'mutation', 'rationale'] as const;

/** Sections every Step 5 packet carries, in both versions. */
const CORE_SECTIONS = ['Goal', 'Scope', 'Contracts'] as const;

/** Sections v2 adds, and v1 only warns about. */
const V2_SECTIONS = [
  'Provider Impact', 'AI Impact', 'Reachable States', 'Acceptance Criteria', 'Falsifiability',
  'Files to touch', 'Deployment Compatibility', 'Manual Verification', 'Estimate',
] as const;

const REACHABLE_STATES_COLUMNS = ['state', 'trigger', 'committed effects', 'returned result', 'recovery'];
const ACCEPTANCE_COLUMNS = ['id', 'setup', 'action', 'observable result', 'negative control'];

export interface SchemaFinding {
  /** `error` only ever comes from a v2 packet; a legacy packet cannot fail this check. */
  severity: 'error' | 'warning';
  message: string;
  detail?: string;
}

export interface Step5Reading {
  /** Which contract the packet is held to; see `step5Format`. */
  format: Step5Format;
  /** The declared status, lowercased, or null when the packet declares none. */
  status: string | null;
  /** True when this packet is held to the v2 contract as errors (v2 AND ready). */
  enforced: boolean;
  findings: SchemaFinding[];
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'step5-packet.schema.json');
let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  cachedValidator = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf-8')));
  return cachedValidator;
}

/** The body with the frontmatter removed, so a `slice:` key is never read as a body declaration. */
function bodyOf(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * A cell nobody filled in: empty, a template slot, or a "later" marker.
 *
 * `none` is deliberately NOT here. "Committed effects: none" is an ANSWER (this state writes
 * nothing), and reading it as an empty cell would turn an honest packet red. Where `none` really is
 * an evasion, the rule says so on its own: see `isEvasive`.
 */
function isPlaceholder(text: string): boolean {
  const bare = text.trim().toLowerCase();
  if (bare === '') return true;
  if (/^<[^>]*>$/.test(bare)) return true;
  return ['-', '--', 'tbd', 'todo', 'pending', '...', '???', '?'].includes(bare.replace(/[.\s]+$/, ''));
}

/** Unfilled, or filled with a non-answer. Used where "none" cannot be the truth. */
function isEvasive(text: string): boolean {
  if (isPlaceholder(text)) return true;
  const bare = text.trim().toLowerCase().replace(/[.\s]+$/, '');
  return ['n/a', 'n.a', 'na', 'none', 'no', 'nothing', 'not applicable', 'does not apply', 'nil'].includes(bare);
}

/** True when a section explicitly says it does not apply. Its RATIONALE is checked separately. */
function declaresNotApplicable(lines: string[]): boolean {
  return lines.some((line) => /^[-*]?\s*APPLIES\s*:\s*no\b/i.test(line));
}

/**
 * Does this section actually say anything? A heading, a blank line and a table separator are
 * structure, not content; a `TBD` bullet is a promise; and a bare `none` / `n/a` is a section
 * saying it has nothing to say without taking responsibility for it. Where that is really true,
 * `APPLIES: no` with a rationale says so on the record. Anything else counts: a table row is an
 * answer, and so is a one-line sentence.
 */
function hasSubstance(lines: string[]): boolean {
  return lines.some((raw) => {
    const line = raw.trim();
    if (line === '') return false;
    if (/^#{1,6}\s/.test(line)) return false;          // a sub-heading is more structure
    if (/^\|[\s:|-]+\|$/.test(line)) return false;      // a table separator row
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) return false; // a horizontal rule
    return !isEvasive(line.replace(/^[-*+]\s*/, ''));
  });
}

/** The lines of a `## Name` section, up to the next heading of the same or a higher level. */
export function sectionLines(body: string, name: string): string[] | null {
  const lines = body.split('\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^(#{1,6})[ \\t]+${escaped}[ \\t]*$`, 'i');
  const start = lines.findIndex((line) => head.test(line));
  if (start === -1) return null;
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})[ \t]/);
    if (match && match[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

export interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** The first markdown table inside a block of lines, header and body cells trimmed. */
export function parseTable(lines: string[]): ParsedTable | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
    const cells = (line: string) => line.split('|').slice(1, -1).map((cell) => cell.trim());
    const header = cells(lines[i]);
    const rows: string[][] = [];
    for (let r = i + 2; r < lines.length; r++) {
      if (!lines[r].trim().startsWith('|')) break;
      rows.push(cells(lines[r]));
    }
    return { header, rows };
  }
  return null;
}

/**
 * Which contract this packet is held to. THREE outcomes, not two:
 *
 *  - `legacy`: no frontmatter, or frontmatter that does not declare the Step 5 schema, or declares
 *    it at version 1. Advisory: it predates this contract and nothing it omits is a lie.
 *  - `v2`: declares the Step 5 schema at version 2. The current contract.
 *  - `unsupported`: declares the Step 5 schema with a version this tooling cannot read (missing,
 *    malformed, or from the future). REFUSED, never quietly demoted to legacy. Falling back would
 *    take a packet that explicitly opted into a versioned contract and validate it against none,
 *    which is the exact shape of the false green the version field exists to prevent: `version: 3`
 *    with `status: ready` sailed through as "legacy, 0 errors".
 */
export type Step5Format = 'v2' | 'legacy' | 'unsupported';

/** A well-formed version of a given major: `2`, `2.1`, `2.0.0`, `2.0.0-rc.1`. Nothing else. */
const versionOfMajor = (major: string) => new RegExp(`^${major}(\\.\\d+){0,2}(-[0-9A-Za-z.-]+)?$`);

export function step5Format(content: string): { format: Step5Format; version: string | null; reason?: string } {
  const { meta, errors } = parsePacketMeta(content);

  // No frontmatter at all is a legacy packet. Frontmatter that OPENED and could not be read is
  // not: an unreadable declaration is not the same as no declaration, and deciding it was "no
  // declaration" is exactly the fallback this classifier exists to remove. A packet whose YAML
  // does not parse might be declaring v2 and failing every rule in it; nobody can tell, and
  // "nobody can tell" has to read as a refusal.
  if (meta === null) {
    if (errors.length === 0) return { format: 'legacy', version: null };
    return { format: 'unsupported', version: null, reason: `has frontmatter that cannot be read: ${errors.join('; ')}` };
  }
  if (meta.schema !== 'discipline.packet.step5') return { format: 'legacy', version: null };

  if (meta.version === undefined || meta.version === null || String(meta.version).trim() === '') {
    return { format: 'unsupported', version: null, reason: 'declares schema discipline.packet.step5 with no version' };
  }
  // The version is a STRING, which is also what the schema says. YAML turns `2`, `2.0` and `2.`
  // into the number 2, so a malformed `version: 2.` arrived here already normalized and passed as
  // version 2 while the schema rejected it as "must be string": the classifier was more permissive
  // than the contract it enforces, and the gap between them was a packet nobody checked.
  if (typeof meta.version !== 'string') {
    return {
      format: 'unsupported',
      version: String(meta.version),
      reason: `declares version ${JSON.stringify(meta.version)} as a YAML number, not a version string. Quote it: version: "2.0.0"`,
    };
  }
  const raw = meta.version.trim();
  // The version has to be WELL FORMED, not merely start with the right digit: `2.`, `2.bad` and
  // `2.0.bad` are not version 2, they are a version nobody can compare. Reading them as v2 made
  // their malformed frontmatter a warning on a draft, which is the "unreadable version fails open"
  // rule with an extra step.
  if (versionOfMajor('1').test(raw)) return { format: 'legacy', version: raw };
  if (versionOfMajor('2').test(raw)) return { format: 'v2', version: raw };
  return {
    format: 'unsupported',
    version: raw,
    reason: `declares schema discipline.packet.step5 version "${raw}", which this tooling cannot read (it knows 1.x and 2.x)`,
  };
}

/** Does this packet declare the v2 contract? */
export function isStep5V2(content: string): boolean {
  return step5Format(content).format === 'v2';
}

/**
 * Read a Step 5 packet against its own declared contract.
 *
 * A v2 `ready` packet reports errors; a v2 `draft` reports the same problems as warnings, because a
 * draft is work in progress and refusing it would stop the very step that fills it in. A legacy
 * packet reports warnings only, and only about the sections it was ever asked for.
 */
export function readStep5Packet(content: string, fileName?: string): Step5Reading {
  const { meta, errors: metaErrors } = parsePacketMeta(content);
  const classified = step5Format(content);
  const format = classified.format;
  const status = typeof meta?.status === 'string' ? meta.status.trim().toLowerCase() : null;
  const enforced = format === 'v2' && status === 'ready';
  const findings: SchemaFinding[] = [];
  const severity: SchemaFinding['severity'] = enforced ? 'error' : 'warning';
  const body = bodyOf(content);
  const where = fileName ? `${path.basename(fileName)}: ` : '';

  for (const problem of metaErrors) {
    findings.push({ severity: format === 'legacy' ? 'warning' : severity, message: `${where}frontmatter ${problem}` });
  }

  if (format === 'unsupported') {
    // An error whatever the status says: a version this tooling cannot read means it cannot check
    // the packet at all, and "cannot check it" has to read as a refusal, not as a pass.
    findings.push({
      severity: 'error',
      message: `${where}${classified.reason}`,
      detail: 'Set version: 2.0.0 and meet the v2 contract, or drop the schema line to keep the packet legacy. A version nobody can read is not a contract.',
    });
    return { format, status, enforced: true, findings };
  }

  if (format === 'legacy') {
    // A legacy packet is only ever nudged: it predates this contract and nothing it omits is a lie.
    // Its core sections are checked by validate-discipline's own rules, which own that message.
    findings.push({
      severity: 'warning',
      message: `${where}legacy Step 5 packet (no v2 frontmatter)`,
      detail: 'Run `discipline migrate-packets --check` to see what a v2 packet would look like.',
    });
    return { format, status, enforced, findings };
  }

  checkV2(content, body, severity, where, findings);
  return { format, status, enforced, findings };
}

/**
 * Every v2 rule, against any packet. `readStep5Packet` runs it on packets that DECLARE v2;
 * `migrate-packets` runs it on a legacy body to decide whether the migrated packet may keep
 * `status: ready` or has to land as a `draft`.
 */
export function evaluateAsV2(content: string, fileName?: string): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  checkV2(content, bodyOf(content), 'error', fileName ? `${path.basename(fileName)}: ` : '', findings);
  return findings;
}

function checkV2(content: string, body: string, severity: SchemaFinding['severity'], where: string, findings: SchemaFinding[]) {
  const { meta } = parsePacketMeta(content);
  const validate = getValidator();
  if (meta && !validate(meta)) {
    for (const error of validate.errors ?? []) {
      findings.push({ severity, message: `${where}frontmatter ${error.instancePath || '/'} ${error.message}`.trim() });
    }
  }

  // The `id` carries the slice, so it is a declaration like any other and it has to agree.
  const declaredSlice = meta?.slice === undefined ? null : normalizeSliceId(String(meta.slice));
  const idSlice = typeof meta?.id === 'string' ? meta.id.split(':')[1] : undefined;
  if (declaredSlice && idSlice && normalizeSliceId(idSlice) !== declaredSlice) {
    findings.push({
      severity,
      message: `${where}frontmatter id names slice "${idSlice}" and slice: says "${meta?.slice}"`,
      detail: 'The id is step5:<slice>:<timestamp>; two declarations that disagree are never resolved by picking one.',
    });
  }

  for (const section of [...CORE_SECTIONS, ...V2_SECTIONS]) {
    const lines = sectionLines(body, section);
    if (lines === null) {
      findings.push({ severity, message: `${where}v2 packet is missing the "${section}" section` });
      continue;
    }
    // A heading is not an answer. Checking only that the heading EXISTS meant a packet with twelve
    // empty sections read as a complete v2 spec, which is the contract satisfied by typing its
    // table of contents.
    if (declaresNotApplicable(lines)) {
      // ...and `APPLIES: no` is not an answer either, in the sections that ARE the slice. There is
      // no rationale for a slice with no Goal, no Scope or no Contracts: that is not a slice.
      // Everywhere else it is allowed, with the rationale checked below.
      if ((CORE_SECTIONS as readonly string[]).includes(section)) {
        findings.push({
          severity,
          message: `${where}"${section}" declares APPLIES: no`,
          detail: 'Goal, Scope and Contracts are what a slice IS. A slice that has none of them is not a slice with an exemption, it is not a slice.',
        });
      }
      continue;
    }
    if (!hasSubstance(lines)) {
      findings.push({
        severity,
        message: `${where}"${section}" is empty`,
        detail: 'Write what it says. "none" and "n/a" are not answers here; where a section really does not apply, declare `- APPLIES: no` with a `- RATIONALE:` somebody can check.',
      });
    }
  }

  checkTable(body, 'Reachable States', REACHABLE_STATES_COLUMNS, severity, where, findings);
  checkAcceptanceCriteria(body, severity, where, findings);
  checkFalsifiability(body, severity, where, findings);
  checkNotApplicableRationales(body, severity, where, findings);
}

function checkTable(body: string, name: string, columns: string[], severity: SchemaFinding['severity'], where: string, findings: SchemaFinding[]): ParsedTable | null {
  const lines = sectionLines(body, name);
  if (lines === null) return null;
  const table = parseTable(lines);
  if (!table) {
    findings.push({ severity, message: `${where}"${name}" has no table`, detail: `Expected columns: ${columns.join(' | ')}` });
    return null;
  }
  const header = table.header.map((cell) => cell.toLowerCase().replace(/[*_`]/g, '').trim());
  const missing = columns.filter((column) => !header.includes(column));
  if (missing.length) {
    findings.push({ severity, message: `${where}"${name}" table is missing the column(s): ${missing.join(', ')}`, detail: `Found: ${table.header.join(' | ')}` });
  }
  if (table.rows.length === 0) {
    findings.push({ severity, message: `${where}"${name}" table has a header and no rows` });
  }
  table.rows.forEach((row, index) => {
    const empty = columns.filter((column) => {
      const at = header.indexOf(column);
      return at !== -1 && isPlaceholder(row[at] ?? '');
    });
    if (empty.length) {
      findings.push({ severity, message: `${where}"${name}" row ${index + 1} leaves ${empty.join(', ')} empty`, detail: row.join(' | ') });
    }
  });
  return table;
}

function checkAcceptanceCriteria(body: string, severity: SchemaFinding['severity'], where: string, findings: SchemaFinding[]) {
  const table = checkTable(body, 'Acceptance Criteria', ACCEPTANCE_COLUMNS, severity, where, findings);
  if (!table) return;
  const header = table.header.map((cell) => cell.toLowerCase().replace(/[*_`]/g, '').trim());

  // A criterion with no negative control is the false-green shape this whole system exists to
  // prevent: a check that passes is worth nothing until you know what would have made it fail. So
  // here, unlike everywhere else, "none" is not an answer.
  const controlAt = header.indexOf('negative control');
  if (controlAt !== -1) {
    table.rows.forEach((row, index) => {
      if (isEvasive(row[controlAt] ?? '')) {
        findings.push({
          severity,
          message: `${where}acceptance criterion in row ${index + 1} has no negative control`,
          detail: 'Say what would have to break for this criterion to fail. A criterion that cannot fail proves nothing.',
        });
      }
    });
  }

  const idAt = header.indexOf('id');
  if (idAt === -1) return;
  const seen = new Map<string, number[]>();
  table.rows.forEach((row, index) => {
    const id = (row[idAt] ?? '').trim().toLowerCase();
    if (!id) return;
    seen.set(id, [...(seen.get(id) ?? []), index + 1]);
  });
  for (const [id, rows] of seen) {
    if (rows.length > 1) {
      findings.push({
        severity,
        message: `${where}acceptance criterion "${id}" appears ${rows.length} times (rows ${rows.join(', ')})`,
        detail: 'A criterion is referenced by id when it fails; two rows with one id make the reference ambiguous.',
      });
    }
  }
}

function checkFalsifiability(body: string, severity: SchemaFinding['severity'], where: string, findings: SchemaFinding[]) {
  const lines = sectionLines(body, 'Falsifiability');
  if (lines === null) return;
  const methods = lines
    .map((line) => line.match(/^[-*]?\s*METHOD\s*:\s*(.+)$/i)?.[1]?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  if (methods.length === 0) {
    findings.push({
      severity,
      message: `${where}"Falsifiability" declares no METHOD`,
      detail: `Declare exactly one of: ${FALSIFIABILITY_METHODS.join(', ')}. What proves the slice could have failed is a decision, not a tone of voice.`,
    });
    return;
  }
  if (methods.length > 1) {
    findings.push({ severity, message: `${where}"Falsifiability" declares ${methods.length} METHODs (${methods.join(', ')}); declare one` });
    return;
  }
  if (!(FALSIFIABILITY_METHODS as readonly string[]).includes(methods[0])) {
    findings.push({ severity, message: `${where}"Falsifiability" METHOD is "${methods[0]}"`, detail: `Valid: ${FALSIFIABILITY_METHODS.join(', ')}` });
    return;
  }
  const evidence = lines.filter((line) => !/^[-*]?\s*METHOD\s*:/i.test(line)).filter((line) => !isPlaceholder(line.replace(/^[-*]\s*/, '')));
  if (evidence.length === 0) {
    findings.push({
      severity,
      message: `${where}"Falsifiability" declares METHOD: ${methods[0]} and shows nothing`,
      detail: 'Name the failing run, the mutation, or the reason this slice cannot be falsified.',
    });
  }
}

/**
 * `APPLIES: no` is how a section says it does not apply, and it is only accepted with a reason
 * somebody can check. Without that rule the fastest way to satisfy a required section is to declare
 * it irrelevant, which turns the whole contract into a formality.
 */
function checkNotApplicableRationales(body: string, severity: SchemaFinding['severity'], where: string, findings: SchemaFinding[]) {
  for (const section of V2_SECTIONS) {
    const lines = sectionLines(body, section);
    if (lines === null) continue;
    const declaresNo = lines.some((line) => /^[-*]?\s*APPLIES\s*:\s*no\b/i.test(line));
    if (!declaresNo) continue;
    const rationale = lines
      .map((line) => line.match(/^[-*]?\s*RATIONALE\s*:\s*(.+)$/i)?.[1]?.trim())
      .find((value): value is string => Boolean(value));
    if (!rationale || isEvasive(rationale) || rationale.length < 12) {
      findings.push({
        severity,
        message: `${where}"${section}" declares APPLIES: no without a checkable RATIONALE`,
        detail: 'Add `RATIONALE: <why this slice cannot touch that surface>`. "n/a" is not a reason.',
      });
    }
  }
}

/** The errors only. Callers that must fail closed use this; everything else reports all findings. */
export function step5Errors(content: string, fileName?: string): string[] {
  return readStep5Packet(content, fileName)
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => (finding.detail ? `${finding.message} (${finding.detail})` : finding.message));
}
