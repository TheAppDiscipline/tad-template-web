/**
 * db:types:generate — repair action for check-db-types (7.3-B).
 *
 * Generates `src/lib/backend/supabase/database.types.ts` from the local Supabase
 * schema. This is the ONLY script that writes the types file; `check-db-types`
 * never mutates it.
 *
 * Requires BACKEND_PROVIDER=SUPABASE, the Supabase CLI, and a running local DB
 * (`supabase start`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { detectProvider, TYPES_REL, resolveSupabasePrefix } from './check_db_types.js'

const root = process.cwd()

const provider = detectProvider(root)
if (provider !== 'SUPABASE') {
  console.error(
    `db:types:generate: BACKEND_PROVIDER is not SUPABASE (got ${provider ?? 'unset'}). Nothing to generate.`,
  )
  process.exit(1)
}

// FINDING-02: resolve the Supabase CLI without auto-downloading (global/PATH first, then a
// local devDep via `npx --no-install`). See resolveSupabasePrefix in check_db_types.js.
const prefix = resolveSupabasePrefix()
if (!prefix) {
  console.error('db:types:generate: Supabase CLI not found. Install it globally or as a devDep (`npm i -D supabase`), then run `supabase start` first.')
  process.exit(1)
}

let out
try {
  out = execSync(`${prefix} gen types typescript --local`, { encoding: 'utf8' })
} catch {
  console.error(
    'db:types:generate: `supabase gen types typescript --local` failed. Is the local DB running (`supabase start`)?',
  )
  process.exit(1)
}

const dest = path.join(root, TYPES_REL)
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, out, 'utf8')
console.log(`db:types:generate: wrote ${TYPES_REL}. Review and commit it.`)
