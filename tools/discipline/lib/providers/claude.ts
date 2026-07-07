/**
 * Claude Code adapter.
 *
 * Command: `claude`. Builder: `-p --output-format json` (prompt on stdin).
 * Validator adds `--allowedTools Read Grep Glob` so the review is read-only by
 * construction. Resume of a prior session uses `--resume <session_id>` (the
 * run reconciler adds that flag itself for repair turns).
 *
 * Output: `--output-format json` prints a single JSON "result" document. We
 * tolerate the absence of any field: result text, session_id, total_cost_usd,
 * and usage may all be missing depending on auth mode / CLI version, so costUsd
 * is null unless explicitly reported.
 */

import type { AdapterResult, AdapterRole, BuildArgsOptions, ProviderAdapter } from './types.js';
import { detectParkedReason, firstErrorLine } from './types.js';

/** Fixed flags. Volatile: verify against the installed `claude --help`. */
const BUILDER_ARGS = ['-p', '--output-format', 'json'];
/** Read-only tool allowlist for validator role (advisory review, no writes). */
const VALIDATOR_EXTRA_ARGS = ['--allowedTools', 'Read', 'Grep', 'Glob'];

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Find the JSON result document in stdout (the last complete top-level object). */
function extractJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  // Fast path: whole stdout is one JSON object.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to line scan (some versions print a trailing newline or log line).
  }
  // Scan lines from the end for the last line that parses as an object.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // keep scanning
    }
  }
  return null;
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  family: 'anthropic',
  cli: 'claude',
  stdinPrompt: true,

  buildArgs(role: AdapterRole, _opts?: BuildArgsOptions): string[] {
    return role === 'validator' ? [...BUILDER_ARGS, ...VALIDATOR_EXTRA_ARGS] : [...BUILDER_ARGS];
  },

  parse(stdout: string, stderr: string, exitCode: number): AdapterResult {
    const combined = `${stdout}\n${stderr}`;
    const parked = detectParkedReason(combined, exitCode);
    if (parked) {
      return { status: 'parked', summary: `parked (${parked})`, costUsd: null, firstError: firstErrorLine(stdout, stderr) };
    }

    const doc = extractJsonObject(stdout);
    if (doc) {
      const usage = (doc.usage && typeof doc.usage === 'object' ? doc.usage : {}) as Record<string, unknown>;
      const costUsd = pickNumber(doc, ['total_cost_usd', 'cost_usd']);
      const resultText = pickString(doc, ['result', 'text', 'response']);
      const isErrorDoc = doc.is_error === true || pickString(doc, ['subtype']) === 'error' || (typeof doc.type === 'string' && /error/i.test(doc.type));
      const tokensIn = pickNumber(usage, ['input_tokens', 'prompt_tokens']);
      const tokensOut = pickNumber(usage, ['output_tokens', 'completion_tokens']);
      const tokens = tokensIn === undefined && tokensOut === undefined ? undefined : { in: tokensIn, out: tokensOut };

      if (exitCode !== 0 || isErrorDoc) {
        return {
          status: 'failed',
          summary: resultText ? resultText.slice(0, 200) : `claude exited ${exitCode}`,
          sessionId: pickString(doc, ['session_id', 'sessionId']),
          tokens,
          costUsd: costUsd ?? null,
          firstError: firstErrorLine(stdout, stderr) ?? (resultText ? resultText.slice(0, 200) : undefined),
        };
      }

      return {
        status: 'ok',
        summary: resultText ? resultText.slice(0, 200) : 'ok',
        sessionId: pickString(doc, ['session_id', 'sessionId']),
        tokens,
        costUsd: costUsd ?? null,
      };
    }

    // No parseable JSON. Exit 0 with output is a soft ok; nonzero is a failure.
    if (exitCode === 0 && stdout.trim()) {
      return { status: 'ok', summary: stdout.trim().slice(0, 200), costUsd: null };
    }
    return {
      status: 'failed',
      summary: `claude exited ${exitCode} without parseable JSON`,
      costUsd: null,
      firstError: firstErrorLine(stdout, stderr),
    };
  },
};
