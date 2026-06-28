// Build-time stub for the Supabase SDK when Supabase is NOT the active provider
// (FINDING-06). Aliased from `@supabase/supabase-js` in vite.config.ts only when
// BACKEND_PROVIDER is not SUPABASE (i.e. FIREBASE or LOCAL_ONLY builds).
//
// Why this exists: `vite build` eagerly resolves every dynamic-import target,
// including the Supabase backend branch in src/lib/backend/index.ts. That branch
// is only loaded at runtime when BACKEND_PROVIDER=SUPABASE; otherwise
// @supabase/supabase-js is not installed, so the specifier is aliased here purely
// so the production build can resolve the never-executed code.
//
// If you use SUPABASE: `npm i @supabase/supabase-js`. vite.config.ts then stops
// aliasing it automatically, so the real SDK is bundled.

const notInstalled = (): never => {
    throw new Error(
        'Supabase SDK is not installed (Supabase is not the active BACKEND_PROVIDER).'
    )
}

export const createClient = notInstalled
