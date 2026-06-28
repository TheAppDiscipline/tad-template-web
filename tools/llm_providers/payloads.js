export const ANTHROPIC_JSON_TOOL_NAME = 'emit_json'

function stringifyInput(input) {
    return typeof input === 'string' ? input : JSON.stringify(input)
}

export function buildOpenAiJsonRequest({ model, system, input, responseSchema }) {
    const request = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: stringifyInput(input) },
        ],
    }

    if (responseSchema) {
        request.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'discipline_response',
                strict: true,
                schema: responseSchema,
            },
        }
        return request
    }

    // Compatibility fallback for ad-hoc smoke calls that do not pass a schema.
    request.response_format = { type: 'json_object' }
    return request
}

export function buildAnthropicJsonRequest({ model, system, input, responseSchema, maxTokens }) {
    const request = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: stringifyInput(input) }],
    }

    if (responseSchema) {
        request.tools = [{
            name: ANTHROPIC_JSON_TOOL_NAME,
            description: 'Return the requested JSON payload. Do not include prose.',
            input_schema: responseSchema,
        }]
        request.tool_choice = { type: 'tool', name: ANTHROPIC_JSON_TOOL_NAME }
    }

    return request
}

export function buildGeminiJsonRequest({ system, input, responseSchema }) {
    const request = {
        contents: stringifyInput(input),
        config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
        },
    }

    if (responseSchema) {
        request.config.responseSchema = responseSchema
    }

    return request
}
