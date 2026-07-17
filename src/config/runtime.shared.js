import generatedProviderConfig from './provider.generated.js'

/** @typedef {'SUPABASE' | 'FIREBASE' | 'LOCAL_ONLY'} BackendProvider */
/** @typedef {'MAGIC_LINK' | 'EMAIL_PASSWORD' | 'BOTH' | 'NONE'} AuthMode */

/** @type {BackendProvider} */
const backendProvider = generatedProviderConfig.backendProvider
/** @type {AuthMode} */
const authMode = generatedProviderConfig.authMode

// Generated from discipline.md by `npm run discipline:provider:generate`.
// Runtime configuration deliberately has no environment override: .env is for
// credentials, while architecture belongs to the versioned constitution.
export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
    BACKEND_PROVIDER: backendProvider,
    AUTH_MODE: authMode,
})

/** @returns {{ BACKEND_PROVIDER: BackendProvider, AUTH_MODE: AuthMode }} */
export function resolveRuntimeConfig(_env = {}) {
    return DEFAULT_RUNTIME_CONFIG
}
