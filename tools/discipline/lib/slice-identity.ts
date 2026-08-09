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

/**
 * A slice heading: `## Slice <id>`, a bare `## S13` / `## 13`, and either form with the legacy
 * `[status]` marker that run.ts reads (`## Slice S13 [ready]`, `### Slice S13.2 [blocked]`).
 * After the id only that marker, a dash/colon separator or end of line may follow, which is what
 * keeps `## 4) Ready Slices` from reading as slice 4; the `s?\d` rule below is what keeps
 * `### C1` / `### AC2` / `### R1` from reading as slices at all.
 */
const SLICE_HEADING_RE = /^(#{2,4})[ \t]+(?:slice[ \t]+)?([A-Za-z][A-Za-z0-9._-]*|\d[A-Za-z0-9._-]*)[ \t]*(?:\[[^\]]*\])?[ \t]*(?:[-–—:][ \t]*.*)?$/gim;

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
  | { ok: true; heading: SliceHeading; id: string; tableStatus: string | null }
  | { ok: false; reason: 'not-found' | 'duplicate' | 'contradiction'; message: string; candidates: string[] };

/** A row of the §4 Ready Slices status table. */
export interface ReadySlicesRow {
  rawId: string;
  id: string;
  status: string | null;
  line: number;
}

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
    const match = new RegExp(SLICE_HEADING_RE.source, 'i').exec(lines[i]);
    if (!match) continue;
    // Without the keyword the id must look like a slice id, so acceptance-criteria headings
    // (`### C1`, `### AC2`) and section headings never become slices.
    const withKeyword = /^#{2,4}[ \t]+slice[ \t]/i.test(lines[i]);
    if (!withKeyword && !/^s?\d/i.test(match[2])) continue;
    const id = normalizeSliceId(match[2]);
    if (!id) continue;
    headings.push({
      raw: lines[i],
      rawId: match[2],
      id,
      // The `[status]` marker belongs to the status reader, not to the title.
      title: (lines[i].slice(match[0].indexOf(match[2]) + match[2].length) || '')
        .trim().replace(/^\[[^\]]*\]\s*/, '').replace(/^[-–—:]\s*/, ''),
      line: i,
      level: match[1].length,
    });
  }
  return headings;
}

/** Strip markdown emphasis and backticks from a table cell. */
function cleanCell(cell: string): string {
  return cell.trim().replace(/^[`*_]+|[`*_]+$/g, '').trim();
}

/**
 * The status table inside `## 4) Ready Slices`, when there is one. A plan's Ready Slices section
 * also carries prose tables (the dogfood project has a "what blocks it" table), so a table only
 * counts as the status table when its header has both a slice column and a status column. Reading
 * any table as statuses would invent states nobody wrote.
 */
