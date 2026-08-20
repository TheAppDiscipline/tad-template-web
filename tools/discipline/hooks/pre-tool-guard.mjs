#!/usr/bin/env node
/**
 * PreToolUse policy guard (Claude Code hook).
 *
 * Turns the "never auto-approve" list from the security doctrine (01a §7) into a
 * mechanism instead of prose: some tool calls are DENIED outright, some are
 * forced to ASK (the human is prompted even in accept-edits / auto-approve
 * mode), and everything else is ALLOWED silently.
 *
 * Doctrine, in one line: policy is a mechanism, not a suggestion. A green gate is
 * not authorization, and the §7 operations (`.env*`, new deps, migrations, RLS,
 * CI/CD, force push, `rm -rf`, `git config`, `git reset --hard`, curl|sh) are
 * never auto-approved.
 *
 * Protocol (Claude Code PreToolUse):
 *   - stdin: the hook JSON payload { tool_name, tool_input, ... }.
 *   - stdout: JSON with hookSpecificOutput.permissionDecision = allow|ask|deny
 *     plus permissionDecisionReason. Omitting the block (exit 0, no stdout) lets
 *     the normal permission flow proceed, which is our ALLOW.
 *
 * Failure policy (documented, deliberate): this guard fails CLOSED to ASK when
 * the payload is malformed or rule evaluation throws. A broken or spoofed hook
 * payload must never become a silent authorization channel.
 *
 * Heuristic limits (intentional, see decide()): command matching is a simple
 * regex over the Bash command string, not a shell parser. It can therefore
 * over-match a dangerous pattern that appears inside a quoted string (e.g.
 * `grep "rm -rf"`). That is the safe direction: a false ASK is acceptable, a
 * false DENY is not, so we bias the few ambiguous cases toward ASK, never
 * toward a silent allow. Word-boundary anchors keep the patterns tight.
 *
 * Pure decision is exported (decide) so tests never need stdin.
 */

// --- Path helpers -----------------------------------------------------------

import * as path from 'node:path';

/** Normalize a path-ish string to forward slashes, lowercased, for matching. */
function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').toLowerCase();
}

/** True when any path segment is exactly `.env` or starts with `.env.`. */
function targetsDotEnv(p) {
  const segments = normPath(p).split('/');
  return segments.some((seg) => seg === '.env' || seg.startsWith('.env.'));
}

/**
 * Collect the candidate file path(s) an Edit/Write/Read tool would touch.
 * Claude Code passes `file_path`; be tolerant of `path`/`notebook_path` too.
 */
function editPaths(toolInput) {
  const out = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = toolInput?.[key];
    if (typeof v === 'string' && v.length) out.push(v);
  }
  return out;
}

