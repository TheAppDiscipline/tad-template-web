/**
 * Adapter runner: spawn a provider CLI, feed the prompt over stdin, enforce a
 * timeout with a whole-process-TREE kill, and return the adapter's parsed
 * result plus timing.
 *
 * Windows rules honored here:
 *  - Real provider binaries use shell:true on win32, because they are often
 *    `.cmd` shims that fail to spawn without a shell (EINVAL).
 *  - Test overrides and the fake provider use direct spawn (shell:false), so
 *    ENOENT is observable and process-tree kills return promptly.
 *  - Real CLIs are preflighted against the OS (win32 `where.exe`, POSIX
 *    `command -v`) BEFORE spawning, because a missing `.cmd` shim under
 *    shell:true does not raise spawn ENOENT: cmd.exe exits 1 with a
 *    locale-dependent "is not recognized" message. Not found -> parked
 *    'cli-not-found' with no spawn. No locale-string parsing is relied on.
 *  - The prompt NEVER appears in argv: only fixed literal flags (from the
 *    adapter's buildArgs) go on the command line; the prompt is written to
 *    stdin, which is then ended.
 *  - Timeout kills the whole tree: on win32 `taskkill /pid <pid> /T /F`, else
 *    child.kill('SIGKILL'). A `.cmd` shim spawns a child node process; killing
 *    only the shim would leave the model running.
 *
 * Privacy: this module NEVER logs argv, env, or prompt contents. It returns a
 * normalized AdapterResult; callers decide what (redacted) fields to persist.
 *
 * `commandOverride` / `argsOverride` exist ONLY for tests (a fake CLI). The env
 * var DISCIPLINE_FAKE_PROVIDER_CMD is honored as a TEST-ONLY override so an
 * end-to-end run can be driven offline: its value is a single script path that
 * is run with the CURRENT Node executable (`process.execPath <that path>`), via
 * argv array spawn so spaces in either path are handled without shell quoting.
 * Neither override is used in production paths.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as process from 'node:process';
import type { AdapterResult, AdapterRole, ProviderAdapter } from './types.js';

export interface RunAdapterOptions {
  timeoutMs: number;
  cwd: string;
  /** TEST-ONLY: replace the spawned command (e.g. 'node'). */
  commandOverride?: string;
  /** TEST-ONLY: replace the argv (e.g. [fixturePath]). Bypasses buildArgs. */
  argsOverride?: string[];
  /** Extra fixed flags appended after buildArgs (e.g. resume flags). No user text. */
  extraArgs?: string[];
}

export interface RunAdapterOutcome extends AdapterResult {
  durationMs: number;
  exitCode: number;
  /** True when the run was killed for exceeding timeoutMs. */
  timedOut: boolean;
}

/** ~10MB cap per stream so a runaway CLI cannot exhaust memory. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Quote a single token for a shell command line when spawning with shell:true.
 * Real adapters emit only fixed literal flags (no spaces), so this is a no-op
 * for them; it matters for the test override / DISCIPLINE_FAKE_PROVIDER_CMD path
 * where a fixture path can contain spaces (this repo's path does). We pre-quote
 * ourselves rather than let spawn concatenate raw args (which would split a
 * space-containing path and also trips Node's DEP0190 warning).
 *
 * Exported for tests. Tokens with no shell-significant character pass through
 * unchanged so the visible command line stays clean.
 */
export function shellQuote(token: string): string {
  if (token === '') return process.platform === 'win32' ? '""' : "''";
  // Safe set: letters, digits, and a handful of harmless punctuation.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  if (process.platform === 'win32') {
    // cmd.exe: wrap in double quotes; escape embedded double quotes by doubling.
    return `"${token.replace(/"/g, '""')}"`;
  }
  // POSIX sh: single-quote, closing/reopening around any embedded single quote.
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Deterministically decide whether a CLI binary is resolvable on PATH, WITHOUT
 * spawning it and WITHOUT parsing any locale-dependent shell message.
 *
 * A missing REAL CLI under shell:true on Windows does NOT surface as spawn
 * ENOENT: cmd.exe exits 1 with a localized "is not recognized" string that is
 * English-only, so string parsing is not a reliable mechanism. Instead we ask
 * the OS directly:
 *   - win32:  `where.exe <cli>`  -> exit 0 iff found.
 *   - POSIX:  `command -v -- "$1"` run via `sh` with the cli passed as an argv
 *             positional (NOT interpolated into the script string).
 * The cli name is never spliced into a shell string, so there is no injection
 * surface. A tiny race (the CLI deleted between this check and the spawn) is
 * accepted; we do not add locale parsing to close it.
 *
 * Returns true when the binary is resolvable, false when it is not.
 */
export function isCliOnPath(cli: string): boolean {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('where.exe', [cli], { stdio: 'ignore', shell: false });
      return r.status === 0;
    }
    const r = spawnSync('sh', ['-c', 'command -v -- "$1"', 'sh', cli], {
      stdio: 'ignore',
      shell: false,
    });
    return r.status === 0;
  } catch {
    // If the resolver itself cannot be spawned, do not block: treat as present
    // and let the real spawn surface whatever it surfaces.
    return true;
  }
}

