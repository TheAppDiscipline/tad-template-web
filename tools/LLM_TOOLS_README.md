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

---

## 3) Environment variables

Create `.env` (DO NOT commit) with your chosen provider.

### OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4
```

### Gemini

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-pro
```

### Anthropic

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_MAX_TOKENS=2048
```

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
LLM_PROVIDER=openai OPENAI_API_KEY=... OPENAI_MODEL=gpt-5.4 \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### Gemini
```bash
LLM_PROVIDER=gemini GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.1-pro \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

### Anthropic
```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-4-6 \
node tools/llm_eval.js --feature=extract_tasks --mode=live
```

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
