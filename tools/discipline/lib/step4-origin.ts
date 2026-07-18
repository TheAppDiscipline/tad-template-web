import * as fs from 'node:fs';
import * as path from 'node:path';
import { completionGateState } from '../update-progress.js';

/**
 * Shared Step 4 origin resolver.
 *
 * The Discipline Loop re-enters Step 4 from four origins (doctrine: "04 - Paso 4"):
 *   - `4`           first expansion from a validated STEP_4_EXECUTION_PACKET (no active reentry)
 *   - `4-reentry`   back from Step 5 after closing a slice (SLICE_COMPLETION_PACKET)
 *   - `4-feedback`  back from Step 6 when the feedback recommends a Step 4 mini-fix
 *   - `4-hardening` back from Step 7 with a hardening backlog (PROD_HARDENING_PACKET)
 *
 * ONE routing function, `routeFromPackets`, is the single source of truth for "what does the
 * pipeline point to given the packets on disk". Both the watcher (`detectNext`) and the direct
 * `/discipline-step4` skill derive from it, so they cannot diverge: whatever the watcher would
 * route to, the direct resolver reports the same origin, redirect, collision, or stop.
 *
 * `resolveStep4Origin` then layers content-coherence validation on top (execution packet
 * validated for EVERY mode, completion gate green for reentry, feedback branch declared for
 * feedback) and returns chosen | ambiguous | invalid for the skill/CLI.
 *
 * Honest limitation (Phase 1, no consumption model yet): "coherent" means structurally and
 * transitionally coherent, NOT "this is the live handoff". In the normal Step 5 -> 6 -> 7 flow
 * the earlier packets stay on disk, so reaching a hardening pass while a SLICE_COMPLETION_PACKET
 * lingers is a genuine collision. That is fail-loud but not automatic; the operator picks the
 * origin with `--mode`. Phase 2 (handoff consumption) will make it automatic. Callers must never
 * imply currency, and must not prescribe deleting packets as the routine remedy.
 */

export type Step4Mode = '4' | '4-reentry' | '4-feedback' | '4-hardening';

/**
 * The full routing decision derived from the packets on disk. Mirrors the watcher's historical
 * precedence exactly so `detectNext` and the direct resolver share one brain.
 */
export type RouteDecision =
  | { kind: 'step4'; mode: Step4Mode }
  | { kind: 'collision'; modes: Step4Mode[] }
  | { kind: 'redirect'; step: '2' | '5' | '6' | '7'; reason: string }
  | { kind: 'feedback-unclear' }
  | { kind: 'none' };

export interface Step4Resolution {
  status: 'chosen' | 'ambiguous' | 'invalid';
  /** Set when status is 'chosen'. */
  mode?: Step4Mode;
  /** Set when status is 'ambiguous': the reentry modes that collided. */
  candidates?: Step4Mode[];
  /** Set when status is 'invalid': why the resolved mode cannot proceed. */
  reason?: string;
  /** Always present: human-readable evidence for the decision. */
  evidence: string[];
}

function packetsDir(root: string): string {
  return path.join(root, '.discipline', 'packets');
}

function packetExists(root: string, name: string): boolean {
  return fs.existsSync(path.join(packetsDir(root), name));
}

