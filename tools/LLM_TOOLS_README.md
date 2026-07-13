# LLM Tools (Discipline Loop) — Smoke Test + Evals

These scripts support the AI Studio Lane with:
- **Smoke test** (Link Phase): verify provider/keys and JSON response
- **Evals** (goldens): validate JSON schema + compare partial expectations in `.jsonl`

> Only use when `AI_FEATURES=enabled` in `discipline.md`.

---

## 1) Expected structure per feature
For a feature `<feature>`:

- `prompts/<feature>/system.md`
- `prompts/<feature>/schema.json`
- `evals/<feature>.jsonl`

Base templates:
- `prompts/_templates/*`
- `evals/_templates/*`

---

## 2) Install dependencies (only for your provider)
```bash
npm i -D ajv ajv-formats dotenv
npm i -D openai
# or
npm i -D @google/genai
# or
npm i -D @anthropic-ai/sdk
```

`grok`, `mistral`, `deepseek`, `qwen`, `minimax`, `ollama`, `llama`, `gemma` and
`openai-compatible` use the built-in Node `fetch`; they add no SDK dependency.

---

## 3) Environment variables

Create `.env` (DO NOT commit) with your chosen provider.

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=<model-id-validated-for-this-project>
```

### Gemini

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=<model-id-validated-for-this-project>
```

### Anthropic

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=<model-id-validated-for-this-project>
ANTHROPIC_MAX_TOKENS=2048
```

### Mistral and Grok

Both support JSON Schema structured output through their first-party APIs.

```env
# Mistral
LLM_PROVIDER=mistral
MISTRAL_API_KEY=...
MISTRAL_MODEL=<model-id-validated-for-this-project>
# Optional; defaults to https://api.mistral.ai/v1
MISTRAL_BASE_URL=...

# xAI Grok
LLM_PROVIDER=grok
XAI_API_KEY=...
GROK_MODEL=<model-id-validated-for-this-project>
# Optional; defaults to https://api.x.ai/v1
GROK_BASE_URL=...
```

### DeepSeek, Qwen and MiniMax

These adapters use OpenAI-compatible chat endpoints. DeepSeek and Qwen request JSON
objects; MiniMax relies on the prompt contract. `llm_eval` still validates every
response with AJV, so a model cannot pass merely by returning parseable JSON.

```env
# DeepSeek: defaults to https://api.deepseek.com
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=<model-id-validated-for-this-project>
DEEPSEEK_BASE_URL=...

# Qwen: default is the US Model Studio endpoint; set the regional or workspace URL explicitly when needed.
LLM_PROVIDER=qwen
DASHSCOPE_API_KEY=...
QWEN_MODEL=<model-id-validated-for-this-project>
QWEN_BASE_URL=...

# MiniMax: defaults to https://api.minimax.io/v1
LLM_PROVIDER=minimax
MINIMAX_API_KEY=...
MINIMAX_MODEL=<model-id-validated-for-this-project>
MINIMAX_BASE_URL=...
```

### Local/open-weight and any compatible host

`llama` and `gemma` are open-weight families, not one universal hosted API. Point
them at an OpenAI-compatible runtime such as vLLM, LM Studio or a hosted vendor.
`ollama` defaults to its local OpenAI-compatible endpoint. `openai-compatible`
is the escape hatch for any other compatible provider.

```env
# Ollama local; API key is optional
LLM_PROVIDER=ollama
OLLAMA_MODEL=<installed-model-name>
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1

# Hosted or local Llama / Gemma
LLM_PROVIDER=llama # or gemma
LLAMA_MODEL=<model-id>
LLAMA_BASE_URL=<openai-compatible-base-url>
LLAMA_API_KEY=<optional-if-host-requires-it>

# Generic OpenAI-compatible endpoint
LLM_PROVIDER=openai-compatible
LLM_COMPATIBLE_MODEL=<model-id>
LLM_COMPATIBLE_BASE_URL=<base-url-ending-in-/v1>
LLM_COMPATIBLE_API_KEY=<optional>
# json_schema | json_object | prompt (default: json_object)
LLM_COMPATIBLE_STRUCTURED_OUTPUT=json_object
```

Use `LLM_COMPATIBLE_STRUCTURED_OUTPUT=prompt` only when the host rejects its JSON
mode. It is a compatibility fallback, not a schema guarantee.

---

## 4) Smoke test (Link Phase)

Verifies provider responds and returns parseable JSON.

```bash
npm run ai:smoke
```
If `AI_FEATURES=none`, the script skips without loading optional SDKs.

---

## 5) Evals (goldens) — fixture mode (cheap)

No provider calls. Uses saved outputs in:

* `"actual"` field inside the `.jsonl`, or
* `.tmp/llm_fixtures/<feature>/<case-id>.json`

```bash
npm run ai:eval
```
For a specific feature:
```bash
node tools/llm_eval.js --feature=extract_tasks --mode=fixture
```

---

## 6) Evals (goldens) — live mode (calls provider)

Uses `LLM_PROVIDER` and calls the real model. Validates:

* Parseable JSON
* Valid JSON schema
* Expected partial match

### OpenAI
```bash
LLM_PROVIDER=openai OPENAI_API_KEY=... OPENAI_MODEL=<model-id> \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### Gemini
```bash
LLM_PROVIDER=gemini GEMINI_API_KEY=... GEMINI_MODEL=<model-id> \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### Anthropic
```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=<model-id> \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### Mistral
```bash
LLM_PROVIDER=mistral MISTRAL_API_KEY=... MISTRAL_MODEL=<model-id> \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### DeepSeek
```bash
LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=<model-id> \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

For every additional provider, run both `npm run ai:smoke` and the full live eval
set before selecting it for production. Do not infer quality, schema support,
privacy or availability from a model family name or a gateway slug.

Optional flags:
* `--max=N` (limit cases)
* `--model=...` (override model)

---

## 7) Discipline Loop anti-loop rule

If evals fail by schema repeatedly:

* DO NOT patch blindly in a loop
* Return to AI Studio, fix prompt/schema
* Update goldens (`evals/*.jsonl`)
* Retry from clean state

---

End.
