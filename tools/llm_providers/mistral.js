import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const mistralProvider = createOpenAiCompatibleProvider({
    name: 'mistral',
    apiKeyEnv: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    structuredOutput: 'json_schema',
})
