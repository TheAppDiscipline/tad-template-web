// tools/llm_providers/index.js
import { ensurePackageInstalled } from '../optional_dependency.js'

const PROVIDERS = {
    openai: {
        exportName: 'openaiProvider',
        packageName: 'openai',
        installCommand: 'npm install -D openai',
        loader: () => import('./openai.js'),
    },
    gemini: {
        exportName: 'geminiProvider',
        packageName: '@google/genai',
        installCommand: 'npm install -D @google/genai',
        loader: () => import('./gemini.js'),
    },
    anthropic: {
        exportName: 'anthropicProvider',
        packageName: '@anthropic-ai/sdk',
        installCommand: 'npm install -D @anthropic-ai/sdk',
        loader: () => import('./anthropic.js'),
    },
    grok: {
        exportName: 'grokProvider',
        loader: () => import('./grok.js'),
    },
    mistral: {
        exportName: 'mistralProvider',
        loader: () => import('./mistral.js'),
    },
    deepseek: {
        exportName: 'deepseekProvider',
        loader: () => import('./deepseek.js'),
    },
    qwen: {
        exportName: 'qwenProvider',
        loader: () => import('./qwen.js'),
    },
    minimax: {
        exportName: 'minimaxProvider',
        loader: () => import('./minimax.js'),
    },
    ollama: {
        exportName: 'ollamaProvider',
        loader: () => import('./ollama.js'),
    },
    llama: {
        exportName: 'llamaProvider',
        loader: () => import('./llama.js'),
    },
    gemma: {
        exportName: 'gemmaProvider',
        loader: () => import('./gemma.js'),
    },
    'openai-compatible': {
        exportName: 'openAiCompatibleProvider',
        loader: () => import('./openai-compatible.js'),
    },
}

export const SUPPORTED_LLM_PROVIDERS = Object.freeze(Object.keys(PROVIDERS))

export function normalizeProviderName(providerName) {
    return (providerName ?? process.env.LLM_PROVIDER ?? '').trim().toLowerCase()
}

export function getProviderConfig(providerName) {
    const p = normalizeProviderName(providerName)

    if (!p) {
        throw new Error(`Missing provider. Set LLM_PROVIDER to one of: ${SUPPORTED_LLM_PROVIDERS.join('|')}, or pass --provider=...`)
    }

    const config = PROVIDERS[p]
    if (!config) {
        throw new Error(`Unknown provider: ${p}`)
    }

    return { name: p, ...config }
}

export async function getProvider(providerName) {
    const config = getProviderConfig(providerName)

    if (config.packageName) {
        ensurePackageInstalled({
            packageName: config.packageName,
            context: `LLM provider "${config.name}"`,
            installCommand: config.installCommand,
        })
    }

    const mod = await config.loader()
    return mod[config.exportName]
}
