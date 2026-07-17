/**
 * Discipline Loop env-check — fail-fast on credentials and legacy architecture vars.
 *
 * Import this module once at app startup (main.tsx). Provider and auth come from
 * the generated, versioned contract; .env contains credentials only.
 */

import { resolveRuntimeConfig } from './runtime.shared.js'

const env = import.meta.env
const { BACKEND_PROVIDER: provider } = resolveRuntimeConfig()
const errors: string[] = []

const LEGACY_PROVIDER_KEY = 'VITE_BACKEND_PROVIDER'
const LEGACY_AUTH_KEY = 'VITE_AUTH_MODE'
for (const key of [LEGACY_PROVIDER_KEY, LEGACY_AUTH_KEY]) {
    if (env[key]) {
        errors.push(
            `${key} no longer selects architecture. Set BACKEND_PROVIDER and AUTH_MODE in discipline.md, then run npm run discipline:provider:generate.`,
        )
    }
}

if (provider === 'SUPABASE') {
    if (!env.VITE_SUPABASE_URL) errors.push('VITE_SUPABASE_URL is required when discipline.md selects SUPABASE')
    if (!env.VITE_SUPABASE_ANON_KEY) errors.push('VITE_SUPABASE_ANON_KEY is required when discipline.md selects SUPABASE')
}

if (provider === 'FIREBASE') {
    const required = [
        'VITE_FIREBASE_API_KEY',
        'VITE_FIREBASE_AUTH_DOMAIN',
        'VITE_FIREBASE_PROJECT_ID',
        'VITE_FIREBASE_APP_ID',
    ] as const
    for (const key of required) {
        if (!env[key]) errors.push(`${key} is required when discipline.md selects FIREBASE`)
    }
}

if (errors.length > 0) {
    throw new Error([
        '[Discipline Loop] env-check failed — fix before continuing:',
        ...errors.map(e => `  • ${e}`),
    ].join('\n'))
}
