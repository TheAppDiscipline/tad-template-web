import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePacketMeta } from './packet-meta.js';

/**
 * One shared answer to "which slice is this?", used by the runner, the watcher, the assembler
 * and the validator. Before this module each of them had its own regex, so `## Slice S13` and
 * `## S13` meant the same slice in one place and different slices in another, and the generic
 * `STEP_5_SLICE_PACKET.md` was matched by filename alone: whatever was in that slot got
 * implemented, even when it described another slice.
 *
 * Two rules run through everything here:
 *   1. Compare on the NORMALIZED id, never on the raw string. `Slice S13`, `S13` and `13` are
 *      the same slice; `S13.2` and `S13-a` are not (composite ids stay distinct).
 *   2. Fail loud. A duplicate heading, a partial match or a packet that names another slice is
 *      an error with the candidates listed, never a silent pick.
 */

/** A `## Slice <id> - <title>` heading found in task_plan.md. */
export interface SliceHeading {
  /** The heading line, verbatim. */
  raw: string;
  /** The id exactly as written in the heading (`S13`, `13`, `3.2`). */
  rawId: string;
  /** The comparison form of that id. */
  id: string;
  /** Whatever follows the id on the heading line, trimmed. */
  title: string;
  /** 0-based line index in the file. */
  line: number;
  /** Heading level (2 for `##`). */
  level: number;
}

export type SliceResolution =
  | { ok: true; heading: SliceHeading; id: string }
  | { ok: false; reason: 'not-found' | 'duplicate'; message: string; candidates: string[] };

/**
 * The comparison form of a slice id: trimmed, lowercased, with a leading `slice` word and a
 * single leading `s` removed when what follows starts with a digit. `S13` -> `13`, `Slice 13`
 * -> `13`, `S13.2` -> `13.2`. A purely alphabetic id (`bootstrap`) keeps its letters, including
 * an initial `s` (`sync` stays `sync`, it is not slice `ync`).
 */
export function normalizeSliceId(raw: string): string {
  const trimmed = String(raw ?? '').trim().toLowerCase().replace(/^slice\s+/, '');
  return /^s\d/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/** Turn a slice id into the filename-safe form used by suffixed packets. */
export function sliceFileToken(sliceId: string): string {
  return normalizeSliceId(sliceId).replace(/[^a-z0-9._-]/g, '_');
}

/** The canonical packet filename for a slice. */
export function slicePacketFileName(sliceId: string): string {
  return `STEP_5_SLICE_PACKET_${sliceFileToken(sliceId)}.md`;
}

/** The canonical paste-ready filename for a slice. */
export function slicePasteReadyFileName(sliceId: string): string {
  return `step-5-${sliceFileToken(sliceId)}-input.md`;
}

/** The slice a suffixed packet filename claims, or null for the generic legacy name. */
export function sliceFromPacketFileName(fileName: string): string | null {
  const match = path.basename(fileName).match(/^STEP_5_SLICE_PACKET_(.+)\.md$/i);
  return match ? normalizeSliceId(match[1]) : null;
}

/**
 * Every slice heading in a task plan, in file order. Accepts `## Slice 13 - Name`, `## S13`,
 * `### Slice S13.2 [ready]` and the bare `## 13 - Name` a plan sometimes carries inside the
 * Ready Slices table. A heading whose id would be empty is not a slice heading.
 */
export function findSliceHeadings(taskPlan: string): SliceHeading[] {
  const headings: SliceHeading[] = [];
  const lines = taskPlan.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2,4})\s+(?:slice\s+)?([A-Za-z]?\d[A-Za-z0-9._-]*|[A-Za-z][A-Za-z0-9._-]*)\b(.*)$/i);
    if (!match) continue;
    // "## Ready Slices" and friends are section headings, not slices: an id must either carry a
    // digit or follow the word "slice".
    const declaredWithKeyword = /^#{2,4}\s+slice\s/i.test(lines[i]);
    if (!declaredWithKeyword && !/\d/.test(match[2])) continue;
    // A numbered section heading ("## 4) Ready Slices") is not slice 4. The id has to end the
    // line or be followed by a separator, never by the ")" of an outline number.
    if (!/^(?:\s*$|\s*[-–—:[(]|\s+\S)/.test(match[3]) || /^\)/.test(match[3])) continue;
    const id = normalizeSliceId(match[2]);
    if (!id) continue;
    headings.push({
      raw: lines[i],
      rawId: match[2],
      id,
      title: match[3].trim().replace(/^[-–—:]\s*/, ''),
      line: i,
      level: match[1].length,
    });
  }
  return headings;
}

