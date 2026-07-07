/**
 * cursor-agent adapter (tier-3: least mature, documented, not first-class).
 *
 * Command: `cursor-agent`. Args: `-p --output-format json` (prompt on stdin).
 * There is no dedicated hard read-only flag documented for headless mode, so the
 * validator role reuses the same fixed args and relies on the advisory,
 * instruction-level read-only contract (same posture as gemini). All flags are
 * volatile: verify against the installed `cursor-agent --help`.
 *
 * Parse tolerance mirrors the other JSON adapters: read a single result object
 * when present, else fall back to plain text by exit code.
 */

import type { AdapterResult, AdapterRole, BuildArgsOptions, ProviderAdapter } from './types.js';
import { detectParkedReason, firstErrorLine } from './types.js';

/** Fixed flags. Volatile: verify against the installed `cursor-agent --help`. */
const JSON_ARGS = ['-p', '--output-format', 'json'];

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

function extractJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
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

export const cursorAdapter: ProviderAdapter = {
  name: 'cursor',
  family: 'cursor',
  cli: 'cursor-agent',
  stdinPrompt: true,

  buildArgs(_role: AdapterRole, _opts?: BuildArgsOptions): string[] {
    return [...JSON_ARGS];
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
      const resultText = pickString(doc, ['result', 'response', 'text', 'output']);
      const tokensIn = pickNumber(usage, ['input_tokens', 'prompt_tokens']);
      const tokensOut = pickNumber(usage, ['output_tokens', 'completion_tokens']);
      const tokens = tokensIn === undefined && tokensOut === undefined ? undefined : { in: tokensIn, out: tokensOut };
      const costUsd = pickNumber(doc, ['total_cost_usd', 'cost_usd']);
      const isErrorDoc = !!doc.error || doc.is_error === true || (typeof doc.type === 'string' && /error/i.test(doc.type));

      if (exitCode !== 0 || isErrorDoc) {
        return {
          status: 'failed',
          summary: resultText ? resultText.slice(0, 200) : `cursor-agent exited ${exitCode}`,
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

    if (exitCode === 0 && stdout.trim()) {
      return { status: 'ok', summary: stdout.trim().slice(0, 200), costUsd: null };
    }
    return {
      status: 'failed',
      summary: `cursor-agent exited ${exitCode} without parseable JSON`,
      costUsd: null,
      firstError: firstErrorLine(stdout, stderr),
    };
  },
};
