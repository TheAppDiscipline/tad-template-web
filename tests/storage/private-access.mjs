/**
 * tests/storage/private-access.mjs — private Storage isolation test (A7).
 *
 * Proves that a private file is actually private: an anonymous (logged-out) client
 * canNOT download user A's object, and a signed URL stops working after it expires.
 * Service-role key is used ONLY here, to seed the object — never in client code.
 *
 * Plain Node ESM. Wired to `npm run test:storage:privacy`; required by scorecard
 * item L17 when UPLOADS=true. Skips cleanly when env/bucket are absent so it never
 * blocks the gate on machines without a storage backend.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, TEST_PRIVATE_BUCKET
 *
 * Exit 0 = pass or skip, Exit 1 = a private object was readable without auth.
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = process.env.TEST_PRIVATE_BUCKET

function skip(reason) {
  console.log(`\x1b[33m[SKIP]\x1b[0m test:storage:privacy — ${reason}`)
  process.exit(0)
}

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE || !BUCKET) {
  skip('set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY + TEST_PRIVATE_BUCKET (a private bucket) to run it.')
}

let createClient
try {
  ;({ createClient } = await import('@supabase/supabase-js'))
} catch {
  skip('@supabase/supabase-js not installed. Run `npm i @supabase/supabase-js`.')
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })

const objectPath = `privacy-test-${Date.now()}.txt`
const failures = []

console.log('--- Security Gate: private Storage isolation ---')

try {
  const up = await admin.storage.from(BUCKET).upload(objectPath, new Blob(['secret-bytes']), { upsert: true })
  if (up.error) skip(`could not upload to bucket "${BUCKET}" (does it exist?): ${up.error.message}`)

  // 1) Anonymous client must NOT download a private object.
  const dl = await anon.storage.from(BUCKET).download(objectPath)
  if (!dl.error && dl.data) failures.push(`LEAK: anonymous client downloaded the private object "${objectPath}".`)

  // 2) Signed URL works now, then expires.
  const signed = await admin.storage.from(BUCKET).createSignedUrl(objectPath, 2)
  if (signed.error || !signed.data || !signed.data.signedUrl) {
    failures.push(`could not create signed URL: ${signed.error && signed.error.message}`)
  } else {
    const first = await fetch(signed.data.signedUrl)
    if (!first.ok) failures.push(`signed URL did not work while valid (status ${first.status}).`)
    await new Promise((r) => setTimeout(r, 3000))
    const afterExpiry = await fetch(signed.data.signedUrl)
    if (afterExpiry.ok) failures.push('signed URL still worked AFTER its 2s expiry (no expiration enforced).')
  }
} catch (err) {
  failures.push(`test harness error: ${err.message}`)
} finally {
  try {
    await admin.storage.from(BUCKET).remove([objectPath])
  } catch {
    // ignore cleanup error
  }
}

if (failures.length > 0) {
  console.log('\x1b[31m[FAIL]\x1b[0m private Storage isolation broken:')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('Fix: make the bucket private, add per-user Storage policies, and use short-lived signed URLs.')
  process.exit(1)
}

console.log('\x1b[32m[PASS]\x1b[0m anonymous client cannot read the private object; signed URL expires.')
process.exit(0)