/**
 * Resolve a requested slice id against the plan's headings. Exact match on the normalized id
 * only: a request for `1` never resolves to `S13`, and two headings for the same slice are an
 * error rather than a first-one-wins pick.
 */
export function resolveSlice(taskPlan: string, requested: string): SliceResolution {
  const wanted = normalizeSliceId(requested);
  const headings = findSliceHeadings(taskPlan);
  const matches = headings.filter((heading) => heading.id === wanted);

  if (matches.length === 1) return { ok: true, heading: matches[0], id: wanted };

  const candidates = headings.map((heading) => heading.rawId);
  if (matches.length === 0) {
    const near = headings.filter((heading) => heading.id.startsWith(wanted) || wanted.startsWith(heading.id));
    const hint = near.length > 0 ? ` Nearest headings: ${near.map((h) => h.rawId).join(', ')} (ids must match exactly).` : '';
    return {
      ok: false,
      reason: 'not-found',
      message: `Slice "${requested}" is not in task_plan.md.${hint}`,
      candidates,
    };
  }
  return {
    ok: false,
    reason: 'duplicate',
    message: `Slice "${requested}" appears ${matches.length} times in task_plan.md (lines ${matches.map((m) => m.line + 1).join(', ')}). Two headings for one slice make every status read ambiguous; keep one.`,
    candidates,
  };
}

/**
 * The slice a packet declares. Frontmatter `slice:` wins; otherwise the first entry under a
 * `## Slice` / `### Slice` section, which is how packets have always carried it. Returns the
 * normalized id, or null when the packet says nothing about which slice it is for.
 */
