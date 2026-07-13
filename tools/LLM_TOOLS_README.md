# LLM Tools (Discipline Loop) — Smoke Test + Evals

These scripts support the AI Studio Lane with:
- **Smoke test** (Link Phase): verify provider/keys and JSON response
- **Evals** (goldens): validate JSON schema + compare partial expectations in `.jsonl`

> Only use when `AI_FEATURES=enabled` in `discipline.md`.

---

## 1) Expected structure per feature
For a feature `<feature>`:

- `prompts/<feature>/system.md`
- `prompts/<feature>/schema.json` — canonical JSON Schema 2020-12 (validation boundary)
- `prompts/<feature>/schema.<provider>.json` — **optional**, per-provider minimal
  schema for live mode (e.g. `schema.openai.json`). Use for OpenAI/openai-compatible.
- `prompts/<feature>/schema.aistudio.json` — **optional**, generic Gemini-shaped
  minimal schema for live mode. See §8 for how the eval runner picks between them.
- `evals/<feature>.jsonl`

Base templates:
- `prompts/_templates/*` (includes `schema.json`, plus `schema.aistudio.json` and
  `schema.openai.json` as minimal-schema examples for the two opposite shapes)
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

## 8) Structured output: JSON Schema (AJV) vs OpenAPI subset (provider) — gotchas

Providers with native structured output (Gemini `responseSchema`, OpenAI
`json_schema`, Grok, Mistral, ...) do **not** consume full JSON Schema. Each one
accepts a restricted, OpenAPI-3.0-style subset. That forces **two representations
of the same contract**, which this tooling already relies on:

- **Canonical** — `prompts/<feature>/schema.json`, full JSON Schema 2020-12: the
  `ok/data/error` envelope, `$defs`/`$ref`, `additionalProperties`, and every
  numeric/size constraint. This is the validation boundary — `tools/llm_eval.js`
  validates each response against it with AJV, and any endpoint that persists the
  output should re-validate too. It needs the draft-2020-12 build of AJV:
  `import Ajv2020 from 'ajv/dist/2020.js'`. A plain `new Ajv()` cannot resolve the
  `.../2020-12/schema` meta-schema and throws.
- **Provider** — a hand-minimized copy (e.g. `prompts/<feature>/schema.aistudio.json`
  or `prompts/<feature>/schema.openai.json`) passed to the model as `responseSchema`.
  The adapter (`tools/llm_providers/payloads.js` → `buildGeminiJsonRequest`) forwards
  `responseSchema` **verbatim, without sanitizing it** — that is deliberate: the
  adapter transports the request shape, it does not rewrite schema content. So the
  **caller** owns which representation to pass, and must pass the minimal version,
  never the canonical one.

The numeric/size constraints are **not lost** by minimizing the provider schema:
they stay in `schema.json` and AJV enforces them against the response after the
call.

### How `tools/llm_eval.js` picks the provider schema (live mode)

The eval runner is a caller, so it does the picking for you via
`resolveProviderResponseSchema` (`tools/llm_providers/response_schema.js`) before
the call. Only the canonical `schema.json` keeps validating the response with AJV
afterwards. Resolution is by precedence:

1. `prompts/<feature>/schema.<provider>.json` — provider-specific (e.g.
   `schema.openai.json`). **This is the correct path for OpenAI/openai-compatible**,
   whose `json_schema` strict mode requires the OPPOSITE of Gemini:
   `additionalProperties: false` and every property listed in `required`.
2. `prompts/<feature>/schema.aistudio.json` — generic Gemini-shaped minimal schema.
   Safe **only** for Gemini and Gemini-shaped providers; it would fail OpenAI strict.
3. Canonical `schema.json` — fallback, emitted with a clear `[WARN]`. Some providers
   accept it; Gemini returns `400 INVALID_ARGUMENT: Unknown name "$schema"`.

**Do not reuse one minimal file across providers.** The Gemini shape (drop
`additionalProperties`, no `$ref`/`$defs`, `nullable` instead of type-arrays, no
numeric constraints) and the OpenAI strict shape (`additionalProperties: false`,
all fields `required`) are mutually exclusive. Keep one `schema.<provider>.json`
per target you run live, or a single `schema.aistudio.json` when you only run
Gemini. `prompts/_templates/schema.aistudio.json` and `schema.openai.json` show
both shapes derived from the same canonical `schema.json`.

### What Gemini's subset rejects (verified 2026-07-13, AI Studio + API)

- `additionalProperties` → explicit error: `Unknown key: additionalProperties`.
- type-arrays like `"type": ["object", "null"]` → use `"nullable": true` instead.
- `$defs` / `$ref` / `allOf` / `if`/`then` — no composition or references; inline
  everything.
- `minimum` / `maximum` / `minItems` / `maxItems` → these fail with a **generic**
  `An internal error has occurred` (in AI Studio), with no useful message — very
  hard to isolate. Drop them from the provider schema.

In practice Gemini's accepted subset is essentially only `type`, `properties`,
`required`, `enum`, and `nullable`. Other native-structured-output providers
impose *different* subsets (OpenAI's `json_schema`, for example, conversely
*requires* `additionalProperties: false` and also rejects `minimum`/`maximum`), so
validate the minimal schema against each provider you target instead of assuming
Gemini's exact rules transfer.

### AI Studio editor

The "Structured outputs" panel asks for an "OpenAPI schema object". Use the
**Code Editor** tab (not the Visual Editor) to paste raw JSON.

### Grounding (Google Search / Maps) + structured output

- Gemini 3 **does** combine Google Search grounding with `responseSchema` through
  the official `@google/genai` SDK (the one `tools/llm_providers/gemini.js` uses):
  set `config.tools = [{ googleSearch: {} }]` together with `config.responseSchema`
  and `config.responseMimeType = 'application/json'`. The Vercel `@ai-sdk/google`
  wrapper blocks this (it forces a second, tool-free call) — prefer the official
  SDK for grounded structured output.
- In AI Studio you **cannot** enable Google Search + Google Maps + Structured
  outputs at the same time ("not compatible with the current active tools"); verify
  multi-tool combinations against the live API, not the Playground.
- **Grounding injects citations into string values.** Even when the prompt forbids
  it, grounded responses embed markers like `[[1](https://…vertexaisearch…)]`
  inside string fields (occasionally a bare non-URL artifact such as `[1.1.7]`).
  This is grounding-system behavior, not prompt non-compliance — reinforcing the
  prompt does not stop it. Any consumer that persists grounded text **must** strip
  them (e.g. `/\s*\[\[?\d+\]?\((https?:\/\/[^)]+)\)\]?/g`) or read
  `candidates[].groundingMetadata` separately instead of trusting the inline text.

### Billing

The Gemini API free tier calls Flash models without a card, but **grounding
(Search/Maps) returns `429` ("check your plan and billing") unless billing is
enabled**. The consumer Gemini / Google AI Pro subscription ($20/mo) does **not**
grant API access — it is a separate product. Any feature that uses grounding needs
a billing-enabled API key.

---

End.
