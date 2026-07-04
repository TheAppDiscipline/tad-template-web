/**
 * tests/rls/cross-space.mjs — RLS cross-user isolation test (SOP RLS §10).
 *
 * Proves RLS is *working*, not just *enabled*: user B must NOT read or write user
 * A's rows. Runs against a REAL Supabase project (local `supabase start` or a cloud
 * test project) using the seed `notifications` table. The service-role key is used
 * ONLY here, in the test setup — never in client code.
 *
 * Implements the canonical `cross-space.spec.ts` pattern from the RLS SOP §10.
 * Plain Node ESM (no test framework / no extra deps) so it stays out of the gate's
 * lint/type-check; wired to `npm run test:rls` and chained into `gate:launch`.
 *
 * Required env (skips cleanly if absent, so the launch gate stays runnable without
 * a project; CI / pre-launch sets them):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run live:
 *   supabase start && supabase db reset   # applies supabase/migrations_templates
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:rls
 *
 * Exit 0 = pass or skip, Exit 1 = isolation broken (a real cross-user leak).
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

function skip(reason) {
  console.log(`\x1b[33m[SKIP]\x1b[0m test:rls — ${reason}`)
  process.exit(0)
}

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) {
  skip('set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY to run the cross-user isolation test (service role used only here).')
}

let createClient
try {
  ;({ createClient } = await import('@supabase/supabase-js'))
} catch {
  skip('@supabase/supabase-js not installed. Run `npm i @supabase/supabase-js` to enable test:rls.')
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

const failures = []
const stamp = Date.now()
const pwd = `Test-${stamp}-only`
let spaceId
let userAId
let userBId

function authedClient(accessToken) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

async function makeUser(tag) {
  const email = `rls-${tag}-${stamp}@test.local`
  const created = await admin.auth.admin.createUser({ email, password: pwd, email_confirm: true })
  if (created.error || !created.data.user) throw new Error(`createUser(${tag}) failed: ${created.error && created.error.message}`)
  // Sign in on a THROWAWAY client. signInWithPassword would otherwise replace the
  // admin client's in-memory session with this user's, so the later admin seed
  // writes would run as that user (RLS-restricted) instead of service_role.
  const signInClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  const signedIn = await signInClient.auth.signInWithPassword({ email, password: pwd })
  if (signedIn.error || !signedIn.data.session) throw new Error(`signIn(${tag}) failed: ${signedIn.error && signedIn.error.message}`)
  return { id: created.data.user.id, token: signedIn.data.session.access_token }
}

console.log('--- Security Gate: RLS cross-user isolation (notifications) ---')

try {
  const userA = await makeUser('a')
  const userB = await makeUser('b')
  userAId = userA.id
  userBId = userB.id

  // Service role bypasses RLS: seed a space owned by A, A's membership, and a notification for A.
  const sp = await admin.from('spaces').insert({ name: `rls-space-${stamp}`, created_by: userA.id }).select('id').single()
  if (sp.error || !sp.data) throw new Error(`seed space failed: ${sp.error && sp.error.message}`)
  spaceId = sp.data.id
  await admin.from('memberships').insert({ space_id: spaceId, user_id: userA.id, role: 'owner' })
  await admin.from('notifications').insert({ space_id: spaceId, user_id: userA.id, type: 'rls-test' })

  const clientA = authedClient(userA.token)
  const clientB = authedClient(userB.token)

  // 1) user B must NOT read user A's notifications (RLS filters silently -> empty, not error).
  const readB = await clientB.from('notifications').select('*').eq('space_id', spaceId)
  if (readB.error) failures.push(`B read returned an error instead of empty set: ${readB.error.message}`)
  if ((readB.data ? readB.data.length : 0) > 0) failures.push(`LEAK: user B read ${readB.data.length} of user A's notifications.`)

  // 2) user A DOES read their own (sanity: policy is not deny-all).
  const readA = await clientA.from('notifications').select('*').eq('space_id', spaceId)
  if (readA.error) failures.push(`A could not read own notifications: ${readA.error.message}`)
  if ((readA.data ? readA.data.length : 0) < 1) failures.push('user A could not read their own notification (policy is deny-all?).')

  // 3) user B must NOT insert into user A's space.
  const insB = await clientB.from('notifications').insert({ space_id: spaceId, user_id: userB.id, type: 'leaked' })
  if (!insB.error) failures.push("LEAK: user B inserted a notification into user A's space.")
} catch (err) {
  failures.push(`test harness error: ${err.message}`)
} finally {
  if (spaceId) {
    await admin.from('notifications').delete().eq('space_id', spaceId)
    await admin.from('memberships').delete().eq('space_id', spaceId)
    await admin.from('spaces').delete().eq('id', spaceId)
  }
  if (userAId) await admin.auth.admin.deleteUser(userAId)
  if (userBId) await admin.auth.admin.deleteUser(userBId)
}

if (failures.length > 0) {
  console.log('\x1b[31m[FAIL]\x1b[0m RLS cross-user isolation broken:')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('Fix the policies so each row is scoped to its owner (user_id = auth.uid()), then re-run.')
  process.exit(1)
}

console.log("\x1b[32m[PASS]\x1b[0m user B cannot read or write user A's rows; user A reads their own.")
process.exit(0)
