import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const llamaProvider = createOpenAiCompatibleProvider({
    name: 'llama',
    apiKeyEnv: 'LLAMA_API_KEY',
    modelEnv: 'LLAMA_MODEL',
    baseUrlEnv: 'LLAMA_BASE_URL',
    apiKeyRequired: false,
    structuredOutput: 'prompt',
})
