import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const gemmaProvider = createOpenAiCompatibleProvider({
    name: 'gemma',
    apiKeyEnv: 'GEMMA_API_KEY',
    modelEnv: 'GEMMA_MODEL',
    baseUrlEnv: 'GEMMA_BASE_URL',
    apiKeyRequired: false,
    structuredOutput: 'prompt',
})
