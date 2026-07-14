import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { getProvider, normalizeProviderName } from './llm_providers/index.js'
import { resolveProviderResponseSchema } from './llm_providers/response_schema.js'
import { isAiEnabled, listConfiguredEvalFeatures } from './project_state.js'

function parseArgs(argv) {
    const args = {}
    for (const part of argv.slice(2)) {
        const m = part.match(/^--([^=]+)=(.*)$/)
        if (m) args[m[1]] = m[2]
    }
    return args
}

function readJsonl(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map((line, idx) => {
            try {
                return JSON.parse(line)
            } catch {
                throw new Error(`Invalid JSONL at ${filePath}:${idx + 1}`)
            }
        })
}

function isObject(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function partialDiff(expected, actual, p = '$') {
    const diffs = []
    const expPrimitive = expected === null || typeof expected !== 'object'
    const actPrimitive = actual === null || typeof actual !== 'object'
    if (expPrimitive || actPrimitive) {
        if (expected !== actual) diffs.push(`${p}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
        return diffs
    }

    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) {
            diffs.push(`${p}: expected array got ${typeof actual}`)
            return diffs
        }
        for (let i = 0; i < expected.length; i++) {
            diffs.push(...partialDiff(expected[i], actual?.[i], `${p}[${i}]`))
        }
        return diffs
    }

    if (!isObject(expected) || !isObject(actual)) {
        diffs.push(`${p}: expected object got ${typeof actual}`)
        return diffs
    }

    for (const [k, v] of Object.entries(expected)) {
        if (!(k in actual)) {
            diffs.push(`${p}.${k}: missing key`)
            continue
        }
        diffs.push(...partialDiff(v, actual[k], `${p}.${k}`))
    }
    return diffs
}

async function loadSchema(schemaPath) {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    return { schema, validate }
}

function loadSystemPrompt(systemPath) {
    return fs.readFileSync(systemPath, 'utf8')
}

function loadFixtureActual(feature, caseId, inlineActual) {
    if (inlineActual) return inlineActual
    const fixturePath = path.join('.tmp', 'llm_fixtures', feature, `${caseId}.json`)
    if (fs.existsSync(fixturePath)) return JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    return null
}

// Transient provider errors (e.g. Gemini 503 UNAVAILABLE "high demand") are
// server-side capacity blips, not contract failures — retrying the same request
// usually succeeds. Retry those a few times with linear backoff so the live gate
// does not flake on them. Non-transient errors (schema, auth, quota 429) throw
// immediately so they surface as real failures.
async function generateJsonWithRetry(provider, args, maxAttempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await provider.generateJson(args)
        } catch (e) {
            const msg = String(e?.message ?? e)
            const transient = /\b503\b|UNAVAILABLE|overloaded|high demand/i.test(msg)
            if (!transient || attempt >= maxAttempts) throw e
            await new Promise(resolve => setTimeout(resolve, 1500 * attempt))
        }
    }
}

function resolveFeatures(featureArg) {
    if (featureArg) return [featureArg]
    return listConfiguredEvalFeatures()
}

async function runFeatureEval({ feature, mode, providerName, modelOverride, maxCases }) {
    const systemPath = path.join('prompts', feature, 'system.md')
    const schemaPath = path.join('prompts', feature, 'schema.json')
    const evalPath = path.join('evals', `${feature}.jsonl`)

    for (const p of [systemPath, schemaPath, evalPath]) {
        if (!fs.existsSync(p)) {
            console.error(`[FAIL] Missing required file: ${p}`)
            process.exit(1)
        }
    }

    const system = loadSystemPrompt(systemPath)
    const { schema, validate } = await loadSchema(schemaPath)
    const cases = readJsonl(evalPath).slice(0, maxCases)

    console.log(`--- LLM EVAL --- feature=${feature} mode=${mode} cases=${cases.length}`)

    let failed = 0

    const provider = mode === 'live' ? await getProvider(providerName) : null

    // In live mode, providers with native structured output receive a MINIMAL,
    // provider-shaped schema — never the canonical JSON Schema 2020-12, which
    // Gemini rejects with a 400 (Unknown name "$schema"). The canonical `schema`
    // still enforces validation via AJV below. See tools/LLM_TOOLS_README.md §8.
    let responseSchema = schema
    if (mode === 'live') {
        const resolved = resolveProviderResponseSchema({ feature, provider: providerName, canonicalSchema: schema })
        responseSchema = resolved.schema
        if (resolved.source === 'canonical') {
            const providerLabel = normalizeProviderName(providerName) || '<provider>'
            console.warn(`[WARN] ${feature}: no minimal provider schema found (looked for prompts/${feature}/schema.${providerLabel}.json then schema.aistudio.json). Passing the canonical schema.json as responseSchema — some providers accept it, but Gemini returns 400 for $schema/$defs/additionalProperties/minimum. Add prompts/${feature}/schema.${providerLabel}.json (OpenAI-shaped: additionalProperties:false + all fields required) or schema.aistudio.json (Gemini-shaped) to silence this.`)
        } else {
            console.log(`[INFO] ${feature}: using ${resolved.source} response schema from ${resolved.path}; canonical schema.json still validates the response via AJV.`)
        }
    }

    for (const c of cases) {
        const id = c.id ?? '(no-id)'
        const input = c.input
        const expected = c.expected ?? {}

        if (!input || !isObject(input)) {
            console.error(`[FAIL] ${id}: missing/invalid input`)
            failed++
            continue
        }

        let actual = null

        try {
            if (mode === 'fixture') {
                actual = loadFixtureActual(feature, id, c.actual)
                if (!actual) {
                    throw new Error(`No actual output found. Provide "actual" in evals OR create .tmp/llm_fixtures/${feature}/${id}.json`)
                }
            } else if (mode === 'live') {
                actual = await generateJsonWithRetry(provider, {
                    model: modelOverride,
                    system,
                    input,
                    responseSchema, // Minimal, provider-shaped schema resolved above; canonical schema.json still validates via AJV.
                })
            } else {
                throw new Error(`Unknown mode: ${mode}`)
            }
        } catch (e) {
            console.error(`[FAIL] ${id}: ${e.message}`)
            failed++
            continue
        }

        if (!isObject(actual)) {
            console.error(`[FAIL] ${id}: actual is not an object`)
            failed++
            continue
        }

        // Schema validation
        const ok = validate(actual)
        if (!ok) {
            console.error(`[FAIL] ${id}: schema validation failed`)
            console.error(validate.errors)
            failed++
            continue
        }

        // Partial expected match
        const diffs = partialDiff(expected, actual)
        if (diffs.length) {
            console.error(`[FAIL] ${id}: expected mismatch`)
            for (const d of diffs.slice(0, 20)) console.error('  -', d)
            if (diffs.length > 20) console.error(`  ... ${diffs.length - 20} more`)
            failed++
            continue
        }

        console.log(`[PASS] ${id}`)
    }

    if (failed) {
        console.error(`--- RESULT: FAIL (${failed}/${cases.length}) ---`)
        return false
    }

    console.log('--- RESULT: PASS ---')
    return true
}

async function main() {
    const args = parseArgs(process.argv)
    const feature = args.feature?.trim()
    const mode = (args.mode ?? 'fixture').toLowerCase()
    const providerName = args.provider // optional: overrides env
    const modelOverride = args.model // optional
    const maxCases = args.max ? Number(args.max) : Infinity
    const features = resolveFeatures(feature)

    if (!features.length) {
        const message = 'No AI evals configured yet. Create prompts/<feature>/system.md, prompts/<feature>/schema.json and evals/<feature>.jsonl.'
        if (isAiEnabled()) {
            console.error(`[FAIL] ${message}`)
            process.exit(1)
        }

        console.log(`[SKIP] ${message}`)
        process.exit(0)
    }

    let failedFeatures = 0

    for (const currentFeature of features) {
        const passed = await runFeatureEval({
            feature: currentFeature,
            mode,
            providerName,
            modelOverride,
            maxCases,
        })

        if (!passed) {
            failedFeatures++
        }
    }

    if (failedFeatures) {
        process.exit(1)
    }

    process.exit(0)
}

await main()
