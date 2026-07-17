/**
 * check-db-types — opt-in drift check (7.3-B): Supabase DB schema vs committed TS types.
 *
 * READ-ONLY: never writes a file. Repair drift with `npm run db:types:generate`.
 *
 * Only active when BACKEND_PROVIDER=SUPABASE; otherwise skips (exit 0).
 *   - non-Supabase            -> [SKIP] exit 0 (always)
 *   - Supabase, no CLI/DB     -> normal: [WARN] exit 0 | strict (--strict): [FAIL] exit 1
 *   - committed types missing -> [FAIL] exit 1
 *   - generated != committed  -> [FAIL] exit 1 (drift)
 *   - generated == committed  -> [OK]   exit 0
 *
 * NOT part of `npm run gate` (base). Wired into `gate:strict` (strict mode).
 * Recommended for projects with BACKEND_PROVIDER=SUPABASE.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readProviderConfig } from './provider-config.js'

export const TYPES_REL = 'src/lib/backend/supabase/database.types.ts'

export function detectProvider(root) {
  return readProviderConfig(root).backendProvider
}

// Normalize line endings + trailing whitespace so a Windows CRLF checkout of the
// committed file does not look like drift against the LF output of `supabase gen`.
function norm(s) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}

/**
 * Pure decision. Returns { code, level, message }. level: skip|ok|warn|fail.
 */
export function decide({ provider, strict, cliAvailable, committedExists, committed, generated }) {
  if (provider !== 'SUPABASE') {
    return {
      code: 0,
      level: 'skip',
      message: `[SKIP] BACKEND_PROVIDER is not SUPABASE (got ${provider ?? 'unset'}); db types check not applicable.`,
    }
  }
  if (!cliAvailable) {
    const msg =
      'Supabase CLI / local DB not available. Install the Supabase CLI and run `supabase start`, then `npm run db:types:generate`.'
    return strict
      ? { code: 1, level: 'fail', message: `[FAIL] ${msg}` }
      : { code: 0, level: 'warn', message: `[WARN] ${msg} (skipped in normal mode; use --strict to enforce)` }
  }
  if (!committedExists) {
    return {
      code: 1,
      level: 'fail',
      message: `[FAIL] ${TYPES_REL} is missing but Supabase is active. Run \`npm run db:types:generate\` and commit it.`,
    }
  }
  if (norm(committed) !== norm(generated)) {
    return {
      code: 1,
      level: 'fail',
      message: `[FAIL] ${TYPES_REL} is out of date with the Supabase schema. Run \`npm run db:types:generate\` and commit the result.`,
    }
  }
  return { code: 0, level: 'ok', message: `[OK] ${TYPES_REL} matches the Supabase schema.` }
}

// FINDING-02: resolve a runnable Supabase CLI invocation prefix WITHOUT auto-downloading.
// Try a global/PATH install first (this also covers node_modules/.bin under `npm run`); fall
// back to `npx --no-install`, which finds a local devDep even when this script runs via
// `node tools/...` directly. Never plain `npx` (that would auto-download the CLI binary).
export function resolveSupabasePrefix() {
  for (const prefix of ['supabase', 'npx --no-install supabase']) {
    try {
      execSync(`${prefix} --version`, { stdio: 'ignore' })
      return prefix
    } catch {
      /* try the next resolution strategy */
    }
  }
  return null
}

function generateTypes(prefix) {
  // Read-only: returns the generated types as a string; does NOT write the file.
  return execSync(`${prefix} gen types typescript --local`, { encoding: 'utf8' })
}

function main() {
  const root = process.cwd()
  const strict = process.argv.includes('--strict')
  const provider = detectProvider(root)
  const committedPath = path.join(root, TYPES_REL)
  const committedExists = fs.existsSync(committedPath)

  let cliAvailable = false
  let generated = null
  if (provider === 'SUPABASE') {
    const prefix = resolveSupabasePrefix()
    cliAvailable = prefix !== null
    if (cliAvailable && committedExists) {
      try {
        generated = generateTypes(prefix)
      } catch {
        cliAvailable = false // CLI present but local DB unreachable -> treat as unavailable
      }
    }
  }

  const committed = committedExists ? fs.readFileSync(committedPath, 'utf8') : null
  const r = decide({ provider, strict, cliAvailable, committedExists, committed, generated })
  ;(r.level === 'fail' ? console.error : console.log)(`check-db-types: ${r.message}`)
  process.exit(r.code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
