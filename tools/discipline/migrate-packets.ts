/**
 * Move legacy Step 5 packets onto the v2 contract, WITHOUT losing what was there.
 *
 * The migration is a decision the operator takes between slices, so it is dry-run by default and
 * says exactly what it would do. `--write` is the only mode that touches disk, and even then the
 * original is preserved verbatim under `.discipline/packets/legacy/` next to a `.sha256` of its
 * bytes: a migration nobody can check against the original is a rewrite.
 *
 * Three rules keep it honest:
 *  - **Ambiguity is refused, never guessed.** A packet whose slice cannot be established from its
 *    metadata, its `SLICE:` field or a single slice heading is reported and left alone.
 *  - **`ready` is earned, not carried over.** The migrated packet keeps `status: ready` only when
 *    its body already meets the v2 contract; otherwise it lands as `draft`, which is honest about
 *    the sections Step 4 still has to fill in and stops Step 5 from building on a half spec.
 *  - **Nothing is overwritten.** An existing target is left in place and reported, so running the
 *    command twice does the same thing as running it once.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { disciplineError, disciplineInfo, disciplineWarn } from './lib/types.js';
import { resolveProjectRoot } from './lib/discipline-config.js';
import { parsePacketMeta } from './lib/packet-meta.js';
import { resolvePacketIdentity, sliceFileToken, slicePacketFileName } from './lib/slice-identity.js';
import { evaluateAsV2, isStep5V2 } from './lib/step5-schema.js';

export type MigrationAction = 'migrate' | 'skip' | 'refuse';

export interface MigrationPlan {
  file: string;
  action: MigrationAction;
  /** The slice the packet turned out to be for, when it could be established. */
  slice?: string;
  /** The target filename under .discipline/packets/. */
  target?: string;
  /** The status the migrated packet would carry. */
  status?: 'ready' | 'draft';
  /** Why `ready` was not kept, or why the packet was refused or skipped. */
  reason?: string;
}

export interface MigrationResult {
  plans: MigrationPlan[];
  /** True when every packet either migrated or was already fine. */
  ok: boolean;
}

const V2_VERSION = '2.0.0';

/** Which files this command considers: active Step 5 packets that are not already v2. */
function candidates(packetsDir: string): string[] {
  if (!fs.existsSync(packetsDir)) return [];
  return fs.readdirSync(packetsDir)
    .filter((name) => /^STEP_5_SLICE_PACKET(_.+)?\.md$/i.test(name))
    .sort();
}

/**
 * The slice a legacy packet is for. Metadata, then the `SLICE:` field, then a single slice heading:
 * the same declarations slice-identity already reads, so the migration cannot disagree with the
 * pipeline about what it just migrated. Two declarations that contradict each other are refused
 * here exactly as they are everywhere else.
 */
export function inferSlice(content: string, fileName: string): { ok: true; slice: string } | { ok: false; reason: string } {
  // A slice heading IS one of the declarations resolvePacketIdentity reads, so two of them come
  // back from there as a contradiction naming both sources. There is no second, looser pass here
  // on purpose: a migration that resolved an ambiguity the pipeline refuses would be inventing the
  // answer, and the file it wrote would be the only place that answer exists.
  const identity = resolvePacketIdentity(content, fileName);
  if (!identity.ok) return { ok: false, reason: identity.message };
  if (identity.id) return { ok: true, slice: identity.id };
  return { ok: false, reason: 'it names no slice: add a `SLICE: <id>` line or frontmatter `slice:` and run this again' };
}

/** The v2 frontmatter for a migrated packet. `stamp` is passed in so a run is reproducible. */
export function buildV2Frontmatter(slice: string, status: 'ready' | 'draft', stamp: string, previous: Record<string, unknown> | null): string {
  const surfaces = Array.isArray(previous?.affected_surfaces) && previous.affected_surfaces.length
    ? (previous.affected_surfaces as string[])
    : null;
  const gates = Array.isArray(previous?.required_gates) && previous.required_gates.length
    ? (previous.required_gates as string[])
    : ['gate'];
  const lines = [
    '---',
    'schema: discipline.packet.step5',
    `version: ${V2_VERSION}`,
    `id: step5:${slice}:${stamp}`,
    `status: ${status}`,
    `slice: ${slice}`,
    'affected_surfaces:',
    // No surface is invented for the operator: an unknown one would be a claim the migration is in
    // no position to make, and `docs-only` would quietly exempt the slice from every gate.
    ...(surfaces ? surfaces.map((surface) => `  - ${surface}`) : ['  # REQUIRED: declare what this slice touches before it can be `ready`.']),
    'required_gates:',
    ...gates.map((gate) => `  - ${gate}`),
    '---',
    '',
  ];
  return lines.join('\n');
}

