import 'dotenv/config'
import { getProvider } from './llm_providers/index.js'
import { isAiEnabled } from './project_state.js'

if (!isAiEnabled()) {
    console.log('[SKIP] AI_FEATURES is not enabled in discipline.md.')
    process.exit(0)
}

const model = process.env.LLM_MODEL // optional

const input = {
    request_id: 'smoke-001',
    user_context: { timezone: 'UTC', locale: 'en-US' },
    input: { ping: true },
}

const system = `You must output JSON only. Return:
{"schema_version":"v1","request_id":"smoke-001","ok":true,"data":{},"error":{"code":"NONE","message":"ok","missing_fields":[],"retryable":false}}`

console.log('--- LLM SMOKE TEST --- provider=', process.env.LLM_PROVIDER)
try {
    const provider = await getProvider()
    const out = await provider.generateJson({ model, system, input })
    console.log('[PASS] got JSON:', JSON.stringify(out, null, 2))
} catch (e) {
    console.error('[FAIL] Smoke test failed:', e.message)
    process.exit(1)
}