/** Kill the whole process tree for `pid`. win32: taskkill /T /F; else SIGKILL. */
export function treeKill(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  } catch {
    // best-effort: never throw from a kill
  }
}

/**
 * Resolve the command + args to spawn. Precedence:
 *   1. explicit commandOverride/argsOverride (tests),
 *   2. DISCIPLINE_FAKE_PROVIDER_CMD env (TEST-ONLY end-to-end override),
 *   3. the adapter's real cli + buildArgs(role) [+ extraArgs].
 * The prompt is never part of this; it always goes to stdin.
 */
function resolveSpawn(
  adapter: ProviderAdapter,
  role: AdapterRole,
  opts: RunAdapterOptions,
): { command: string; args: string[]; useShell: boolean; isReal: boolean } {
  if (opts.commandOverride) {
    return { command: opts.commandOverride, args: opts.argsOverride ?? [], useShell: false, isReal: false };
  }
  const fakeScript = process.env.DISCIPLINE_FAKE_PROVIDER_CMD;
  if (fakeScript && fakeScript.trim()) {
    // TEST-ONLY override for offline end-to-end runs: the value is a single
    // script path, run with the current Node executable. argv-array spawn keeps
    // paths with spaces intact. The prompt still goes via stdin.
    return { command: process.execPath, args: [fakeScript.trim()], useShell: false, isReal: false };
  }
  const args = [...adapter.buildArgs(role, { cwd: opts.cwd }), ...(opts.extraArgs ?? [])];
  return { command: adapter.cli, args, useShell: process.platform === 'win32', isReal: true };
}

/**
 * Spawn the adapter, deliver `promptText` on stdin, enforce the timeout, and
 * return the parsed outcome. Resolves (never rejects) for spawn/timeout errors:
 * a spawn ENOENT is surfaced through the adapter's parse (detected as parked
 * 'cli-not-found'), and a timeout is returned as a failed outcome.
 */
export function runAdapter(
  adapter: ProviderAdapter,
  role: AdapterRole,
  promptText: string,
  opts: RunAdapterOptions,
): Promise<RunAdapterOutcome> {
  const { command, args, useShell, isReal } = resolveSpawn(adapter, role, opts);
  const started = Date.now();

  // Deterministic binary preflight for the REAL adapter path only. A missing
  // real CLI under shell:true does not raise spawn ENOENT on Windows (cmd.exe
  // exits 1 with a locale-dependent message), so we resolve the binary against
  // the OS (where.exe / command -v) BEFORE spawning. Not found -> parked
  // 'cli-not-found' immediately, without spawning. This is the guarantee; the
  // adapter's ENOENT/locale-string handling is only secondary evidence.
  // Test/override paths (isReal === false) keep their existing ENOENT->parked
  // behavior and are not preflighted.
  if (isReal && !isCliOnPath(command)) {
    return Promise.resolve({
      status: 'parked',
      summary: `parked (cli-not-found)`,
      costUsd: null,
      firstError: `cli-not-found: ${command}`,
      durationMs: Date.now() - started,
      exitCode: 1,
      timedOut: false,
    });
  }

  return new Promise<RunAdapterOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let spawnErrorText = '';

    // Real provider CLIs on Windows are usually `.cmd` shims, so they still go
    // through shell:true there. Test overrides and fake providers use direct
    // spawn so ENOENT is delivered as an error and kill semantics are prompt.
    const child = useShell
      ? spawn([command, ...args].map(shellQuote).join(' '), {
          cwd: opts.cwd,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd: opts.cwd,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child.pid);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone, or unsupported signal on this platform
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(1);
    }, Math.max(1, opts.timeoutMs));

    function finish(exitCode: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;

      if (timedOut) {
        // A timeout is a failure regardless of what the CLI managed to print.
        resolve({
          status: 'failed',
          summary: `timed out after ${opts.timeoutMs} ms (process tree killed)`,
          costUsd: null,
          firstError: `timeout after ${opts.timeoutMs} ms`,
          durationMs,
          exitCode,
          timedOut: true,
        });
        return;
      }

      const effectiveStderr = spawnErrorText ? `${stderr}\n${spawnErrorText}` : stderr;
      const parsed = adapter.parse(stdout, effectiveStderr, exitCode);
      resolve({ ...parsed, durationMs, exitCode, timedOut: false });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdout += chunk.toString('utf-8');
      else if (!timedOut) {
        timedOut = false;
        treeKill(child.pid); // runaway output: kill the tree, keep what we have
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderr += chunk.toString('utf-8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failed (e.g. ENOENT: CLI not installed). Surface the code text so
      // the adapter's parse can classify it as parked 'cli-not-found'.
      spawnErrorText = `${err.code ?? ''} ${err.message ?? ''}`.trim();
      finish(typeof child.exitCode === 'number' ? child.exitCode : 1);
    });

    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 1);
    });

    // Deliver the prompt on stdin, then end it. Guard against EPIPE if the child
    // exited early (e.g. CLI missing): swallow the write error, close() handles it.
    try {
      child.stdin?.on('error', () => {
        /* EPIPE / broken pipe when child already exited: ignore */
      });
      child.stdin?.write(promptText, 'utf-8');
      child.stdin?.end();
    } catch {
      // If we cannot write stdin at all, the close/error handler still resolves.
    }
  });
}
