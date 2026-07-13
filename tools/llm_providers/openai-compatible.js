import { extractJson } from './json.js'

const STRUCTURED_OUTPUT_MODES = new Set(['json_schema', 'json_object', 'prompt'])

function requireEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`Missing env var: ${name}`)
    return value
}

function stringifyInput(input) {
    return typeof input === 'string' ? input : JSON.stringify(input)
}

function jsonOnlySystemInstruction(system) {
    return `${system}\n\nReturn JSON only. Do not include markdown, explanations, or text outside the JSON value.`
}

export function toChatCompletionsEndpoint(baseUrl) {
    const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!normalized) throw new Error('Missing compatible provider base URL')
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

export function buildOpenAiCompatibleJsonRequest({
    model,
    system,
    input,
    responseSchema,
    structuredOutput = 'json_object',
    strictSchema = false,
}) {
    if (!STRUCTURED_OUTPUT_MODES.has(structuredOutput)) {
        throw new Error(`Unsupported structured output mode: ${structuredOutput}`)
    }

    const request = {
        model,
        messages: [
            { role: 'system', content: jsonOnlySystemInstruction(system) },
            { role: 'user', content: stringifyInput(input) },
        ],
    }

    if (structuredOutput === 'json_schema' && responseSchema) {
        request.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'discipline_response',
                ...(strictSchema ? { strict: true } : {}),
                schema: responseSchema,
            },
        }
    } else if (structuredOutput === 'json_object') {
        request.response_format = { type: 'json_object' }
    }

    return request
}

function readResponseText(payload, providerName) {
    const text = payload?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${providerName} response has empty content`)
    }
    return text
}

async function readErrorMessage(response) {
    try {
        const payload = await response.json()
        return payload?.error?.message ?? payload?.message ?? JSON.stringify(payload)
    } catch {
        return await response.text()
    }
}

export function createOpenAiCompatibleProvider({
    name,
    apiKeyEnv,
    modelEnv,
    baseUrlEnv,
    defaultBaseUrl,
    apiKeyRequired = true,
    structuredOutput = 'json_object',
    strictSchema = false,
}) {
    return {
        name,

        async generateJson({ model, system, input, responseSchema }) {
            const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined
            if (apiKeyRequired && !apiKey) requireEnv(apiKeyEnv)

            const selectedModel = model ?? process.env[modelEnv]
            if (!selectedModel) throw new Error(`Missing model. Set ${modelEnv} to a current model ID for ${name}`)

            const baseUrl = process.env[baseUrlEnv] ?? defaultBaseUrl
            if (!baseUrl) throw new Error(`Missing base URL. Set ${baseUrlEnv} for ${name}`)

            const response = await fetch(toChatCompletionsEndpoint(baseUrl), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify(buildOpenAiCompatibleJsonRequest({
                    model: selectedModel,
                    system,
                    input,
                    responseSchema,
                    structuredOutput,
                    strictSchema,
                })),
            })

            if (!response.ok) {
                throw new Error(`${name} request failed (${response.status}): ${await readErrorMessage(response)}`)
            }

            return extractJson(readResponseText(await response.json(), name))
        },
    }
}

export const openAiCompatibleProvider = createOpenAiCompatibleProvider({
    name: 'openai-compatible',
    apiKeyEnv: 'LLM_COMPATIBLE_API_KEY',
    modelEnv: 'LLM_COMPATIBLE_MODEL',
    baseUrlEnv: 'LLM_COMPATIBLE_BASE_URL',
    apiKeyRequired: false,
    structuredOutput: process.env.LLM_COMPATIBLE_STRUCTURED_OUTPUT ?? 'json_object',
    strictSchema: process.env.LLM_COMPATIBLE_STRICT_SCHEMA === 'true',
})
