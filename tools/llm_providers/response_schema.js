// tools/llm_providers/response_schema.js
import fs from 'node:fs'
import path from 'node:path'
import { normalizeProviderName } from './index.js'

function readJsonFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8')
    try {
        return JSON.parse(raw)
    } catch (e) {
        throw new Error(`Invalid JSON at ${filePath}: ${e.message}`)
    }
}

/**
 * Resolve the schema representation passed to a provider as `responseSchema` in
 * live mode.
 *
 * Native structured-output providers do NOT accept full JSON Schema 2020-12 —
 * each one accepts a different, restricted OpenAPI-style subset (see
 * tools/LLM_TOOLS_README.md §8). Gemini rejects `$schema`/`$defs`/
 * `additionalProperties`/`minimum` with a 400; OpenAI `json_schema` strict, on
 * the contrary, REQUIRES `additionalProperties: false` and every field in
 * `required`. Because the two shapes are mutually exclusive, the minimal
 * representation is provider-specific and cannot be derived generically from the
 * canonical schema — it must be hand-curated per target.
 *
 * This resolver looks for that hand-curated minimal schema by precedence and
 * only falls back to the canonical one (which some providers accept and Gemini
 * does not) with `source: 'canonical'`, so the caller can warn.
 *
 * Precedence:
 *   1. prompts/<feature>/schema.<provider>.json -> 'provider-specific'
 *      (the correct choice for OpenAI/openai-compatible)
 *   2. prompts/<feature>/schema.aistudio.json   -> 'aistudio-generic'
 *      (generic Gemini-shaped minimal schema; unsafe for OpenAI strict)
 *   3. canonical schema                         -> 'canonical' (fallback + warn)
 *
 * The canonical schema keeps enforcing validation via AJV after the call; this
 * only changes what the provider receives up front.
 *
 * @param {object} args
 * @param {string} args.feature
 * @param {string} [args.provider] provider name or LLM_PROVIDER value
 * @param {object} args.canonicalSchema parsed prompts/<feature>/schema.json
 * @param {string} [args.promptsDir] base prompts directory (default 'prompts')
 * @returns {{ schema: object, source: 'provider-specific'|'aistudio-generic'|'canonical', path: string|null }}
 */
export function resolveProviderResponseSchema({ feature, provider, canonicalSchema, promptsDir = 'prompts' }) {
    const normalized = normalizeProviderName(provider)
    const featureDir = path.join(promptsDir, feature)

    const candidates = []
    if (normalized) {
        candidates.push({ source: 'provider-specific', file: `schema.${normalized}.json` })
    }
    candidates.push({ source: 'aistudio-generic', file: 'schema.aistudio.json' })

    for (const candidate of candidates) {
        const candidatePath = path.join(featureDir, candidate.file)
        if (fs.existsSync(candidatePath)) {
            return { schema: readJsonFile(candidatePath), source: candidate.source, path: candidatePath }
        }
    }

    return { schema: canonicalSchema, source: 'canonical', path: null }
}
