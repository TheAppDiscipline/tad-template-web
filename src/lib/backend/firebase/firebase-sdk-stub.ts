// Build-time stub for the Firebase SDK when Firebase is NOT the active provider
// (FINDING-06). Aliased from `firebase/app|auth|firestore` in vite.config.ts only
// when BACKEND_PROVIDER is not FIREBASE.
//
// Why this exists: `vite build` eagerly resolves every dynamic-import target,
// including the Firebase backend branch in src/lib/backend/index.ts. That branch
// is only loaded at runtime when BACKEND_PROVIDER=FIREBASE; for a SUPABASE or
// LOCAL_ONLY project `firebase` is not installed, so the specifiers are aliased
// here purely so the production build can resolve the never-executed code.
//
// If you switch this project to FIREBASE: `npm i firebase`. vite.config.ts then
// stops aliasing firebase/* automatically, so the real SDK is bundled.

const notInstalled = (): never => {
    throw new Error(
        'Firebase SDK is not installed (Firebase is not the active BACKEND_PROVIDER).'
    )
}

export const initializeApp = notInstalled
export const getAuth = notInstalled
export const getFirestore = notInstalled
export const sendSignInLinkToEmail = notInstalled
export const signOut = notInstalled
