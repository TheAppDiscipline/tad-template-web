/**
 * Gemini CLI adapter.
 *
 * Command: `gemini`. Args: `-o json`; the prompt is delivered on stdin (NOT via
 * a `-p <text>` argument). Default TAD role: cross-family validator (free tier).
 *
 * Read-only capability is LIMITED: gemini has no hard read-only flag in headless
 * mode. So the validator contract for gemini is enforced by instruction (the
 * review prompt asks for a read-only verdict only) and by the fact that
 * cross-validation is advisory anyway. It runs with cwd = repo but never blocks
 * and never commits. buildArgs is identical for both roles; the capability
 * limit is documented, not faked with a flag that does not exist.
 */

import type { AdapterResult, AdapterRole, BuildArgsOptions, ProviderAdapter } from './types.js';
import { detectParkedReason, firstErrorLine } from './types.js';

/** Fixed flags. Volatile: verify against the installed `gemini --help`. */
const JSON_ARGS = ['-o', 'json'];

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

export const geminiAdapter: ProviderAdapter = {
  name: 'gemini',
  family: 'google',
  cli: 'gemini',
  stdinPrompt: true,

  // gemini has no hard read-only flag in headless mode: both roles use the same
  // fixed args. The validator's read-only contract is by instruction (advisory).
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
      const stats = (doc.stats && typeof doc.stats === 'object' ? doc.stats : doc) as Record<string, unknown>;
      const resultText = pickString(doc, ['response', 'result', 'text', 'output']);
      const tokensIn = pickNumber(stats, ['input_tokens', 'prompt_tokens', 'promptTokenCount']);
      const tokensOut = pickNumber(stats, ['output_tokens', 'candidates_tokens', 'candidatesTokenCount']);
      const tokens = tokensIn === undefined && tokensOut === undefined ? undefined : { in: tokensIn, out: tokensOut };
      const costUsd = pickNumber(doc, ['total_cost_usd', 'cost_usd']);
      const isErrorDoc = !!doc.error || (typeof doc.type === 'string' && /error/i.test(doc.type));

      if (exitCode !== 0 || isErrorDoc) {
        return {
          status: 'failed',
          summary: resultText ? resultText.slice(0, 200) : `gemini exited ${exitCode}`,
          tokens,
          costUsd: costUsd ?? null,
          firstError: firstErrorLine(stdout, stderr) ?? (resultText ? resultText.slice(0, 200) : undefined),
        };
      }
      return {
        status: 'ok',
        summary: resultText ? resultText.slice(0, 200) : 'ok',
        tokens,
        costUsd: costUsd ?? null,
      };
    }

    if (exitCode === 0 && stdout.trim()) {
      return { status: 'ok', summary: stdout.trim().slice(0, 200), costUsd: null };
    }
    return {
      status: 'failed',
      summary: `gemini exited ${exitCode} without parseable JSON`,
      costUsd: null,
      firstError: firstErrorLine(stdout, stderr),
    };
  },
};
