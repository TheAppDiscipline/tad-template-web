import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export const deepseekProvider = createOpenAiCompatibleProvider({
    name: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
    structuredOutput: 'json_object',
})
