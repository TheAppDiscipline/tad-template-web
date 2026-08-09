/**
 * ONE reading of what a SLICE_COMPLETION_PACKET says, with ONE document scope.
 *
 * The progress engine and the consumption engine both act on the same packet, so they cannot be
 * allowed to read it differently. They have been caught doing exactly that three times:
 *
 *   1. Two parsers. `update-progress` required exactly one `GATE_STATE` declaration while the
 *      consumption check took the first match, so `passed` followed by `failed` was unverified for
 *      the log and green for consumption.
 *   2. One parser, first representation wins. An inline `GATES:` field made the sections invisible,
 *      and only the FIRST `### Gates passed` section was read, so a packet could carry a green
 *      inline field and a failed section and still consume.
 *   3. One parser, two scopes. The progress engine passed the packet body (frontmatter stripped),
 *      the consumption engine passed the whole file, so a declaration in frontmatter was visible to
 *      one and invisible to the other.
 *
 * So: this module takes the RAW FILE CONTENT, decides the canonical scope itself, ENUMERATES every
 * declaration in every supported location, and refuses when they do not agree. There is no
 * precedence between locations, because precedence is how a contradiction survives.
 */

export type GateState = 'passed' | 'failed' | 'unverified';

/** Outcomes that close a slice. Everything else leaves it open, whatever the gate says. */
export const TERMINAL_OUTCOMES = new Set(['done', 'shipped']);
/** Outcomes that explicitly keep a slice open. An unrecognized one is treated as open too. */
export const OPEN_OUTCOMES = new Set(['partial', 'blocked', 'ready', 'wip', 'in-progress']);

/** One declaration found in the packet, with the location that carried it. */
export interface Declaration {
  /** Where it was found, for error messages: `GATES: field`, `### Gates passed`, ... */
  where: string;
  /** The line as written. */
  raw: string;
  /** The normalized value. */
  value: string;
}

export function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function cleanBullet(s: string): string { return s.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim(); }

/** A value that carries no information: empty, "none", "n/a", any punctuation/case. */
export function isNone(text: string): boolean {
  const bare = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return bare === '' || bare === 'none' || bare === 'na';
}

/**
 * The canonical text both engines read: the packet body. A leading YAML frontmatter block and the
 * packet's own header lines (title, `STATUS:`, `SOURCE_STEP:`) are metadata, not statements about
 * the slice, and they are stripped here so neither engine can see a declaration the other cannot.
 * Passing an already-stripped body is safe: there is nothing left to strip.
 */