/** True when a mutation target resolves outside the project working directory. */
function escapesWorkingTree(p, cwd) {
  const candidate = String(p ?? '');
  if (!candidate) return false;
  if (!cwd) return normPath(candidate).split('/').includes('..');
  const root = path.resolve(String(cwd));
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

// --- ASK rules for Edit/Write file targets ----------------------------------

/**
 * Path globs (as tested predicates) that must force a human prompt when written
 * or edited: migrations, CI workflows, deploy config, dependency manifest, and
 * backend security rules. Reading these is fine; only mutation asks.
 */
function editTargetAsksReason(p) {
  const n = normPath(p);
  if (/(^|\/)supabase\/migrations\//.test(n)) return 'edits a database migration (supabase/migrations/**)';
  if (/(^|\/)\.github\/workflows\//.test(n)) return 'edits a CI/CD workflow (.github/workflows/**)';
  if (/(^|\/)vercel\.json$/.test(n)) return 'edits deploy config (vercel.json)';
  if (/(^|\/)package\.json$/.test(n)) return 'edits package.json (possible dependency change)';
  if (/(^|\/)firestore\.rules$/.test(n) || /(^|\/)storage\.rules$/.test(n) || /\.rules$/.test(n)) {
    return 'edits backend security rules (*.rules)';
  }
  return null;
}

// --- Bash command classification --------------------------------------------

/**
 * Classify a Bash command string. Returns { decision, reason } where decision is
 * 'deny' | 'ask' | 'allow'. DENY wins over ASK. See heuristic-limits note above.
 */
function classifyBash(command) {
  const cmd = String(command ?? '');

  // DENY: destructive / policy-violating operations. Reasons name the doctrine.
  // rm -rf and its Windows cousin rd /s (recursive force delete).
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\b/i.test(cmd) || /\brm\s+-[rf]{1,2}\b.*\*/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: recursive force delete (rm -rf) is never auto-approved.' };
  }
  if (/\b(rd|rmdir)\s+\/s\b/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: recursive delete (rd /s) is never auto-approved.' };
  }
  // git push --force / -f (to any remote).
  if (/\bgit\s+push\b/i.test(cmd) && /(--force(-with-lease)?|\s-f\b)/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: force-push rewrites remote history and is never auto-approved.' };
  }
  // git reset --hard (destroys working tree / history).
  if (/\bgit\s+reset\b/i.test(cmd) && /--hard\b/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: git reset --hard discards work and is never auto-approved.' };
  }
  // git config (any mutation of git configuration).
  if (/\bgit\s+config\b/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: git config mutations are never auto-approved.' };
  }
  // curl|wget piped into a shell (remote code execution).
  if (/\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|pwsh|powershell)\b/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: piping a download into a shell (curl|sh) is never auto-approved.' };
  }

  // DENY: command-line reads of secret files or wholesale environment dumps.
  if (/(^|[\s"'=\/\\])\.env(?:\.[\w.-]+)?(?:$|[\s"'|;&])/i.test(cmd)
    || /\b(printenv|env)\b(?:\s|$)/i.test(cmd)
    || /\b(get-childitem|gci|dir)\s+(?:-path\s+)?env:/i.test(cmd)) {
    return { decision: 'deny', reason: 'blocked by doctrine: secret files and environment-value dumps must not be read or exposed automatically.' };
  }

  // ASK: dependencies and lifecycle-capable package execution. Even lockfile-only
  // installs can change reviewed bytes; npx/dlx can download and execute code.
  if (/\bnpm\s+(install|i|add|ci|exec)\b/i.test(cmd)
    || /\bnpx\b/i.test(cmd)
    || /\b(yarn|pnpm|bun)\s+(install|add|i|ci|dlx|exec|x)\b/i.test(cmd)) {
    return { decision: 'ask', reason: 'installs or executes package supply-chain code: dependency operations require explicit human approval.' };
  }

  // ASK: every local or external publication boundary is independent of a green
  // gate or checkpoint.
  if (/\bgit\s+(commit|tag)\b/i.test(cmd)
    || (/\bgit\s+push\b/i.test(cmd) && !/(--force(-with-lease)?|\s-f\b)/i.test(cmd))
    || /\b(npm|pnpm|yarn)\s+publish\b/i.test(cmd)
    || /\bgh\s+release\s+(create|upload)\b/i.test(cmd)
    || /\b(vercel|netlify|firebase|fly|railway)\s+(deploy|up)\b/i.test(cmd)
    || /\bwrangler\s+(deploy|publish|pages\s+deploy)\b/i.test(cmd)
    || /\beas\s+(build|submit|update)\b/i.test(cmd)
    || /\bsupabase\s+(db\s+push|functions\s+deploy)\b/i.test(cmd)
    || /\b(docker\s+push|twine\s+upload)\b/i.test(cmd)) {
    return { decision: 'ask', reason: 'crosses a commit, tag, push, deploy, upload, or publication boundary that requires explicit human approval.' };
  }

  if (/\bdiscipline(?::lease|\s+lease)\b[\s\S]*--force\b/i.test(cmd)) {
    return { decision: 'ask', reason: 'force-overrides a slice lease; confirm ownership and recovery before proceeding.' };
  }

  return { decision: 'allow', reason: '' };
}

// --- Pure decision ----------------------------------------------------------

/**
 * Decide from a parsed hook payload. Pure and import-able (no stdin, no I/O).
 * Returns { decision: 'allow'|'ask'|'deny', reason: string }.
 */
export function decide(payload) {
  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input ?? {};

  if (typeof toolName !== 'string' || !toolName) {
    return { decision: 'ask', reason: 'malformed hook payload: missing tool_name; asking to fail closed.' };
  }

  // Bash: classify the command string.
  if (toolName === 'Bash') {
    return classifyBash(toolInput.command);
  }

  // Read/Edit/Write/NotebookEdit targeting .env or .env.* -> DENY.
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
    const paths = editPaths(toolInput);
    if (paths.some(targetsDotEnv)) {
      return { decision: 'deny', reason: 'blocked by doctrine: .env / .env.* files are secrets and are never read or written automatically.' };
    }
  }

  // Edit/Write to sensitive project files -> ASK (never silently auto-approve).
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
    for (const p of editPaths(toolInput)) {
      if (escapesWorkingTree(p, payload?.cwd)) {
        return { decision: 'ask', reason: 'mutation resolves outside the current project; scope expansion requires explicit human approval.' };
      }
      const reason = editTargetAsksReason(p);
      if (reason) return { decision: 'ask', reason: `never auto-approved: ${reason}.` };
    }
  }

  // Everything else: allow silently.
  return { decision: 'allow', reason: '' };
}

// --- Hook I/O ---------------------------------------------------------------

/** Build the Claude Code PreToolUse response object for a decision. */
function toHookOutput(result) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    },
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify(toHookOutput({
      decision: 'ask',
      reason: 'discipline pre-tool-guard could not parse the hook payload; asking to fail closed.',
    })));
    process.exit(0);
    return;
  }

  let result;
  try {
    result = decide(payload);
  } catch (err) {
    // Parse succeeded but our rules threw: fail CLOSED to ASK (prompt the human).
    const detail = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify(toHookOutput({
      decision: 'ask',
      reason: `discipline pre-tool-guard errored (${detail}); asking to be safe.`,
    })));
    process.exit(0);
    return;
  }

  // ALLOW is expressed by emitting nothing and exiting 0 (normal permission flow).
  if (result.decision === 'allow') {
    process.exit(0);
    return;
  }
  process.stdout.write(JSON.stringify(toHookOutput(result)));
  process.exit(0);
}

// Only run the I/O path when invoked as a script, not when imported by tests.
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