function readPacket(root: string, name: string): string | null {
  const p = path.join(packetsDir(root), name);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Which branch the POST_DEPLOY_FEEDBACK_PACKET recommends. Returns:
 *   '4'       -> a Step 4 mini-fix / feedback loop
 *   '7'       -> Step 7 productization / hardening (NOT a Step 4 origin)
 *   'unclear' -> no clear recommendation; callers must stop, never default silently.
 */
export function feedbackRecommendedBranch(root: string): '4' | '7' | 'unclear' {
  const content = readPacket(root, 'POST_DEPLOY_FEEDBACK_PACKET.md');
  if (content === null) return 'unclear';

  const step4 = /recommended branch[\s\S]{0,120}(step 4|feedback loop|mini-fix|mini fix)/i.test(content);
  const step7 = /recommended branch[\s\S]{0,120}(step 7|productization|hardening)/i.test(content);

  if (step4 && !step7) return '4';
  if (step7 && !step4) return '7';
  return 'unclear';
}

/**
 * Single source of truth: derive the full routing decision from the packets on disk, mirroring
 * the watcher's historical precedence. Pure and deterministic (presence + feedback-branch text).
 * A collision among the three reentry modes wins first (the origin is genuinely ambiguous).
 */
export function routeFromPackets(root: string): RouteDecision {
  const reentry: Step4Mode[] = [];
  if (packetExists(root, 'PROD_HARDENING_PACKET.md')) reentry.push('4-hardening');
  if (packetExists(root, 'POST_DEPLOY_FEEDBACK_PACKET.md') && feedbackRecommendedBranch(root) === '4') {
    reentry.push('4-feedback');
  }
  if (packetExists(root, 'SLICE_COMPLETION_PACKET.md')) reentry.push('4-reentry');
  if (reentry.length >= 2) return { kind: 'collision', modes: reentry };

  if (packetExists(root, 'PROD_HARDENING_PACKET.md')) return { kind: 'step4', mode: '4-hardening' };

  if (packetExists(root, 'POST_DEPLOY_FEEDBACK_PACKET.md')) {
    const branch = feedbackRecommendedBranch(root);
    if (branch === '4') return { kind: 'step4', mode: '4-feedback' };
    if (branch === '7') {
      return {
        kind: 'redirect',
        step: '7',
        reason: 'the post-deploy feedback recommends Step 7 (productization), not a Step 4 mini-fix.',
      };
    }
    return { kind: 'feedback-unclear' };
  }

  if (packetExists(root, 'DEPLOY_READINESS_PACKET.md')) {
    return { kind: 'redirect', step: '6', reason: 'a DEPLOY_READINESS_PACKET points to Step 6 (deploy and verify).' };
  }
  if (packetExists(root, 'SLICE_COMPLETION_PACKET.md')) return { kind: 'step4', mode: '4-reentry' };
  if (packetExists(root, 'STEP_5_SLICE_PACKET.md')) {
    return { kind: 'redirect', step: '5', reason: 'a STEP_5_SLICE_PACKET is ready to implement in Step 5.' };
  }
  if (packetExists(root, 'STEP_4_EXECUTION_PACKET.md')) return { kind: 'step4', mode: '4' };
  if (packetExists(root, 'STEP_2_ARCHITECTURE_PACKET.md')) {
    return { kind: 'redirect', step: '2', reason: 'only a STEP_2_ARCHITECTURE_PACKET is present; validate the architecture in Step 2 first.' };
  }
  return { kind: 'none' };
}

/** Whether STEP_4_EXECUTION_PACKET carries STATUS: validated (body or frontmatter). */
function executionValidated(root: string): boolean {
  const content = readPacket(root, 'STEP_4_EXECUTION_PACKET.md');
  if (content === null) return false;
  return /^\s*(status:\s*validated|STATUS:\s*validated)\b/im.test(content);
}

/**
 * Content-coherence issues for a given Step 4 mode. An empty array means the mode is coherent to
 * proceed. `--mode` must not skip these, so the CLI/skill route through here. The validated
 * STEP_4_EXECUTION_PACKET is required for EVERY mode: Step 4 always expands against the validated
 * architecture, whatever the origin.
 */
function modeCoherenceIssues(root: string, mode: Step4Mode): string[] {
  const issues: string[] = [];

  if (!packetExists(root, 'STEP_4_EXECUTION_PACKET.md')) {
    issues.push('STEP_4_EXECUTION_PACKET is missing (run /discipline-step2 first).');
  } else if (!executionValidated(root)) {
    issues.push('STEP_4_EXECUTION_PACKET is not STATUS: validated (still a draft); validate it in Step 2.');
  }

  if (mode === '4-reentry') {
    if (!packetExists(root, 'SLICE_COMPLETION_PACKET.md')) {
      issues.push('SLICE_COMPLETION_PACKET is missing for a reentry.');
    } else {
      const gate = completionGateState(root);
      if (gate !== 'passed') issues.push(`the slice completion gate is "${gate}" (must be "passed" to reenter); close the gate in Step 5 first.`);
    }
  } else if (mode === '4-feedback') {
    if (!packetExists(root, 'POST_DEPLOY_FEEDBACK_PACKET.md')) {
      issues.push('POST_DEPLOY_FEEDBACK_PACKET is missing for a feedback pass.');
    } else {
      const branch = feedbackRecommendedBranch(root);
      if (branch === '7') issues.push('the feedback packet recommends Step 7, not Step 4; do not expand slices from it.');
      else if (branch === 'unclear') issues.push('the feedback packet does not declare a clear recommended branch (Step 4 vs Step 7); declare it and re-drop.');
    }
  } else if (mode === '4-hardening') {
    if (!packetExists(root, 'PROD_HARDENING_PACKET.md')) issues.push('PROD_HARDENING_PACKET is missing for a hardening pass.');
  }

  return issues;
}

const RESIDUAL_CAVEAT =
  'Coherence, not currency: without a consumption model this only proves structural coherence, ' +
  'not that this is the live handoff. Confirm it is the origin you intend before expanding.';

function chosenReason(mode: Step4Mode): string {
  switch (mode) {
    case '4': return 'A validated STEP_4_EXECUTION_PACKET is present with no active reentry handoff.';
    case '4-reentry': return 'A SLICE_COMPLETION_PACKET is present and its completion gate passed.';
    case '4-feedback': return 'A POST_DEPLOY_FEEDBACK_PACKET recommends a Step 4 mini-fix.';
    case '4-hardening': return 'A PROD_HARDENING_PACKET is present.';
  }
}

/**
 * Resolve the Step 4 origin for the direct skill / CLI.
 *
 * - `opts.mode` (explicit --mode) picks the branch but NEVER skips coherence validation.
 * - Without `opts.mode`, the shared route decides: a single coherent origin returns `chosen`; a
 *   reentry collision returns `ambiguous`; a redirect (the pipeline points to another step), an
 *   undeclared feedback branch, or an incoherent mode return `invalid`.
 */
export function resolveStep4Origin(root: string, opts: { mode?: Step4Mode } = {}): Step4Resolution {
  const requested = opts.mode;

  if (requested) {
    const issues = modeCoherenceIssues(root, requested);
    if (issues.length > 0) {
      return {
        status: 'invalid',
        mode: requested,
        reason: issues.join(' '),
        evidence: [`--mode ${requested} was requested but is not coherent:`, ...issues],
      };
    }
    return { status: 'chosen', mode: requested, evidence: [`--mode ${requested} (explicit) validated.`, RESIDUAL_CAVEAT] };
  }

  const route = routeFromPackets(root);
  switch (route.kind) {
    case 'collision':
      return {
        status: 'ambiguous',
        candidates: route.modes,
        evidence: [
          `Multiple reentry handoffs are present at once: ${route.modes.join(', ')}.`,
          'This is expected in Fase 1 (no consumption model yet): closing a slice and then reaching Step 6/7 leaves the earlier packets on disk.',
          'Choose the origin with --mode <4-reentry|4-feedback|4-hardening>. Fase 2 (handoff consumption) will resolve this automatically.',
        ],
      };
    case 'redirect':
      return {
        status: 'invalid',
        reason: `the pipeline points to Step ${route.step}, not Step 4: ${route.reason}`,
        evidence: [
          `Not a Step 4 origin. ${route.reason}`,
          `Run the Step ${route.step} skill, or pass --mode explicitly to force a Step 4 expansion.`,
        ],
      };
    case 'feedback-unclear':
      return {
        status: 'invalid',
        reason: 'the post-deploy feedback does not declare a clear recommended branch (Step 4 vs Step 7).',
        evidence: ['The POST_DEPLOY_FEEDBACK_PACKET is present but its recommended branch is undeclared; declare Step 4 or Step 7 and re-drop it.'],
      };
    case 'none':
      return {
        status: 'invalid',
        reason: 'no Step 4 origin detected (no STEP_4_EXECUTION_PACKET and no reentry handoff).',
        evidence: ['Nothing to expand from. Run /discipline-step2 to produce a validated STEP_4_EXECUTION_PACKET.'],
      };
    case 'step4': {
      const issues = modeCoherenceIssues(root, route.mode);
      if (issues.length > 0) {
        return {
          status: 'invalid',
          mode: route.mode,
          reason: issues.join(' '),
          evidence: [`Detected mode ${route.mode}, but it is not coherent:`, ...issues],
        };
      }
      return { status: 'chosen', mode: route.mode, evidence: [chosenReason(route.mode), RESIDUAL_CAVEAT] };
    }
  }
}
