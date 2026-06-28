import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.error('[FAIL] Missing env vars: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(url, anonKey)

console.log('--- Supabase Smoke Test ---')

const { data, error } = await supabase.auth.getSession()

if (error) {
  console.error('[FAIL] auth.getSession error:', error)
  process.exit(1)
}

console.log('[PASS] Supabase reachable. Session:', data?.session ? 'present' : 'none')
process.exit(0)
