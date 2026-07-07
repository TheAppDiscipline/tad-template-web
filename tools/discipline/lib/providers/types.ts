/**
 * Provider adapter contract for headless agent CLIs.
 *
 * The interop mechanism between agent families (Claude Code, Codex, Gemini,
 * cursor-agent) is not a network protocol: it is "non-interactive CLI + files +
 * exit codes". Each adapter knows one CLI's fixed flags and how to parse its
 * output; the runner (runner.ts) spawns it, feeds the prompt over stdin, and
 * enforces a timeout. Files stay the source of truth; adapters never mutate
 * state, they only run a model and report a normalized result.
 *
 * Hard rules baked into this shape:
 *  - The prompt ALWAYS travels via stdin (stdinPrompt is a constant `true`),
 *    never as a CLI argument: cmd.exe caps a command line at 8191 chars and the
 *    provider binaries are `.cmd` shims on Windows whose quoting mangles args.
 *  - buildArgs returns ONLY fixed literal flags (no user text), so nothing
 *    user-controlled reaches argv.
 *  - parse is pure: given (stdout, stderr, exitCode) it returns an AdapterResult
 *    and must tolerate missing fields (mark costUsd null when absent).
 */

export type ProviderFamily = 'anthropic' | 'openai' | 'google' | 'cursor';

export type AdapterRole = 'builder' | 'validator';

/** Retry-later ('parked') detected conservatively; never consumes repair budget. */
export type AdapterStatus = 'ok' | 'failed' | 'parked';

export interface AdapterResult {
  status: AdapterStatus;
  /** Short human summary (never the full prompt or raw secrets). */
  summary: string;
  /** Provider session id when the CLI reports one (enables --resume). */
  sessionId?: string;
  tokens?: { in?: number; out?: number };
  /** Cost in USD when the CLI reports it; null when it does not. */
  costUsd?: number | null;
  /** First error-looking line, when the run failed or parked. */
  firstError?: string;
}

/** Options passed to buildArgs; kept minimal and free of user text. */
export interface BuildArgsOptions {
  /** Repository root; some CLIs accept a working dir, but we spawn with cwd instead. */
  cwd?: string;
}

export interface ProviderAdapter {
  /** Stable adapter name (matches PROVIDER_MATRIX keys). */
  name: string;
  family: ProviderFamily;
  /** Binary/command name (a `.cmd` shim on Windows; spawn with shell:true). */
  cli: string;
  /**
   * Fixed literal flags for the given role. MUST NOT embed any user text.
   * Validator role adds read-only restrictions where the CLI supports them.
   */
  buildArgs(role: AdapterRole, opts?: BuildArgsOptions): string[];
  /** Always true: the prompt is delivered on stdin, never in argv. */
  stdinPrompt: true;
  /** Pure parse of the CLI's output into a normalized result. */
  parse(stdout: string, stderr: string, exitCode: number): AdapterResult;
}

/**
 * Conservative 'parked' detection shared by every adapter. Parked = retry-later:
 * rate limit / quota / overload, auth or login required, or the CLI is missing
 * (spawn ENOENT surfaces as a not-found line). Parked must NEVER be treated as a
 * repair-budget failure, so keep this deliberately narrow: only unambiguous
 * retry-later or setup conditions match.
 *
 * Returns the matched reason (a short label) or null when nothing matches.
 */
export function detectParkedReason(combinedOutput: string, _exitCode: number): string | null {
  const text = (combinedOutput || '').toLowerCase();

  // Rate limit / quota / overload (HTTP 429 or the usual phrasings).
  if (
    /\b429\b/.test(text) ||
    /rate[\s_-]?limit/.test(text) ||
    /\bquota\b/.test(text) ||
    /overloaded/.test(text) ||
    /too many requests/.test(text) ||
    /temporarily unavailable/.test(text) ||
    /\b503\b/.test(text)
  ) {
    return 'rate-limit';
  }

  // Auth / login required.
  if (
    /not logged in/.test(text) ||
    /please (log ?in|login|authenticate)/.test(text) ||
    /login required/.test(text) ||
    /authentication (required|failed)/.test(text) ||
    /unauthorized/.test(text) ||
    /\b401\b/.test(text) ||
    /run `?(claude|codex|gemini|cursor-agent) login`?/.test(text) ||
    /no api key|missing api key|api key not/.test(text)
  ) {
    return 'auth-required';
  }

  // CLI not found (spawn ENOENT / shell "command not found").
  if (
    /\benoent\b/.test(text) ||
    /command not found/.test(text) ||
    /is not recognized as (an )?internal or external command/.test(text) ||
    /no such file or directory/.test(text) ||
    /executable file not found/.test(text)
  ) {
    return 'cli-not-found';
  }

  return null;
}

/**
 * Best-effort first error line for failed runs. Mirrors the gate-report idiom so
 * error signatures stay comparable across the pipeline.
 */
export function firstErrorLine(stdout: string, stderr: string): string | undefined {
  const haystack = `${stderr}\n${stdout}`;
  const errorish = /error|fail(ed|ure)?|not found|cannot|exception|refused|denied/i;
  for (const raw of haystack.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && errorish.test(line)) return line;
  }
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return undefined;
}

/**
 * Provider capability/version matrix. `testedRange` is FREE TEXT and VOLATILE:
 * it records the CLI version range these adapters were written against, to be
 * verified against the installed CLI (`doctor --providers` prints it) and kept
 * current in the separately-sold vault's Live Registry. Do not hardcode model
 * ids or prices here.
 */
export interface ProviderMatrixEntry {
  family: ProviderFamily;
  cli: string;
  /** Volatile free-text version range the flags were tested against. */
  testedRange: string;
  notes: string;
}

export const PROVIDER_MATRIX: Record<string, ProviderMatrixEntry> = {
  claude: {
    family: 'anthropic',
    cli: 'claude',
    testedRange: 'Claude Code CLI >= 1.0 (verify: claude --version)',
    notes: 'Builder + policy. -p --output-format json; validator adds --allowedTools Read Grep Glob (read-only).',
  },
  codex: {
    family: 'openai',
    cli: 'codex',
    testedRange: 'Codex CLI >= 0.2 (volatile: verify against codex --help)',
    notes: 'Builder alt (tier-2 on Windows: no OS sandbox). exec --json -; validator adds --sandbox read-only.',
  },
  gemini: {
    family: 'google',
    cli: 'gemini',
    testedRange: 'Gemini CLI >= 0.1 (volatile: verify against gemini --help)',
    notes: 'Default validator (free tier). -o json via stdin. No hard read-only flag in headless mode; validator is advisory + read-only by instruction.',
  },
  cursor: {
    family: 'cursor',
    cli: 'cursor-agent',
    testedRange: 'cursor-agent (tier-3, volatile: least mature; verify against cursor-agent --help)',
    notes: 'Documented, not first-class. -p --output-format json.',
  },
};

/** Provider name -> family, for the "validator family must differ from builder" rule. */
export function familyOf(providerName: string): ProviderFamily | null {
  return PROVIDER_MATRIX[providerName]?.family ?? null;
}
