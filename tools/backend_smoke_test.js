import dotenv from 'dotenv'
import path from 'node:path'
import { ensurePackageInstalled } from './optional_dependency.js'
import { assertNoLegacyProviderEnv, readProviderConfig } from './provider-config.js'

const projectFlag = process.argv.indexOf('--project-dir')
const projectRoot = projectFlag >= 0 ? path.resolve(process.argv[projectFlag + 1] ?? '') : process.cwd()
if (projectFlag >= 0 && !process.argv[projectFlag + 1]) {
    console.error('[FAIL] --project-dir requires a path.')
    process.exit(1)
}

dotenv.config({ path: path.join(projectRoot, '.env') })
try {
    assertNoLegacyProviderEnv()
} catch (error) {
    console.error(`[FAIL] ${error.message}`)
    process.exit(1)
}

let provider
try {
    provider = readProviderConfig(projectRoot).backendProvider
} catch (error) {
    console.error(`[FAIL] ${error.message}`)
    process.exit(1)
}

function requireCredentials(keys) {
    const missing = keys.filter((key) => !process.env[key])
    if (missing.length > 0) {
        console.error(`[FAIL] ${provider} is selected by discipline.md but missing credentials: ${missing.join(', ')}`)
        process.exit(1)
    }
}

if (provider === 'LOCAL_ONLY') {
    console.log('[PASS] LOCAL_ONLY: no backend smoke needed.')
    process.exit(0)
}

if (provider === 'SUPABASE') {
    requireCredentials(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
    try {
        ensurePackageInstalled({
            packageName: '@supabase/supabase-js',
            context: 'SUPABASE backend smoke test',
            installCommand: 'npm install @supabase/supabase-js',
        })
    } catch (error) {
        console.error(error.message)
        process.exit(1)
    }
    await import('./supabase_smoke_test.js')
    process.exit(0)
}

if (provider === 'FIREBASE') {
    requireCredentials(['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'])
    try {
        ensurePackageInstalled({
            packageName: 'firebase',
            context: 'FIREBASE backend smoke test',
            installCommand: 'npm install firebase',
        })
    } catch (error) {
        console.error(error.message)
        process.exit(1)
    }
    await import('./firebase_smoke_test.js')
    process.exit(0)
}

console.error('[FAIL] Unknown provider in generated contract:', provider)
process.exit(1)
