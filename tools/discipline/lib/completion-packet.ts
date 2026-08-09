/**
 * ONE reading of what a SLICE_COMPLETION_PACKET says.
 *
 * The progress engine and the consumption engine both act on the same packet, so they cannot be
 * allowed to read it differently. They did: `update-progress` required EXACTLY ONE `GATE_STATE`
 * declaration (two conflicting ones are `unverified`, fail-closed), while the consumption check
 * took the first match, so a packet declaring `passed` and then `failed` was unverified for the
 * log and green for consumption. That is the same false green twice over, from one file.
 *
 * Everything either engine needs to interpret a completion packet lives here: the bullet parser,
 * the section/inline field readers, the outcome vocabulary and the gate rule. Neither file may
 * grow a second copy of any of them.
 */

export type GateState = 'passed' | 'failed' | 'unverified';

/** Outcomes that close a slice. Everything else leaves it open, whatever the gate says. */
export const TERMINAL_OUTCOMES = new Set(['done', 'shipped']);
/** Outcomes that explicitly keep a slice open. An unrecognized one is treated as open too. */
export const OPEN_OUTCOMES = new Set(['partial', 'blocked', 'ready', 'wip', 'in-progress']);

export function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function cleanBullet(s: string): string { return s.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim(); }

/** A value that carries no information: empty, "none", "n/a", any punctuation/case. */
export function isNone(text: string): boolean {
  const bare = text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return bare === '' || bare === 'none' || bare === 'na';
}

/** Raw text under a "## Name" or "### Name" heading (case-insensitive), up to the next heading. */
export function sectionText(body: string, name: string): string | null {
  return body.match(new RegExp(`#{2,3}\\s+${escapeRe(name)}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`, 'i'))?.[1]?.trim() || null;
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

/**
 * Top-level bullets of a section. This is the canonical SLICE_COMPLETION_PACKET shape the
 * discipline-step5-slice skill teaches: "### Scope delivered\n- item one\n  wrapped\n- item two".
 */
export function sectionItems(body: string, name: string): string[] {
  const text = sectionText(body, name);
  return text ? collectBullets(text.split('\n')) : [];
}

/** Legacy inline "KEY: value" field (pre-skill packet shape); still honored for back-compat. */
export function inlineField(body: string, name: string): string | null {
  return body.match(new RegExp(`^[-*]?\\s*${escapeRe(name)}[:\\s]+(.+)`, 'im'))?.[1]?.trim() || null;
}

export function meaningfulItems(items: string[]): string[] {
  return items.map(cleanBullet).filter((s) => s && !isNone(s));
}

export function firstMeaningful(inline: string | null, items: string[]): string | null {
  if (inline && !isNone(inline)) return cleanBullet(inline);
  return meaningfulItems(items)[0] || null;
}

/**
 * The outcome a completion packet states, or null when it states none. Read from the legacy
 * inline `OUTCOME:` field or the `### Outcome` section, in that order, exactly as the progress
 * log records it. An unrecognized value is returned as written (truncated) so the caller can
 * name it in a refusal instead of guessing what the operator meant.
 */
export function completionOutcome(body: string): string | null {
  const raw = firstMeaningful(inlineField(body, 'OUTCOME'), sectionItems(body, 'Outcome'));
  if (!raw) return null;
  const known = [...TERMINAL_OUTCOMES, ...OPEN_OUTCOMES].find((k) => raw.toLowerCase().startsWith(k));
  if (known) return known;
  const firstClause = raw.split(/[.;,]/)[0].trim().slice(0, 40);
  return firstClause || null;
}

/** True when the outcome closes the slice. `null` (nothing stated) never closes it. */
export function isTerminalOutcome(outcome: string | null): boolean {
  return outcome !== null && TERMINAL_OUTCOMES.has(outcome);
}

const GATE_STATE_PREFIX = /^gate[_\s-]?state\s*[:=]/i;
const GATE_STATE_EXACT = /^gate[_\s-]?state\s*[:=]\s*(passed|failed|unverified)\s*$/i;

/**
 * The gate state comes ONLY from an explicit, machine-readable GATE_STATE declaration; it is never
 * inferred from evidence prose. Free text is language-dependent and collides across locales (an
 * English failure-word blocklist read Spanish "sin red"/"0 errores" and even English "0 errors" as
 * a failure, recording a false red that stalls a green pipeline), and any positive-word allowlist
 * leaks the mirror-image false green ("cannot pass", "NOT PASSED"). So: EXACTLY ONE declaration
 * whose value is exactly one of passed|failed|unverified wins; a missing, placeholder,
 * trailing-prose, non-exact, or CONFLICTING declaration is 'unverified' (fail-closed). Evidence
 * bullets explain a state to a human but never create one.
 */
export function gateStateOf(items: string[]): GateState {
  const declarations = items.map((it) => it.trim()).filter((it) => GATE_STATE_PREFIX.test(it));
  if (declarations.length !== 1) return 'unverified';
  const match = declarations[0].match(GATE_STATE_EXACT);
  return match ? (match[1].toLowerCase() as GateState) : 'unverified';
}

/** The gate state + its raw text, or null when the packet has no gate section at all. */
export function completionGate(body: string): { state: GateState; raw: string } | null {
  const inline = inlineField(body, 'GATES');
  const items = inline ? [cleanBullet(inline)] : meaningfulItems(sectionItems(body, 'Gates passed').concat(sectionItems(body, 'Gates')));
  if (!items.length) return null;
  return { state: gateStateOf(items), raw: items.join('; ') };
}