/** The body with any previous frontmatter removed. */
function stripFrontmatter(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function planMigration(root: string, stamp: string): MigrationResult {
  const packetsDir = path.join(root, '.discipline', 'packets');
  const plans: MigrationPlan[] = [];

  for (const file of candidates(packetsDir)) {
    const full = path.join(packetsDir, file);
    const content = fs.readFileSync(full, 'utf-8');

    if (isStep5V2(content)) {
      plans.push({ file, action: 'skip', reason: 'already v2' });
      continue;
    }

    const inferred = inferSlice(content, file);
    if (!inferred.ok) {
      plans.push({ file, action: 'refuse', reason: inferred.reason });
      continue;
    }
    const slice = inferred.slice;
    const target = slicePacketFileName(slice);

    if (file !== target && fs.existsSync(path.join(packetsDir, target))) {
      plans.push({ file, action: 'refuse', slice, target, reason: `${target} already exists; nothing is overwritten` });
      continue;
    }

    // `ready` is kept only when the body ALREADY meets v2. The frontmatter is the one the migration
    // is about to write, so the check runs against exactly what would land on disk.
    const { meta } = parsePacketMeta(content);
    const previousStatus = typeof meta?.status === 'string' ? meta.status.trim().toLowerCase() : null;
    const body = stripFrontmatter(content);
    const candidateReady = buildV2Frontmatter(slice, 'ready', stamp, meta) + body;
    const blocking = evaluateAsV2(candidateReady, target);
    const wantsReady = previousStatus === 'ready' || previousStatus === null;
    const status: 'ready' | 'draft' = wantsReady && blocking.length === 0 ? 'ready' : 'draft';
    const reason = status === 'draft'
      ? (wantsReady
        ? `lands as draft: ${blocking.length} v2 requirement(s) unmet (first: ${blocking[0].message})`
        : `lands as draft: the packet already said status: ${previousStatus}`)
      : undefined;
    plans.push({ file, action: 'migrate', slice, target, status, reason });
  }

  return { plans, ok: plans.every((plan) => plan.action !== 'refuse') };
}

export function applyMigration(root: string, plan: MigrationPlan, stamp: string): { ok: boolean; reason?: string } {
  if (plan.action !== 'migrate' || !plan.slice || !plan.target || !plan.status) {
    return { ok: false, reason: 'nothing to apply' };
  }
  const packetsDir = path.join(root, '.discipline', 'packets');
  const legacyDir = path.join(packetsDir, 'legacy');
  const source = path.join(packetsDir, plan.file);
  const target = path.join(packetsDir, plan.target);
  const original = fs.readFileSync(source);

  // 1. The original, byte for byte, plus the hash that proves it. Written FIRST: a migration whose
  //    backup failed must not have produced the new packet.
  fs.mkdirSync(legacyDir, { recursive: true });
  const backup = path.join(legacyDir, `${path.basename(plan.file, '.md')}.${sliceFileToken(plan.slice)}.md`);
  if (fs.existsSync(backup)) return { ok: false, reason: `${path.relative(root, backup)} already exists; nothing is overwritten` };
  fs.writeFileSync(backup, original);
  fs.writeFileSync(`${backup}.sha256`, `${crypto.createHash('sha256').update(original).digest('hex')}  ${plan.file}\n`, 'utf-8');

  // 2. The migrated packet.
  const { meta } = parsePacketMeta(original.toString('utf-8'));
  const migrated = buildV2Frontmatter(plan.slice, plan.status, stamp, meta) + stripFrontmatter(original.toString('utf-8'));
  if (fs.existsSync(target) && path.resolve(target) !== path.resolve(source)) {
    return { ok: false, reason: `${plan.target} already exists; nothing is overwritten` };
  }
  fs.writeFileSync(target, migrated, 'utf-8');

  // 3. The old file, only when it moved to a new name. Its content is in legacy/ either way.
  if (path.resolve(source) !== path.resolve(target)) fs.rmSync(source);
  return { ok: true };
}

export function migratePackets(root: string, options: { write: boolean; stamp: string }): MigrationResult {
  const planned = planMigration(root, options.stamp);
  if (!options.write) return planned;

  const plans: MigrationPlan[] = [];
  for (const plan of planned.plans) {
    if (plan.action !== 'migrate') { plans.push(plan); continue; }
    const applied = applyMigration(root, plan, options.stamp);
    plans.push(applied.ok ? plan : { ...plan, action: 'refuse', reason: applied.reason });
  }
  return { plans, ok: plans.every((plan) => plan.action !== 'refuse') };
}

function report(root: string, result: MigrationResult, write: boolean): void {
  if (result.plans.length === 0) {
    disciplineInfo('No Step 5 packets found under .discipline/packets/.');
    return;
  }
  for (const plan of result.plans) {
    if (plan.action === 'skip') { disciplineInfo(`  ${plan.file}: ${plan.reason}`); continue; }
    if (plan.action === 'refuse') { disciplineWarn(`  ${plan.file}: REFUSED, ${plan.reason}`); continue; }
    const verb = write ? 'migrated' : 'would migrate';
    disciplineInfo(`  ${plan.file}: ${verb} to ${plan.target} (slice ${plan.slice}, status: ${plan.status})${plan.reason ? ` — ${plan.reason}` : ''}`);
  }
  if (!write) {
    disciplineInfo('');
    disciplineInfo('This was a dry run. Re-run with --write to apply it; the originals are kept under .discipline/packets/legacy/ with their SHA-256.');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = minimist(process.argv.slice(2));
  const root = resolveProjectRoot(args['project-dir']);
  const write = args.write === true;
  if (write && args.check === true) disciplineError('Pass --check or --write, not both.');
  const stamp = typeof args.stamp === 'string' ? args.stamp : new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const result = migratePackets(root, { write, stamp });
  report(root, result, write);
  if (!result.ok) {
    disciplineError('At least one packet was refused. Nothing was guessed; fix the packets above and run this again.');
  }
  process.exit(0);
}