export function parseReadySlicesTable(taskPlan: string): ReadySlicesRow[] {
  const lines = taskPlan.split('\n');
  const sectionStart = lines.findIndex((line) => /^#{2,3}\s+(?:\d+\)\s*)?Ready Slices\s*$/i.test(line));
  if (sectionStart === -1) return [];
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { sectionEnd = i; break; }
  }

  const rows: ReadySlicesRow[] = [];
  for (let i = sectionStart + 1; i < sectionEnd - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
    const header = lines[i].split('|').slice(1, -1).map((c) => cleanCell(c).toLowerCase());
    const sliceCol = header.findIndex((c) => /^(#\s*)?slice$/.test(c) || c === 'slice id');
    const statusCol = header.findIndex((c) => /^(status|estado)$/.test(c));
    if (sliceCol === -1 || statusCol === -1) continue;

    for (let r = i + 2; r < sectionEnd; r++) {
      if (!lines[r].trim().startsWith('|')) break;
      const cells = lines[r].split('|').slice(1, -1).map(cleanCell);
      const rawId = cells[sliceCol] ?? '';
      const id = idFromText(rawId);
      if (!id) continue;
      const status = cells[statusCol] ? cleanCell(cells[statusCol]).toLowerCase() : null;
      rows.push({ rawId, id, status: status && status !== '-' ? status : null, line: r });
    }
  }
  return rows;
}

/**
 * Resolve a requested slice id against the plan. Exact match on the normalized id only: a request
 * for `1` never resolves to `S13`, two headings for the same slice are an error rather than a
 * first-one-wins pick, and a table row that disagrees with the detailed section's status is a
 * contradiction, not a tie to break. Both places are written by hand, so when they disagree the
 * honest answer is that the plan does not say what state the slice is in.
 */
export function resolveSlice(taskPlan: string, requested: string): SliceResolution {
  const wanted = normalizeSliceId(requested);
  const headings = findSliceHeadings(taskPlan);
  const matches = headings.filter((heading) => heading.id === wanted);
  const tableRows = parseReadySlicesTable(taskPlan).filter((row) => row.id === wanted);

  if (tableRows.length > 1) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `Slice "${requested}" appears ${tableRows.length} times in the §4 Ready Slices table (lines ${tableRows.map((r) => r.line + 1).join(', ')}). Two rows for one slice make its status ambiguous; keep one.`,
      candidates: headings.map((h) => h.rawId),
    };
  }

  if (matches.length === 1) {
    const tableStatus = tableRows[0]?.status ?? null;
    const sectionStatus = sectionStatusOf(taskPlan, matches[0]);
    if (tableStatus && sectionStatus && tableStatus !== sectionStatus.toLowerCase()) {
      return {
        ok: false,
        reason: 'contradiction',
        message: `Slice "${requested}" is "${tableStatus}" in the §4 Ready Slices table (line ${tableRows[0].line + 1}) and "${sectionStatus}" in its own section (line ${matches[0].line + 1}). Fix the plan; the pipeline will not pick one for you.`,
        candidates: headings.map((h) => h.rawId),
      };
    }
    return { ok: true, heading: matches[0], id: wanted, tableStatus };
  }

  // No heading, but the table knows the slice: the plan lists it without expanding it.
  if (matches.length === 0 && tableRows.length === 1) {
    return {
      ok: false,
      reason: 'not-found',
      message: `Slice "${requested}" is in the §4 Ready Slices table (line ${tableRows[0].line + 1}) but has no expanded section in task_plan.md. Expand it in Step 4 before running it.`,
      candidates: headings.map((h) => h.rawId),
    };
  }

  const candidates = headings.map((heading) => heading.rawId);
  if (matches.length === 0 && tableRows.length === 0) {
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

/** One place a packet says which slice it is for, kept with its source so errors can name it. */
export interface SliceDeclaration {
  source: 'filename' | 'frontmatter' | 'SLICE field' | 'Slice heading' | 'Slice section';
  raw: string;
  id: string;
}

/** Pull a slice id out of free text like `S27E3b - Title` or `- Slice 13`. */
function idFromText(text: string): string | null {
  const cleaned = text.trim().replace(/^[-*]\s*/, '').replace(/^[`*_]+|[`*_]+$/g, '');
  const match = cleaned.match(/^(?:slice\s+)?([A-Za-z]?\d[A-Za-z0-9._-]*|[A-Za-z][A-Za-z0-9._-]*)/i);
  if (!match) return null;
  const id = normalizeSliceId(match[1]);
  return id || null;
}

/**
 * Every declaration of identity a packet carries, in no particular order of authority. There is
 * deliberately no winner: real packets carry the id in more than one place (the app's packets
 * have both frontmatter `slice:` and a root `SLICE:` line), and picking one silently is how a
 * contradiction survives. The caller compares them and refuses when they disagree.
 */
export function readSliceDeclarations(content: string, fileName?: string): SliceDeclaration[] {
  const declarations: SliceDeclaration[] = [];
  const push = (source: SliceDeclaration['source'], raw: string, id: string | null) => {
    if (id) declarations.push({ source, raw: raw.trim(), id });
  };

  if (fileName) {
    const fromName = sliceFromPacketFileName(fileName);
    if (fromName) push('filename', path.basename(fileName), fromName);
  }

  const { meta } = parsePacketMeta(content);
  if (meta && (typeof meta.slice === 'string' || typeof meta.slice === 'number')) {
    push('frontmatter', String(meta.slice), normalizeSliceId(String(meta.slice)));
  }

  // Everything below reads the BODY. Scanning the whole file would let the frontmatter's own
  // `slice:` line answer as the root `SLICE:` field (the match is case-insensitive), which hides
  // exactly the contradiction this function exists to surface.
  const body = content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  // Root field, the form Step 4 emits and every real packet carries: `SLICE: S27E3b - Title`.
  // Only the HEADER counts, meaning the lines before the first `##` section. Prose further down
  // wraps, and a sentence that breaks right before "slice: contra el supermercado real..." is not
  // a declaration; that exact line exists in the dogfood project's packets.
  // matchAll, not match: two SLICE: lines in the header declare two slices, and reading only the
  // first would answer with one of them as if the other were not there.
  const bodyLines = body.split('\n');
  const titleLine = bodyLines.findIndex((line) => /^#{1,4}[ \t]/.test(line));
  const nextHeading = bodyLines.findIndex((line, index) => index > titleLine && /^#{1,4}[ \t]/.test(line));
  const header = bodyLines.slice(0, nextHeading === -1 ? bodyLines.length : nextHeading).join('\n');
  for (const field of header.matchAll(/^[ \t]*SLICE:[ \t]*(.+?)[ \t]*$/gim)) {
    push('SLICE field', field[1], idFromText(field[1]));
  }

  // `## Slice S13 - Title` / `## S13`. Without the `Slice` keyword the id must look like a slice
  // id (`S13`, `13`, `13.2`): packets are full of internal headings like `### C1`, `### AC2` or
  // `### R1`, and reading those as identity turned every real legacy packet into a contradiction.
  for (const heading of body.matchAll(SLICE_HEADING_RE)) {
    const withKeyword = /^#{2,4}\s+slice\s/i.test(heading[0]);
    if (!withKeyword && !/^s?\d/i.test(heading[2])) continue;
    push('Slice heading', heading[0], normalizeSliceId(heading[2]));
  }

  // `## Slice` section whose first entry is the id.
  for (const section of body.matchAll(/^#{2,4}[ \t]+Slice[ \t]*$\r?\n([\s\S]*?)(?=\r?\n#{1,4}[ \t]|$)/gim)) {
    const firstEntry = section[1].split('\n').map((line) => line.trim()).find((line) => line !== '');
    if (firstEntry) push('Slice section', firstEntry, idFromText(firstEntry));
  }

  return declarations;
}

export type PacketIdentity =
  | { ok: true; id: string | null; declarations: SliceDeclaration[] }
  | { ok: false; message: string; declarations: SliceDeclaration[] };

/**
 * The slice a packet is for, or a refusal when it claims to be for two. `id: null` means the
 * packet says nothing at all, which only the unambiguous legacy path may accept.
 */
export function resolvePacketIdentity(content: string, fileName?: string): PacketIdentity {
  const declarations = readSliceDeclarations(content, fileName);
  const distinct = [...new Set(declarations.map((d) => d.id))];
  if (distinct.length > 1) {
    const detail = declarations.map((d) => `${d.source} says "${d.id}" (${d.raw})`).join('; ');
    return {
      ok: false,
      message: `Contradictory slice declarations in ${fileName ? path.basename(fileName) : 'the packet'}: ${detail}. Make them agree; do not leave the pipeline to pick one.`,
      declarations,
    };
  }
  return { ok: true, id: distinct[0] ?? null, declarations };
}

/** The single slice a packet declares, or null when it declares none or contradicts itself. */
export function packetSliceId(content: string, fileName?: string): string | null {
  const identity = resolvePacketIdentity(content, fileName);
  return identity.ok ? identity.id : null;
}

/** The `- Status: <value>` a slice's own section declares, or null. */
export function sectionStatusOf(taskPlan: string, heading: SliceHeading): string | null {
  const lines = taskPlan.split('\n');
  let end = lines.length;
  for (let i = heading.line + 1; i < lines.length; i++) {
    const level = lines[i].match(/^(#{1,6})\s/);
    if (level && level[1].length <= heading.level) { end = i; break; }
  }
  const section = lines.slice(heading.line, end).join('\n');
  const statusLine = section.match(/^[-*]?\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(.+)$/im);
  if (statusLine) return cleanCell(statusLine[1]).toLowerCase();
  const bracket = heading.raw.match(/\[([^\]]+)\]/);
  return bracket ? cleanCell(bracket[1]).toLowerCase() : null;
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

  // The plan decides first. A packet whose slice is not in task_plan.md exactly once is an orphan:
  // `STEP_5_SLICE_PACKET_99.md` plus `--slice 99` would otherwise assemble and run a slice the plan
  // never planned, which is the same class of miss as picking up someone else's packet.
  if (taskPlan !== undefined) {
    const resolution = resolveSlice(taskPlan, wanted);
    if (!resolution.ok) {
      return {
        ok: false,
        reason: resolution.reason === 'not-found' ? 'missing' : 'mismatch',
        message: `${resolution.message} A packet cannot be used for a slice the plan does not state exactly once.`,
      };
    }
  }

  const suffixed = path.join(dir, slicePacketFileName(wanted));
  if (fs.existsSync(suffixed) && fs.statSync(suffixed).isFile()) {
    // The filename counts as one declaration, so a body that names another slice is a
    // contradiction rather than a filename-wins situation.
    // The filename is itself a declaration, so a body naming another slice comes back as a
    // contradiction here, listing every source. There is no filename-wins path on purpose.
    const identity = resolvePacketIdentity(fs.readFileSync(suffixed, 'utf-8'), suffixed);
    if (!identity.ok) return { ok: false, reason: 'mismatch', message: identity.message };
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

  const identity = resolvePacketIdentity(fs.readFileSync(generic, 'utf-8'), generic);
  if (!identity.ok) return { ok: false, reason: 'mismatch', message: identity.message };
  const declared = identity.id;
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

/** What a packet says about itself, beyond which slice it is for. */
export interface ActiveSlicePacket {
  path: string;
  fileName: string;
  /** The single slice it declares, or null when it declares none. */
  sliceId: string | null;
  /** Set when the packet declares two different slices. The packet is unusable until fixed. */
  identityError: string | null;
  /** Frontmatter `status:` if present, else the header `STATUS:` field, lowercased. */
  status: string | null;
  legacy: boolean;
}

/**
 * The status a packet claims: frontmatter `status:` first, then the header `STATUS:` field that
 * Step 4 writes. Only the header is read for the second form, for the same reason the SLICE field
 * is: prose further down wraps, and a sentence is not a state.
 */
export function packetStatus(content: string): string | null {
  const { meta } = parsePacketMeta(content);
  if (meta && typeof meta.status === 'string' && meta.status.trim()) return meta.status.trim().toLowerCase();

  const body = content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = body.split('\n');
  const titleLine = lines.findIndex((line) => /^#{1,4}[ \t]/.test(line));
  const nextHeading = lines.findIndex((line, index) => index > titleLine && /^#{1,4}[ \t]/.test(line));
  const header = lines.slice(0, nextHeading === -1 ? lines.length : nextHeading).join('\n');
  const field = header.match(/^[ \t]*STATUS:[ \t]*(.+?)[ \t]*$/im);
  return field ? field[1].trim().toLowerCase() : null;
}

/** Active (not archived) Step 5 packets, each with what it declares about itself. */
export function activeSlicePackets(root: string): ActiveSlicePacket[] {
  const dir = path.join(root, '.discipline', 'packets');
  if (!fs.existsSync(dir)) return [];
  const found: ActiveSlicePacket[] = [];
  for (const file of fs.readdirSync(dir)) {
    // Archived packets carry extra name segments (`.S12.consumed.md`); they are history, not work.
    if (!/^STEP_5_SLICE_PACKET(_[A-Za-z0-9._-]+)?\.md$/i.test(file)) continue;
    const full = path.join(dir, file);
    const content = fs.readFileSync(full, 'utf-8');
    const identity = resolvePacketIdentity(content, file);
    found.push({
      path: full,
      fileName: file,
      sliceId: identity.ok ? identity.id : null,
      identityError: identity.ok ? null : identity.message,
      status: packetStatus(content),
      legacy: /^STEP_5_SLICE_PACKET\.md$/i.test(file),
    });
  }
  return found;
}

export type Step5Selection =
  | { ok: true; packets: Array<{ path: string; sliceId: string }> }
  | { ok: false; reason: string };

/**
 * The packets a Step 5 handoff may be assembled from, or a refusal. Fail closed on purpose: an
 * invalid packet sitting next to a valid one used to be skipped silently, a `draft` packet was
 * treated as work to hand off, and two files for one slice would have written the same
 * paste-ready twice in the same tick.
 */
export function selectStep5Packets(root: string): Step5Selection {
  const active = activeSlicePackets(root);
  if (active.length === 0) return { ok: true, packets: [] };

  const broken = active.filter((packet) => packet.identityError);
  if (broken.length > 0) {
    return { ok: false, reason: broken.map((packet) => packet.identityError).join(' | ') };
  }
  const anonymous = active.filter((packet) => !packet.sliceId);
  if (anonymous.length > 0) {
    return {
      ok: false,
      reason: `${anonymous.map((packet) => packet.fileName).join(', ')} do(es) not say which slice it is for, so it cannot be assembled per slice. Add a SLICE: line or rename it to STEP_5_SLICE_PACKET_<slice>.md.`,
    };
  }

  const byslice = new Map<string, ActiveSlicePacket[]>();
  for (const packet of active) byslice.set(packet.sliceId!, [...(byslice.get(packet.sliceId!) ?? []), packet]);
  const duplicated = [...byslice.entries()].filter(([, packets]) => packets.length > 1);
  if (duplicated.length > 0) {
    return {
      ok: false,
      reason: duplicated.map(([slice, packets]) => `slice ${slice} has ${packets.length} active packets (${packets.map((p) => p.fileName).join(', ')})`).join('; ') + '. Keep one per slice.',
    };
  }

  // Only READY packets are work. A draft is a spec still being written, and a consumed one is done.
  const ready = active.filter((packet) => packet.status === 'ready' && !isSliceConsumed(root, packet.sliceId!).consumed);
  return { ok: true, packets: ready.map((packet) => ({ path: packet.path, sliceId: packet.sliceId! })) };
}

/** Outcome of recording consumption. */
export type MarkResult = { ok: true; path: string } | { ok: false; reason: string };

/** The packet a slice's closure would be recorded in, proven to exist and to be editable. */
export type ConsumptionTarget = { ok: true; packet: ActiveSlicePacket } | { ok: false; reason: string };

/**
 * Find the ONE active packet a slice's closure belongs to and prove it can carry the record,
 * WITHOUT writing anything. The watcher runs this before it touches progress.md: discovering
 * afterwards that the packet is missing, duplicated or unwritable leaves progress.md saying the
 * slice closed while the packet still says ready, and nothing on disk agrees.
 *
 * An absent packet is a refusal, not a clean close. Step 5 implements from a packet, so a closure
 * with no packet to record it in is a project state a human has to look at, not something the
 * watcher may advance past on its own.
 */
export function resolveConsumptionTarget(root: string, sliceId: string): ConsumptionTarget {
  const wanted = normalizeSliceId(sliceId);
  const targets = activeSlicePackets(root).filter((packet) => packet.sliceId === wanted);

  if (targets.length === 0) {
    return {
      ok: false,
      reason: `no active packet for slice ${sliceId}: expected ${slicePacketFileName(wanted)}. If this project archived it, restore it or record the closure by hand before running the pipeline again`,
    };
  }
  if (targets.length > 1) {
    return {
      ok: false,
      reason: `slice ${sliceId} has ${targets.length} active packets (${targets.map((t) => t.fileName).join(', ')}); consumption is not recorded until one remains`,
    };
  }

  const target = targets[0];
  const probe = fs.readFileSync(target.path, 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (probe[0]?.trim() === '---' && probe.findIndex((line, index) => index > 0 && line.trim() === '---') === -1) {
    return { ok: false, reason: `${target.fileName} has an unterminated frontmatter block; fix it before the slice can be recorded as consumed` };
  }
  return { ok: true, packet: target };
}

/**
 * Record that a slice's packet was consumed, IN PLACE. The packet keeps its filename and its
 * content: the old ritual of renaming it to `.consumed.md` (or moving it out of a shared slot) is
 * what made two slices fight over one file and what lost the packet that was there before.
 */
export function markSliceConsumed(root: string, sliceId: string): MarkResult {
  const wanted = normalizeSliceId(sliceId);
  const resolved = resolveConsumptionTarget(root, wanted);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const target = resolved.packet;

  const content = fs.readFileSync(target.path, 'utf-8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const withoutBom = content.slice(bom.length);

  // The edit is bounded by the REAL frontmatter block. Searching the whole document for a
  // `status:` line would rewrite the header's own `STATUS: ready` and leave the metadata without
  // a state, which is the opposite of recording one.
  const lines = withoutBom.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    const front = ['---', 'status: consumed', `slice: ${wanted}`, '---', ''].join(eol);
    fs.writeFileSync(target.path, `${bom}${front}${eol}${withoutBom}`, 'utf-8');
    return { ok: true, path: target.path };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  // resolveConsumptionTarget already refused an unterminated block; this stays as a hard stop
  // rather than a write that would corrupt the file if the two ever disagree.
  if (closing === -1) return { ok: false, reason: `${target.fileName} has an unterminated frontmatter block` };

  const front = lines.slice(1, closing);
  const statusAt = front.findIndex((line) => /^status:/i.test(line));
  if (statusAt !== -1 && /^status:[ \t]*consumed[ \t]*$/i.test(front[statusAt])) return { ok: true, path: target.path }; // idempotent
  if (statusAt !== -1) front[statusAt] = 'status: consumed';
  else front.unshift('status: consumed');

  const next = [lines[0], ...front, ...lines.slice(closing)].join(eol);
  fs.writeFileSync(target.path, bom + next, 'utf-8');
  return { ok: true, path: target.path };
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

  // EVERY completion packet for the slice is read, not the first one found: a re-run leaves more
  // than one, and answering from whichever the directory listed first would let a green packet
  // hide a red one that was written after it.
  const verdicts: Array<{ file: string; gate: string | null }> = [];
  for (const file of fs.readdirSync(dir).filter((f) => /SLICE_COMPLETION_PACKET/i.test(f) && f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const identity = resolvePacketIdentity(content, file);
    if (!identity.ok) return { consumed: false, reason: `${file}: ${identity.message}` };
    if (identity.id !== wanted) continue;
    // Same rule the progress engine uses: the gate is green only on an explicit token, never on prose.
    const gate = content.match(/^\s*[-*]?\s*GATE_STATE:\s*(\S+)\s*$/im);
    verdicts.push({ file, gate: gate ? gate[1].toLowerCase() : null });
  }

  if (verdicts.length === 0) return { consumed: false, reason: `no SLICE_COMPLETION_PACKET for slice ${sliceId}` };

  const notGreen = verdicts.filter((v) => v.gate !== 'passed');
  if (notGreen.length > 0 && notGreen.length < verdicts.length) {
    return {
      consumed: false,
      reason: `slice ${sliceId} has completion packets that disagree: ${verdicts.map((v) => `${v.file} -> ${v.gate ?? 'no GATE_STATE'}`).join(', ')}. Resolve which one closes the slice.`,
    };
  }
  if (notGreen.length === verdicts.length) {
    const first = notGreen[0];
    return {
      consumed: false,
      reason: first.gate === null
        ? `${first.file} has no GATE_STATE token, so the gate is unverified`
        : `${first.file} records GATE_STATE: ${first.gate}`,
    };
  }
  return { consumed: true, reason: `${verdicts.map((v) => v.file).join(', ')} closes slice ${sliceId} with a green gate` };
}
