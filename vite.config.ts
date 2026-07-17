import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import providerConfig from './src/config/provider.generated.json'

// FINDING-06: `vite build` eagerly resolves every dynamic-import target, including
// the backend providers you are NOT using (src/lib/backend/index.ts switches over
// supabase | firebase | local). Provider SDKs are installed on demand, so a build
// for one provider would otherwise fail to resolve the others' static imports
// (e.g. "could not resolve firebase/auth" in a SUPABASE-only project).
//
// Fix: stub ONLY the non-active providers' SDKs, decided from the generated
// provider contract. The active provider keeps its real SDK (which you install).
// Runtime reads the same versioned artifact, so build cannot stub its live backend.
const stub = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const FIREBASE_STUB = stub('./src/lib/backend/firebase/firebase-sdk-stub.ts')
const SUPABASE_STUB = stub('./src/lib/backend/supabase/supabase-sdk-stub.ts')

// https://vite.dev/config/
export default defineConfig(() => {
  const provider = providerConfig.backendProvider

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