export function packetSliceId(content: string): string | null {
  const { meta } = parsePacketMeta(content);
  const fromMeta = meta && typeof meta.slice === 'string' ? meta.slice : null;
  if (fromMeta && normalizeSliceId(fromMeta)) return normalizeSliceId(fromMeta);

  const section = content.match(/^#{2,4}\s+Slice\s*$\r?\n([\s\S]*?)(?=\r?\n#{1,4}\s|$)/im);
  if (section) {
    const firstEntry = section[1].split('\n').map((line) => line.trim()).find((line) => line !== '');
    if (firstEntry) {
      const id = firstEntry.replace(/^[-*]\s*/, '').match(/^(?:slice\s+)?([A-Za-z]?\d[A-Za-z0-9._-]*)/i);
      if (id) return normalizeSliceId(id[1]);
    }
  }
  return null;
}

export type PacketLocation =
  | { ok: true; path: string; sliceId: string; legacy: boolean; warnings: string[] }
  | { ok: false; reason: 'missing' | 'mismatch' | 'ambiguous'; message: string };

/**
 * Find the STEP_5_SLICE_PACKET for a slice and prove it is that slice's packet.
 *
 * The suffixed `STEP_5_SLICE_PACKET_<slice>.md` is canonical: one packet per file, no slot to
 * move things in and out of. The generic `STEP_5_SLICE_PACKET.md` is still read for projects
 * mid-flight, but only when it identifies THIS slice and no other, because a generic packet
 * matched by filename alone is how an operator ends up implementing someone else's slice.
 */
export function locateSlicePacket(root: string, sliceId: string, taskPlan?: string): PacketLocation {
  const dir = path.join(root, '.discipline', 'packets');
  const wanted = normalizeSliceId(sliceId);
  const warnings: string[] = [];

  const suffixed = path.join(dir, slicePacketFileName(wanted));
  if (fs.existsSync(suffixed) && fs.statSync(suffixed).isFile()) {
    const declared = packetSliceId(fs.readFileSync(suffixed, 'utf-8'));
    if (declared && declared !== wanted) {
      return {
        ok: false,
        reason: 'mismatch',
        message: `${path.basename(suffixed)} declares slice "${declared}" but its filename says "${wanted}". Fix the packet or rename the file; do not guess which one is right.`,
      };
    }
    return { ok: true, path: suffixed, sliceId: wanted, legacy: false, warnings };
  }

  const generic = path.join(dir, 'STEP_5_SLICE_PACKET.md');
  if (!fs.existsSync(generic)) {
    return {
      ok: false,
      reason: 'missing',
      message: `No packet for slice "${sliceId}": expected .discipline/packets/${slicePacketFileName(wanted)}. Run Step 4 for this slice first.`,
    };
  }

  const declared = packetSliceId(fs.readFileSync(generic, 'utf-8'));
  if (declared && declared !== wanted) {
    return {
      ok: false,
      reason: 'mismatch',
      message: `STEP_5_SLICE_PACKET.md is for slice "${declared}", not "${sliceId}". Rename it to ${slicePacketFileName(declared)} and run Step 4 for this slice.`,
    };
  }
  if (!declared) {
    // No declaration at all: only safe when the plan leaves exactly one slice it could be.
    const headings = taskPlan ? findSliceHeadings(taskPlan) : [];
    if (headings.length !== 1 || headings[0].id !== wanted) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: `STEP_5_SLICE_PACKET.md does not say which slice it is for, and task_plan.md has ${headings.length} slice(s), so it cannot be matched to "${sliceId}". Add a "## Slice" section to the packet or rename it to ${slicePacketFileName(wanted)}.`,
      };
    }
    warnings.push(`STEP_5_SLICE_PACKET.md declares no slice; matched to "${sliceId}" because it is the only slice in task_plan.md.`);
  }
  warnings.push(`Using the legacy generic STEP_5_SLICE_PACKET.md. Rename it to ${slicePacketFileName(wanted)}: one packet per file is what keeps two slices from sharing a slot.`);
  return { ok: true, path: generic, sliceId: wanted, legacy: true, warnings };
}

/**
 * A slice packet is consumed only when its slice has a completion packet AND that packet records
 * a green gate. "The next packet exists" is not consumption: a slice that failed its gate is
 * still the slice being worked on, and marking it consumed would advance the pipeline over a red.
 */
export function isSliceConsumed(root: string, sliceId: string): { consumed: boolean; reason: string } {
  const dir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(dir)) return { consumed: false, reason: 'no packets directory' };
  const wanted = normalizeSliceId(sliceId);

  for (const file of fs.readdirSync(dir).filter((f) => /SLICE_COMPLETION_PACKET/i.test(f) && f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    if (packetSliceId(content) !== wanted) continue;
    // Same rule the progress engine uses: the gate is green only on an explicit token, never on prose.
    const gate = content.match(/^\s*[-*]?\s*GATE_STATE:\s*(\S+)\s*$/im);
    if (!gate) return { consumed: false, reason: `${file} has no GATE_STATE token, so the gate is unverified` };
    if (gate[1].toLowerCase() !== 'passed') return { consumed: false, reason: `${file} records GATE_STATE: ${gate[1]}` };
    return { consumed: true, reason: `${file} closes slice ${sliceId} with a green gate` };
  }
  return { consumed: false, reason: `no SLICE_COMPLETION_PACKET for slice ${sliceId}` };
}
