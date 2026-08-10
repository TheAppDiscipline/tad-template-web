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
import { isActiveSlicePacketName, resolvePacketIdentity, sliceFileToken, slicePacketFileName } from './lib/slice-identity.js';
import { evaluateAsV2, step5Format } from './lib/step5-schema.js';

export type MigrationAction = 'migrate' | 'skip' | 'refuse' | 'not-run';

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
  /** Set when an apply failed: whether the previous state was fully restored. */
  rollback?: 'complete' | 'incomplete';
}

export interface MigrationResult {
  plans: MigrationPlan[];
  /** True when every packet either migrated or was already fine. */
  ok: boolean;
}

export type MigrationOutcome = { ok: true } | { ok: false; reason: string; rollback?: 'complete' | 'incomplete' };

const V2_VERSION = '2.0.0';

/**
 * Which files this command considers: ACTIVE Step 5 packets, decided by the one function that owns
 * that question. Matching the name pattern alone swept up `_13.consumed.md`, `_13.superseded.md`
 * and `_13.archived.md`, so a migration could turn a packet Fase 1 had closed into a fresh active
 * `STEP_5_SLICE_PACKET_13.md`: history, reopened by a format change.
 */
function candidates(packetsDir: string): string[] {
  if (!fs.existsSync(packetsDir)) return [];
  return fs.readdirSync(packetsDir).filter(isActiveSlicePacketName).sort();
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

    const classified = step5Format(content);
    if (classified.format === 'v2') {
      plans.push({ file, action: 'skip', reason: 'already v2' });
      continue;
    }
    // A version this tooling cannot read is not something to rewrite: replacing that frontmatter
    // with 2.0.0 would be the migration declaring a contract the packet never met.
    if (classified.format === 'unsupported') {
      plans.push({ file, action: 'refuse', reason: `${classified.reason}; fix the version by hand, then run this again` });
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

/** Injectable so a test can fail the migration AFTER a write and check what survives. */
export interface MigrationOps {
  /** `exclusive` means the write must fail rather than overwrite an existing file. */
  write: (file: string, data: Buffer | string, exclusive: boolean) => void;
  remove: (file: string) => void;
}

const DEFAULT_OPS: MigrationOps = {
  write: (file, data, exclusive) => fs.writeFileSync(file, data, exclusive ? { flag: 'wx' } : {}),
  remove: (file) => fs.rmSync(file),
};

/**
 * Migrate ONE packet as a transaction: either all three outputs exist and the source is gone, or
 * the directory looks exactly as it did.
 *
 * The order used to be write-then-check: the backup was created, the `.sha256` was written over
 * whatever was already there, and only afterwards did the code ask whether the target was free. So
 * a collision left a backup behind that made every later attempt refuse ("backup already exists"),
 * and a pre-existing hash file was silently replaced. Now every output is checked BEFORE any of
 * them is created, each is created exclusively so a race loses instead of overwriting, and a
 * failure removes what this call made. The source is deleted last, when everything else is on disk.
 */
export function applyMigration(root: string, plan: MigrationPlan, stamp: string, ops: MigrationOps = DEFAULT_OPS): MigrationOutcome {
  if (plan.action !== 'migrate' || !plan.slice || !plan.target || !plan.status) {
    return { ok: false, reason: 'nothing to apply' };
  }
  const packetsDir = path.join(root, '.discipline', 'packets');
  const legacyDir = path.join(packetsDir, 'legacy');
  const source = path.join(packetsDir, plan.file);
  const target = path.join(packetsDir, plan.target);
  const backup = path.join(legacyDir, `${path.basename(plan.file, '.md')}.${sliceFileToken(plan.slice)}.md`);
  const backupHash = `${backup}.sha256`;
  // A packet already under its canonical name is rewritten IN PLACE: its target is its source.
  const inPlace = path.resolve(source) === path.resolve(target);
  const original = fs.readFileSync(source);

  // 1. PREFLIGHT: every path this call would create has to be free, decided before it creates any.
  for (const output of [backup, backupHash, ...(inPlace ? [] : [target])]) {
    if (fs.existsSync(output)) {
      return { ok: false, reason: `${path.relative(root, output).replace(/\\/g, '/')} already exists; nothing is overwritten` };
    }
  }

  const { meta } = parsePacketMeta(original.toString('utf-8'));
  const migrated = buildV2Frontmatter(plan.slice, plan.status, stamp, meta) + stripFrontmatter(original.toString('utf-8'));
  const digest = `${crypto.createHash('sha256').update(original).digest('hex')}  ${plan.file}\n`;

  // 2. Create. The rollback undoes every output this call COULD have created, not the ones it got
  // around to recording: a failure that happens after the bytes have landed is the only kind worth
  // defending against, and "did we reach the line that appends to a list" is not the same question
  // as "is the file there".
  const outputs = [backup, backupHash, ...(inPlace ? [] : [target])];
  const legacyDirExisted = fs.existsSync(legacyDir);
  const relative = (file: string) => path.relative(root, file).replace(/\\/g, '/');

  /**
   * Undo everything this call created, and make sure the ORIGINAL is back.
   *
   * Removing the outputs is only half of it. The last step of the migration deletes the source, and
   * a delete that succeeds and then throws left the packet gone while the rollback removed the
   * backup that held its only other copy: the migration failed, deleted every copy, and reported
   * "Nothing was left behind". The bytes are in memory the whole time, so put them back, and when
   * that cannot be done SAY SO rather than claiming a clean rollback.
   */
  const rollback = (): { complete: boolean; problems: string[] } => {
    const problems: string[] = [];
    for (const file of [...outputs].reverse()) {
      try { if (fs.existsSync(file)) ops.remove(file); } catch (err) { problems.push(`could not remove ${relative(file)}: ${err instanceof Error ? err.message : err}`); }
    }
    // The source, byte for byte. It is missing when the failure WAS its removal, and it holds the
    // migrated bytes when the rewrite was in place; both are "not as we found it".
    let intact = false;
    try { intact = fs.existsSync(source) && fs.readFileSync(source).equals(original); } catch { intact = false; }
    if (!intact) {
      try {
        ops.write(source, original, false);
      } catch (err) {
        problems.push(`could not restore ${plan.file}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!legacyDirExisted && fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).length === 0) {
      try { fs.rmdirSync(legacyDir); } catch { /* an empty directory left behind is not data loss */ }
    }
    return { complete: problems.length === 0, problems };
  };

  const failed = (what: string, undone: { complete: boolean; problems: string[] }): { ok: false; reason: string; rollback: 'complete' | 'incomplete' } => ({
    ok: false,
    rollback: undone.complete ? 'complete' : 'incomplete',
    reason: undone.complete
      ? `${what}. Nothing was left behind; run this again once the cause is fixed.`
      : `${what}. ROLLBACK INCOMPLETE: ${undone.problems.join('; ')}. Do not re-run until you have checked ${relative(source)} and ${relative(backup)} by hand.`,
  });

  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    ops.write(backup, original, true);
    ops.write(backupHash, digest, true);
    ops.write(target, migrated, !inPlace);
  } catch (err) {
    return failed(`${err instanceof Error ? err.message : err}`, rollback());
  }

  // 3. The old file goes LAST, and only when it moved to a new name. Its content is in legacy/.
  if (!inPlace) {
    try {
      ops.remove(source);
    } catch (err) {
      return failed(`could not remove ${plan.file} after migrating it: ${err instanceof Error ? err.message : err}`, rollback());
    }
  }
  return { ok: true };
}

export function migratePackets(root: string, options: { write: boolean; stamp: string }, ops: MigrationOps = DEFAULT_OPS): MigrationResult {
  const planned = planMigration(root, options.stamp);
  if (!options.write) return planned;

  const plans: MigrationPlan[] = [];
  // An incomplete rollback means a file is in a state nobody can describe, and the command has just
  // told the operator not to run it again until they have looked. Carrying on to mutate the NEXT
  // packet in the same breath makes that instruction impossible to follow, and puts more of the
  // project into the state it is asking to be inspected. One bad packet whose rollback DID complete
  // is different: nothing was lost, so the rest of the batch proceeds.
  let halted = false;
  for (const plan of planned.plans) {
    if (halted) {
      plans.push({ ...plan, action: 'not-run', reason: 'not run: the batch stopped after a rollback that could not be completed' });
      continue;
    }
    if (plan.action !== 'migrate') { plans.push(plan); continue; }
    const applied = applyMigration(root, plan, options.stamp, ops);
    if (applied.ok) { plans.push(plan); continue; }
    plans.push({ ...plan, action: 'refuse', reason: applied.reason, rollback: applied.rollback });
    if (applied.rollback === 'incomplete') halted = true;
  }
  return { plans, ok: plans.every((plan) => plan.action !== 'refuse' && plan.action !== 'not-run') };
}

function report(root: string, result: MigrationResult, write: boolean): void {
  if (result.plans.length === 0) {
    disciplineInfo('No Step 5 packets found under .discipline/packets/.');
    return;
  }
  for (const plan of result.plans) {
    if (plan.action === 'skip') { disciplineInfo(`  ${plan.file}: ${plan.reason}`); continue; }
    if (plan.action === 'not-run') { disciplineWarn(`  ${plan.file}: NOT RUN, ${plan.reason}`); continue; }
    if (plan.action === 'refuse') {
      disciplineWarn(`  ${plan.file}: REFUSED, ${plan.reason}`);
      if (plan.rollback === 'incomplete') disciplineWarn('  STOPPING: the rest of this batch was not run. Check the files named above before running anything again.');
      continue;
    }
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