export function completionBody(fileContent: string): string {
  const normalized = fileContent.replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close !== -1) start = close + 1;
  }
  // Skip the packet's own title and the header fields parse-packet.ts treats as metadata.
  while (start < lines.length) {
    const line = lines[start].trim();
    if (line === '' || /^#{1,3}\s+\S/.test(line) === false && /^(STATUS|SOURCE_STEP):/i.test(line)) { start++; continue; }
    if (/^#{1,3}\s+\S/.test(line) && start === lines.findIndex((l, i) => i >= start && l.trim() !== '')) { start++; continue; }
    break;
  }
  return lines.slice(start).join('\n').trim();
}

/** Raw text of EVERY "## Name" / "### Name" section (case-insensitive), in file order. */
export function sectionTexts(body: string, name: string): string[] {
  const re = new RegExp(`#{2,3}[ \\t]+${escapeRe(name)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n#{2,3}[ \\t]|$)`, 'gi');
  return [...body.matchAll(re)].map((match) => match[1].trim()).filter((text) => text !== '');
}

/** Raw text under the first matching heading, kept for callers that only need one. */
export function sectionText(body: string, name: string): string | null {
  return sectionTexts(body, name)[0] ?? null;
}

/**
 * THE bullet parser: top-level bullets with their wrapped continuation lines rejoined. Every
 * caller goes through here so a "bullet" means the same thing on both sides of a merge. The
 * destructive Open Errors truncation came from a second, line-at-a-time parser that disagreed
 * with this one; do not reintroduce one.
 */
export function collectBullets(rawLines: string[]): string[] {
  const items: string[] = [];
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*[-*]\s+/.test(line)) {
      items.push(cleanBullet(line));
    } else if (line.trim() !== '' && !/^#{1,6}\s/.test(line)) {
      // continuation of the previous bullet, or a bare (bulletless) paragraph
      if (items.length) items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`.replace(/\s+/g, ' ').trim();
      else items.push(line.trim());
    }
  }
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Top-level bullets of EVERY section with that name, in file order. */
export function sectionItems(body: string, name: string): string[] {
  return sectionTexts(body, name).flatMap((text) => collectBullets(text.split('\n')));
}

/** Legacy inline "KEY: value" fields (pre-skill packet shape); EVERY occurrence, in file order. */
export function inlineFields(body: string, name: string): string[] {
  const re = new RegExp(`^[-*]?[ \\t]*${escapeRe(name)}[:\\s]+(.+)$`, 'gim');
  return [...body.matchAll(re)].map((match) => match[1].trim()).filter(Boolean);
}

/** The first inline occurrence, kept for callers that only need one. */
export function inlineField(body: string, name: string): string | null {
  return inlineFields(body, name)[0] ?? null;
}

export function meaningfulItems(items: string[]): string[] {
  return items.map(cleanBullet).filter((s) => s && !isNone(s));
}

export function firstMeaningful(inline: string | null, items: string[]): string | null {
  if (inline && !isNone(inline)) return cleanBullet(inline);
  return meaningfulItems(items)[0] || null;
}

/** Normalize an outcome to the shared vocabulary, or keep the first clause so it can be named. */
function normalizeOutcome(raw: string): string | null {
  const text = cleanBullet(raw).toLowerCase();
  if (!text || isNone(text)) return null;
  const known = [...TERMINAL_OUTCOMES, ...OPEN_OUTCOMES].find((k) => text.startsWith(k));
  if (known) return known;
  const firstClause = text.split(/[.;,]/)[0].trim().slice(0, 40);
  return firstClause || null;
}

/**
 * EVERY outcome declaration in the packet: the inline `OUTCOME:` fields and the first meaningful
 * item of EVERY `### Outcome` section. One value per location, so an Outcome section that adds an
 * explanatory bullet is not read as a second, contradictory outcome.
 */
export function outcomeDeclarations(fileContent: string): Declaration[] {
  const body = completionBody(fileContent);
  const found: Declaration[] = [];
  for (const raw of inlineFields(body, 'OUTCOME')) {
    const value = normalizeOutcome(raw);
    if (value) found.push({ where: 'OUTCOME: field', raw, value });
  }
  for (const text of sectionTexts(body, 'Outcome')) {
    const first = meaningfulItems(collectBullets(text.split('\n')))[0];
    if (!first) continue;
    const value = normalizeOutcome(first);
    if (value) found.push({ where: '### Outcome', raw: first, value });
  }
  return found;
}

export type OutcomeReading =
  | { ok: true; outcome: string | null; declarations: Declaration[] }
  | { ok: false; reason: string; declarations: Declaration[] };

/**
 * The outcome the packet states. Declarations from every location are compared: they may repeat,
 * but they may not disagree. `outcome: null` means the packet states none, which is not a failure
 * here (the caller decides what to do about it) and never a closure.
 */
export function readOutcome(fileContent: string): OutcomeReading {
  const declarations = outcomeDeclarations(fileContent);
  const distinct = [...new Set(declarations.map((d) => d.value))];
  if (distinct.length > 1) {
    return {
      ok: false,
      declarations,
      reason: `contradictory outcomes: ${declarations.map((d) => `${d.where} says "${d.value}"`).join('; ')}`,
    };
  }
  return { ok: true, outcome: distinct[0] ?? null, declarations };
}

/** The outcome, or null when there is none OR the packet contradicts itself. */
export function completionOutcome(fileContent: string): string | null {
  const reading = readOutcome(fileContent);
  return reading.ok ? reading.outcome : null;
}

/** True when the outcome closes the slice. `null` (nothing stated) never closes it. */
export function isTerminalOutcome(outcome: string | null): boolean {
  return outcome !== null && TERMINAL_OUTCOMES.has(outcome);
}

const GATE_STATE_PREFIX = /^gate[_\s-]?state\s*[:=]/i;
const GATE_STATE_EXACT = /^gate[_\s-]?state\s*[:=]\s*(passed|failed|unverified)\s*$/i;

/**
 * EVERY gate declaration in the packet: inline `GATES:` fields and the bullets of EVERY
 * `### Gates passed` / `### Gates` section. No location outranks another and none is skipped
 * because another one exists: a green inline field next to a failed section is a contradiction,
 * not a precedence question.
 */
export function gateDeclarations(fileContent: string): { declarations: Declaration[]; locations: number; evidence: string[] } {
  const body = completionBody(fileContent);
  const declarations: Declaration[] = [];
  const evidence: string[] = [];
  let locations = 0;

  const consider = (where: string, item: string) => {
    const line = cleanBullet(item);
    if (!line || isNone(line)) return;
    evidence.push(line);
    if (GATE_STATE_PREFIX.test(line)) declarations.push({ where, raw: line, value: line });
  };

  for (const raw of inlineFields(body, 'GATES')) {
    locations++;
    consider('GATES: field', raw);
  }
  for (const [name, texts] of [['### Gates passed', sectionTexts(body, 'Gates passed')], ['### Gates', sectionTexts(body, 'Gates')]] as const) {
    for (const text of texts) {
      locations++;
      for (const item of collectBullets(text.split('\n'))) consider(name, item);
    }
  }
  return { declarations, locations, evidence };
}

/**
 * The gate state comes ONLY from an explicit, machine-readable GATE_STATE declaration; it is never
 * inferred from evidence prose. Free text is language-dependent and collides across locales (an
 * English failure-word blocklist read Spanish "sin red"/"0 errores" and even English "0 errors" as
 * a failure, recording a false red that stalls a green pipeline), and any positive-word allowlist
 * leaks the mirror-image false green ("cannot pass", "NOT PASSED"). So: EXACTLY ONE declaration IN
 * THE WHOLE PACKET, whose value is exactly one of passed|failed|unverified, wins. Missing,
 * placeholder, trailing-prose, non-exact, repeated or conflicting declarations are all
 * 'unverified' (fail-closed). Evidence bullets explain a state to a human but never create one.
 *
 * Returns null only when the packet has no gate location at all, which is what makes the caller
 * refuse the packet outright instead of recording an unverified gate.
 */
export function completionGate(fileContent: string): { state: GateState; raw: string } | null {
  const { declarations, locations, evidence } = gateDeclarations(fileContent);
  if (locations === 0) return null;
  // The raw text keeps the human-readable evidence, which the progress log prints next to the state.
  const raw = evidence.join('; ') || '(no gate evidence)';
  if (declarations.length !== 1) return { state: 'unverified', raw };
  const match = declarations[0].value.match(GATE_STATE_EXACT);
  return { state: match ? (match[1].toLowerCase() as GateState) : 'unverified', raw };
}

/** Kept for callers that already hold the items of a single gate section. */
export function gateStateOf(items: string[]): GateState {
  const declarations = items.map((it) => it.trim()).filter((it) => GATE_STATE_PREFIX.test(it));
  if (declarations.length !== 1) return 'unverified';
  const match = declarations[0].match(GATE_STATE_EXACT);
  return match ? (match[1].toLowerCase() as GateState) : 'unverified';
}
