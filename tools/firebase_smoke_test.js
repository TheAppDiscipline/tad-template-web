import 'dotenv/config'

console.log('--- Firebase Smoke Test ---')

const required = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_APP_ID',
]

const missing = required.filter(k => !process.env[k])
if (missing.length) {
    console.error('[FAIL] Missing Firebase env vars:', missing.join(', '))
    process.exit(1)
}

console.log('[PASS] Firebase env vars present (init can proceed in app).')
process.exit(0)
