import fs from 'node:fs'
import path from 'node:path'

export const PROVIDER_ARTIFACT_REL = path.join('src', 'config', 'provider.generated.json')
const SCHEMA = 'discipline.provider-config/v1'
const BACKENDS = new Set(['SUPABASE', 'FIREBASE', 'LOCAL_ONLY'])
const AUTH_MODES = new Set(['MAGIC_LINK', 'EMAIL_PASSWORD', 'BOTH', 'NONE'])

export function readProviderConfig(projectRoot = process.cwd()) {
  const artifactPath = path.join(projectRoot, PROVIDER_ARTIFACT_REL)
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`${PROVIDER_ARTIFACT_REL} is missing. Run npm run discipline:provider:generate.`)
  }

  let config
  try {
    config = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  } catch (error) {
    throw new Error(`${PROVIDER_ARTIFACT_REL} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (config?.schema !== SCHEMA || !BACKENDS.has(config.backendProvider) || !AUTH_MODES.has(config.authMode)) {
    throw new Error(`${PROVIDER_ARTIFACT_REL} has an invalid provider contract. Run npm run discipline:provider:generate.`)
  }
  return config
}

export function assertNoLegacyProviderEnv(env = process.env) {
  const keys = ['VITE_BACKEND_PROVIDER', 'VITE_AUTH_MODE', 'EXPO_PUBLIC_BACKEND_PROVIDER', 'EXPO_PUBLIC_AUTH_MODE']
  const present = keys.filter((key) => String(env[key] ?? '').trim())
  if (present.length > 0) {
    throw new Error(
      `${present.join(', ')} no longer selects architecture. Set BACKEND_PROVIDER and AUTH_MODE in discipline.md, then run npm run discipline:provider:generate.`,
    )
  }
}
