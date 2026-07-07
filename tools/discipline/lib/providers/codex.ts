/**
 * Codex CLI adapter.
 *
 * Command: `codex`. Builder: `exec --json -` (JSONL events on stdout; the `-`
 * argument tells codex to read the prompt from stdin). Validator adds
 * `--sandbox read-only`. Resume of a prior session is `exec resume <id>` in
 * newer builds (documented as volatile below; the reconciler uses the resume
 * constant it imports from here).
 *
 * Parsing is intentionally tolerant: codex emits one JSON object per line
 * (events). We scan the lines for a final/result-ish event and for usage/cost
 * if present, and fall back to plain-text handling when nothing parses.
 *
 * Windows note: codex has no OS sandbox on win32 (tier-2, WSL2 is the upgrade).
 * That is an environment fact doctor already reports; parse() adds a tier note.
 */

import type { AdapterResult, AdapterRole, BuildArgsOptions, ProviderAdapter } from './types.js';
import { detectParkedReason, firstErrorLine } from './types.js';

/**
 * Fixed flags for codex. (volatile: verify against the installed
 * `codex --help`; tested range recorded in PROVIDER_MATRIX.) The prompt is
 * delivered on stdin via the trailing `-` convention, never as an argument.
 */
export const CODEX_BUILDER_ARGS = ['exec', '--json', '-'];
/** Read-only sandbox for validator role. (volatile: verify against codex --help.) */
export const CODEX_VALIDATOR_EXTRA_ARGS = ['--sandbox', 'read-only'];
/** Resume flags for a prior session id. (volatile: `codex exec resume <id>`.) */
export const CODEX_RESUME_ARGS = ['exec', 'resume'];

interface CodexScan {
  sessionId?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  lastText?: string;
  sawError: boolean;
}

/** Scan JSONL event lines tolerantly for the fields we care about. */
function scanJsonl(stdout: string): CodexScan {
  const scan: CodexScan = { sawError: false };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Session id under a few possible keys.
    for (const k of ['session_id', 'sessionId', 'thread_id', 'conversation_id']) {
      const v = ev[k];
      if (typeof v === 'string' && v.trim()) scan.sessionId = v;
    }
    // Cost / usage may live at the top level or under a usage/nested object.
    const nested = (ev.usage && typeof ev.usage === 'object' ? ev.usage : ev) as Record<string, unknown>;
    for (const k of ['total_cost_usd', 'cost_usd', 'costUsd']) {
      const v = ev[k] ?? nested[k];
      if (typeof v === 'number' && Number.isFinite(v)) scan.costUsd = v;
    }
    for (const k of ['input_tokens', 'prompt_tokens']) {
      const v = nested[k];
      if (typeof v === 'number' && Number.isFinite(v)) scan.tokensIn = v;
    }
    for (const k of ['output_tokens', 'completion_tokens']) {
      const v = nested[k];
      if (typeof v === 'number' && Number.isFinite(v)) scan.tokensOut = v;
    }
    // Text of the latest assistant/message/result event.
    for (const k of ['text', 'message', 'content', 'result', 'delta']) {
      const v = ev[k];
      if (typeof v === 'string' && v.trim()) scan.lastText = v;
    }
    // Error-ish event.
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (/error|failed/i.test(type) || ev.is_error === true || ev.error) scan.sawError = true;
  }
  return scan;
}

export const codexAdapter: ProviderAdapter = {
  name: 'codex',
  family: 'openai',
  cli: 'codex',
  stdinPrompt: true,

  buildArgs(role: AdapterRole, _opts?: BuildArgsOptions): string[] {
    // For validator we still need `exec --json -`, with the sandbox flag added.
    return role === 'validator'
      ? [...CODEX_BUILDER_ARGS.slice(0, 2), ...CODEX_VALIDATOR_EXTRA_ARGS, CODEX_BUILDER_ARGS[2]]
      : [...CODEX_BUILDER_ARGS];
  },

  parse(stdout: string, stderr: string, exitCode: number): AdapterResult {
    const combined = `${stdout}\n${stderr}`;
    const parked = detectParkedReason(combined, exitCode);
    if (parked) {
      return { status: 'parked', summary: `parked (${parked})`, costUsd: null, firstError: firstErrorLine(stdout, stderr) };
    }

    const scan = scanJsonl(stdout);
    const tokens = scan.tokensIn === undefined && scan.tokensOut === undefined ? undefined : { in: scan.tokensIn, out: scan.tokensOut };
    const tierNote = process.platform === 'win32' ? ' [tier-2: no OS sandbox on win32]' : '';

    if (exitCode !== 0 || scan.sawError) {
      return {
        status: 'failed',
        summary: `${scan.lastText ? scan.lastText.slice(0, 180) : `codex exited ${exitCode}`}${tierNote}`,
        sessionId: scan.sessionId,
        tokens,
        costUsd: scan.costUsd ?? null,
        firstError: firstErrorLine(stdout, stderr) ?? scan.lastText,
      };
    }

    // Success. Even if no JSONL parsed, exit 0 with output is a soft ok.
    if (scan.lastText || stdout.trim()) {
      return {
        status: 'ok',
        summary: `${(scan.lastText ?? stdout.trim()).slice(0, 180)}${tierNote}`,
        sessionId: scan.sessionId,
        tokens,
        costUsd: scan.costUsd ?? null,
      };
    }
    return { status: 'ok', summary: `ok${tierNote}`, sessionId: scan.sessionId, tokens, costUsd: scan.costUsd ?? null };
  },
};
