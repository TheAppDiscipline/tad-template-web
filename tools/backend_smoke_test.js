import 'dotenv/config'
import { ensurePackageInstalled } from './optional_dependency.js'

const provider = (process.env.VITE_BACKEND_PROVIDER || 'SUPABASE').toUpperCase()

if (provider === 'LOCAL_ONLY') {
    console.log('[PASS] LOCAL_ONLY: no backend smoke needed.')
    process.exit(0)
}

if (provider === 'SUPABASE') {
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

console.error('[FAIL] Unknown VITE_BACKEND_PROVIDER:', provider)
process.exit(1)
