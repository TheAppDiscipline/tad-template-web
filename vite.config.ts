import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// FINDING-06: `vite build` eagerly resolves every dynamic-import target, including
// the backend providers you are NOT using (src/lib/backend/index.ts switches over
// supabase | firebase | local). Provider SDKs are installed on demand, so a build
// for one provider would otherwise fail to resolve the others' static imports
// (e.g. "could not resolve firebase/auth" in a SUPABASE-only project).
//
// Fix: stub ONLY the non-active providers' SDKs, decided from VITE_BACKEND_PROVIDER
// at build time. The active provider keeps its real SDK (which you must install).
// Unset/invalid -> treated as LOCAL_ONLY (stub both) so a bare, unconfigured
// template still builds green out of the box. This mirrors how the app resolves
// the provider at runtime, so the build never stubs the provider actually used.
const stub = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const FIREBASE_STUB = stub('./src/lib/backend/firebase/firebase-sdk-stub.ts')
const SUPABASE_STUB = stub('./src/lib/backend/supabase/supabase-sdk-stub.ts')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const provider = String(env.VITE_BACKEND_PROVIDER ?? '').trim().toUpperCase()

  const alias: Record<string, string> = {}
  if (provider !== 'FIREBASE') {
    alias['firebase/app'] = FIREBASE_STUB
    alias['firebase/auth'] = FIREBASE_STUB
    alias['firebase/firestore'] = FIREBASE_STUB
  }
  if (provider !== 'SUPABASE') {
    alias['@supabase/supabase-js'] = SUPABASE_STUB
  }

  return {
    plugins: [react()],
    resolve: { alias },
  }
})
