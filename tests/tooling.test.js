import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TEMPLATE_STATE_CARDS } from '../src/app-shell-content.js'
import { AppShellView } from '../src/app-shell-view.js'
import { DEFAULT_RUNTIME_CONFIG, resolveRuntimeConfig } from '../src/config/runtime.shared.js'
import {
    createFirebaseBackend,
} from '../src/lib/backend/firebase/backend.shared.js'
import {
    LOCAL_STORAGE_KEYS,
    createLocalBackend,
} from '../src/lib/backend/local/backend.shared.js'
import { getProvider, getProviderConfig, SUPPORTED_LLM_PROVIDERS } from '../tools/llm_providers/index.js'
import {
    ANTHROPIC_JSON_TOOL_NAME,
    buildAnthropicJsonRequest,
    buildGeminiJsonRequest,
    buildOpenAiJsonRequest,
} from '../tools/llm_providers/payloads.js'
import {
    buildOpenAiCompatibleJsonRequest,
    toChatCompletionsEndpoint,
} from '../tools/llm_providers/openai-compatible.js'
import { resolveProviderResponseSchema } from '../tools/llm_providers/response_schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function runNode(script, args = [], env = {}) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    })
}

function getOutput(result) {
    return `${result.stdout}${result.stderr}`
}

function withTempProject(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tad-template-'))
    try {
        return fn(dir)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

function assertGeneratedRlsIsStructurallyValid(sql) {
    const createTable = sql.match(/CREATE TABLE IF NOT EXISTS public\.items \([\s\S]*?\n\);/)
    assert.ok(createTable, 'generated SQL should include a complete CREATE TABLE block')
    assert.doesNotMatch(createTable[0], /updated_at TIMESTAMPTZ DEFAULT now\(\),/)
    assert.match(sql, /FOR UPDATE USING \([\s\S]*?\)\s+WITH CHECK\s+\(/)
    assert.doesNotMatch(sql, /USING\s*\(\s*true\s*\)/i)
    assert.doesNotMatch(sql, /WITH CHECK\s*\(\s*true\s*\)/i)
}

test('discipline:rls-generate emits structurally valid SQL with guarded update policies', () => {
    const result = runNode('tools/generate_rls.js', ['--table', 'items', '--collab', 'COLLABORATIVE'])

    assert.equal(result.status, 0, getOutput(result))
    assertGeneratedRlsIsStructurallyValid(result.stdout)
})

test('migration lint accepts ownership helpers defined in earlier migration files only within the same directory', () => {
    withTempProject((dir) => {
        const migrations = path.join(dir, 'supabase', 'migrations')
        fs.mkdirSync(migrations, { recursive: true })
        fs.writeFileSync(path.join(migrations, '0001_helpers.sql'), `
CREATE TABLE IF NOT EXISTS public.trips (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL
);
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_trip_member(trip_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER -- Discipline Loop:ALLOW_SECURITY_DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.trips
        WHERE trips.id = trip_id
        AND trips.owner_id = auth.uid()
    );
$$;

CREATE POLICY "trip owners can read"
ON public.trips
FOR SELECT
USING (owner_id = auth.uid());
`, 'utf8')
        fs.writeFileSync(path.join(migrations, '0002_activities.sql'), `
CREATE TABLE IF NOT EXISTS public.activities (
    id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES public.trips(id)
);
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can read activities"
ON public.activities
FOR SELECT
USING (public.is_trip_member(trip_id));
`, 'utf8')

        const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'migration_lint.js')], {
            cwd: dir,
            encoding: 'utf8',
        })

        assert.equal(result.status, 0, getOutput(result))
    })
})

test('migration lint still rejects permissive RLS after cross-file helper collection', () => {
    withTempProject((dir) => {
        const migrations = path.join(dir, 'supabase', 'migrations')
        fs.mkdirSync(migrations, { recursive: true })
        fs.writeFileSync(path.join(migrations, '0001_insecure.sql'), `
CREATE TABLE IF NOT EXISTS public.items (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL
);
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bad public read"
ON public.items
FOR SELECT
USING (true);
`, 'utf8')

        const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'migration_lint.js')], {
            cwd: dir,
            encoding: 'utf8',
        })

        assert.equal(result.status, 1, getOutput(result))
        assert.match(getOutput(result), /evaluates to true/)
    })
})

function createMemoryStorage() {
    const store = new Map()

    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null
        },
        setItem(key, value) {
            store.set(key, String(value))
        },
        removeItem(key) {
            store.delete(key)
        },
        clear() {
            store.clear()
        },
    }
}

function createFirestoreMock() {
    const docs = new Map()

    const firestore = {
        collection(_db, name) {
            return { name }
        },
        doc(_db, collectionName, id) {
            return { id, path: `${collectionName}/${id}` }
        },
        async getDoc(ref) {
            return {
                id: ref.id,
                exists: () => docs.has(ref.path),
                data: () => docs.get(ref.path),
            }
        },
        async setDoc(ref, data, options = {}) {
            docs.set(ref.path, options.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : data)
        },
        async updateDoc(ref, data) {
            docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data })
        },
        where(field, op, value) {
            return { type: 'where', field, op, value }
        },
        orderBy(field, direction = 'asc') {
            return { type: 'orderBy', field, direction }
        },
        limit(count) {
            return { type: 'limit', count }
        },
        query(source, ...constraints) {
            return { source, constraints }
        },
        async getDocs(q) {
            let rows = [...docs.entries()]
                .filter(([key]) => key.startsWith(`${q.source.name}/`))
                .map(([key, value]) => ({ id: key.split('/')[1], data: () => value }))

            for (const constraint of q.constraints) {
                if (constraint.type === 'where') {
                    rows = rows.filter((row) => row.data()[constraint.field] === constraint.value)
                }
                if (constraint.type === 'orderBy') {
                    rows = rows.sort((a, b) => String(b.data()[constraint.field]).localeCompare(String(a.data()[constraint.field])))
                }
                if (constraint.type === 'limit') {
                    rows = rows.slice(0, constraint.count)
                }
            }

            return { docs: rows }
        },
    }

    return { docs, firestore }
}

test('backend smoke test explains the missing SUPABASE SDK', () => {
    const result = runNode('tools/backend_smoke_test.js', [], {
        VITE_BACKEND_PROVIDER: 'SUPABASE',
    })

    assert.notEqual(result.status, 0)
    assert.match(getOutput(result), /SUPABASE backend smoke test/)
    assert.match(getOutput(result), /npm install @supabase\/supabase-js/)
})

test('LLM provider loader reports the missing SDK with an install command', async () => {
    await assert.rejects(() => getProvider('openai'), /npm install -D openai/)
})

test('LLM provider registry includes external and open-weight routes without extra SDKs', () => {
    for (const provider of ['grok', 'mistral', 'deepseek', 'qwen', 'minimax', 'ollama', 'llama', 'gemma', 'openai-compatible']) {
        assert.ok(SUPPORTED_LLM_PROVIDERS.includes(provider))
        assert.equal(typeof getProviderConfig(provider).loader, 'function')
    }
})

test('LLM provider payloads use strict structured outputs when a schema is supplied', () => {
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
    }

    const openai = buildOpenAiJsonRequest({ model: 'model', system: 'system', input: { ping: true }, responseSchema: schema })
    assert.equal(openai.response_format.type, 'json_schema')
    assert.equal(openai.response_format.json_schema.strict, true)
    assert.deepEqual(openai.response_format.json_schema.schema, schema)

    const anthropic = buildAnthropicJsonRequest({ model: 'model', system: 'system', input: { ping: true }, responseSchema: schema, maxTokens: 256 })
    assert.equal(anthropic.tool_choice.name, ANTHROPIC_JSON_TOOL_NAME)
    assert.deepEqual(anthropic.tools[0].input_schema, schema)

    const gemini = buildGeminiJsonRequest({ system: 'system', input: { ping: true }, responseSchema: schema })
    assert.equal(gemini.config.responseMimeType, 'application/json')
    assert.deepEqual(gemini.config.responseSchema, schema)
})

test('resolveProviderResponseSchema prefers provider-specific, then aistudio, then canonical', () => {
    withTempProject((dir) => {
        const feature = 'demo'
        const promptsDir = path.join(dir, 'prompts')
        const featureDir = path.join(promptsDir, feature)
        fs.mkdirSync(featureDir, { recursive: true })

        const canonicalSchema = { $schema: 'x', type: 'object', additionalProperties: false }
        const aistudioSchema = { type: 'object', properties: { ok: { type: 'boolean' } } }
        const geminiSchema = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' } } }

        // Only canonical available -> fallback with source 'canonical'.
        const fallback = resolveProviderResponseSchema({ feature, provider: 'gemini', canonicalSchema, promptsDir })
        assert.equal(fallback.source, 'canonical')
        assert.equal(fallback.path, null)
        assert.deepEqual(fallback.schema, canonicalSchema)

        // aistudio present -> generic minimal wins over canonical.
        fs.writeFileSync(path.join(featureDir, 'schema.aistudio.json'), JSON.stringify(aistudioSchema), 'utf8')
        const generic = resolveProviderResponseSchema({ feature, provider: 'gemini', canonicalSchema, promptsDir })
        assert.equal(generic.source, 'aistudio-generic')
        assert.deepEqual(generic.schema, aistudioSchema)

        // provider-specific present -> wins over aistudio, provider name is case-insensitive.
        fs.writeFileSync(path.join(featureDir, 'schema.gemini.json'), JSON.stringify(geminiSchema), 'utf8')
        const specific = resolveProviderResponseSchema({ feature, provider: 'GEMINI', canonicalSchema, promptsDir })
        assert.equal(specific.source, 'provider-specific')
        assert.deepEqual(specific.schema, geminiSchema)

        // A different provider with no specific file falls back to the generic aistudio schema.
        const other = resolveProviderResponseSchema({ feature, provider: 'openai', canonicalSchema, promptsDir })
        assert.equal(other.source, 'aistudio-generic')
        assert.deepEqual(other.schema, aistudioSchema)
    })
})

test('the ok/data/error envelope template enforces its invariants (a loose envelope propagates to every new project)', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'prompts', '_templates', 'schema.json'), 'utf8'))
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schema)

    const err = (over = {}) => ({ code: 'NONE', message: 'ok', missing_fields: [], retryable: false, ...over })
    const payload = (over = {}) => ({ schema_version: 'v1', request_id: 'r', ok: true, data: {}, error: err(), ...over })

    // Accepted.
    assert.equal(validate(payload()), true, 'the llm_smoke_test success payload must validate')
    assert.equal(validate(payload({ schema_version: 'v2' })), true, 'schema_version stays a pattern: a project may ship v2')
    assert.equal(validate(payload({ ok: false, data: null, error: err({ code: 'MISSING_FIELDS', message: 'm', missing_fields: ['x'], retryable: false }) })), true)
    assert.equal(validate(payload({ ok: false, data: null, error: err({ code: 'PROVIDER_ERROR', message: 'm', retryable: true }) })), true, 'transient errors are retryable')

    // Rejected: the laxities that used to let broken envelopes through.
    assert.equal(validate(payload({ data: null })), false, 'ok:true must carry data')
    assert.equal(validate(payload({ ok: false, data: {}, error: err({ code: 'INVALID_INPUT', message: 'm' }) })), false, 'ok:false must null out data')
    assert.equal(validate(payload({ ok: false, data: null })), false, 'ok:false must not report code NONE')
    assert.equal(validate(payload({ error: err({ message: 'todo salió bien' }) })), false, 'on success the message is exactly "ok"')
    assert.equal(validate(payload({ error: err({ retryable: true }) })), false, 'success is never retryable')
    assert.equal(validate(payload({ error: err({ missing_fields: ['x'] }) })), false, 'missing_fields is scoped to MISSING_FIELDS')
    assert.equal(validate(payload({ ok: false, data: null, error: err({ code: 'MISSING_FIELDS', message: 'm', missing_fields: ['x'], retryable: true }) })), false, 'MISSING_FIELDS is not retryable: a retry cannot supply the field')
    assert.equal(validate(payload({ ok: false, data: null, error: err({ code: 'AMBIGUOUS', message: 'm', retryable: true }) })), false, 'AMBIGUOUS is not retryable: a retry cannot disambiguate')
    assert.equal(validate(payload({ ok: false, data: null, error: err({ code: 'MISSING_FIELDS', message: 'm', missing_fields: [], retryable: false }) })), false, 'MISSING_FIELDS must name the missing fields')
})

test('OpenAI provider payload keeps json_object only as the no-schema compatibility fallback', () => {
    const request = buildOpenAiJsonRequest({ model: 'model', system: 'system', input: { ping: true } })

    assert.deepEqual(request.response_format, { type: 'json_object' })
})

test('OpenAI-compatible providers select their structured-output contract explicitly', () => {
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
    }

    const strict = buildOpenAiCompatibleJsonRequest({
        model: 'model', system: 'system', input: { ping: true }, responseSchema: schema,
        structuredOutput: 'json_schema', strictSchema: true,
    })
    assert.equal(strict.response_format.type, 'json_schema')
    assert.equal(strict.response_format.json_schema.strict, true)
    assert.deepEqual(strict.response_format.json_schema.schema, schema)

    const jsonObject = buildOpenAiCompatibleJsonRequest({
        model: 'model', system: 'system', input: { ping: true }, structuredOutput: 'json_object',
    })
    assert.deepEqual(jsonObject.response_format, { type: 'json_object' })
    assert.match(jsonObject.messages[0].content, /Return JSON only/)

    const promptOnly = buildOpenAiCompatibleJsonRequest({
        model: 'model', system: 'system', input: { ping: true }, structuredOutput: 'prompt',
    })
    assert.equal('response_format' in promptOnly, false)
    assert.equal(toChatCompletionsEndpoint('https://example.test/v1/'), 'https://example.test/v1/chat/completions')
})

test('ai eval skips cleanly when no feature is configured and AI is disabled', () => {
    const result = runNode('tools/llm_eval.js', ['--mode=fixture'])

    assert.equal(result.status, 0)
    assert.match(getOutput(result), /No AI evals configured yet/)
    assert.match(getOutput(result), /\[SKIP\]/)
})

test('ai eval accepts a draft 2020-12 schema in fixture mode', () => {
    withTempProject((dir) => {
        const feature = 'draft2020'
        fs.mkdirSync(path.join(dir, 'prompts', feature), { recursive: true })
        fs.mkdirSync(path.join(dir, 'evals'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'prompts', feature, 'system.md'), 'Return JSON only.\n', 'utf8')
        fs.writeFileSync(path.join(dir, 'prompts', feature, 'schema.json'), JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
        }), 'utf8')
        fs.writeFileSync(path.join(dir, 'evals', `${feature}.jsonl`), `${JSON.stringify({
            id: 'valid-draft2020-output',
            input: { source: 'fixture' },
            expected: { ok: true },
            actual: { ok: true },
        })}\n`, 'utf8')

        const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'llm_eval.js'), '--mode=fixture'], {
            cwd: dir,
            env: process.env,
            encoding: 'utf8',
        })

        assert.equal(result.status, 0, getOutput(result))
        assert.match(getOutput(result), /\[PASS\] valid-draft2020-output/)
    })
})

test('App.tsx exports a valid app root and no longer ships the Vite counter demo', () => {
    const appSource = fs.readFileSync(path.join(repoRoot, 'src', 'App.tsx'), 'utf8')

    assert.doesNotMatch(appSource, /count is/)
    // Stable invariant: App.tsx still exports a root component, without pinning a
    // specific shell. Replacing the default shell (per the in-file note) must not
    // break the gate. See FINDING-01 (Evidence Track, Case 1).
    assert.match(appSource, /export default App/)
})

test('runtime config falls back to Discipline Loop defaults and normalizes valid overrides', () => {
    assert.deepEqual(resolveRuntimeConfig({}), DEFAULT_RUNTIME_CONFIG)
    assert.deepEqual(resolveRuntimeConfig({
        VITE_BACKEND_PROVIDER: 'local_only',
        VITE_AUTH_MODE: 'none',
    }), {
        BACKEND_PROVIDER: 'LOCAL_ONLY',
        AUTH_MODE: 'NONE',
    })
    assert.deepEqual(resolveRuntimeConfig({
        VITE_BACKEND_PROVIDER: 'broken',
        VITE_AUTH_MODE: 'also-broken',
    }), DEFAULT_RUNTIME_CONFIG)
})

test('LOCAL_ONLY backend keeps a stable personal space and owner membership', async () => {
    const backend = createLocalBackend({
        storage: createMemoryStorage(),
        randomUUID: (() => {
            let next = 1
            return () => `id-${next++}`
        })(),
        now: () => '2026-03-10T00:00:00.000Z',
    })

    const first = await backend.core.ensurePersonalSpace()
    const second = await backend.core.ensurePersonalSpace()
    const user = await backend.auth.getUser()

    assert.equal(first.space.id, second.space.id)
    assert.equal(first.membership.space_id, first.space.id)
    assert.equal(first.membership.role, 'owner')
    assert.equal(first.space.created_by, user.id)
})

test('LOCAL_ONLY backend isolates notifications by space and marks only the target as read', async () => {
    const storage = createMemoryStorage()
    storage.setItem(LOCAL_STORAGE_KEYS.notifications, JSON.stringify([
        {
            id: 'n-1',
            space_id: 'space-a',
            user_id: 'user-1',
            type: 'invite',
            payload_json: {},
            read_at: null,
            created_at: '2026-03-10T00:00:00.000Z',
            updated_at: '2026-03-10T00:00:00.000Z',
        },
        {
            id: 'n-2',
            space_id: 'space-b',
            user_id: 'user-1',
            type: 'digest',
            payload_json: {},
            read_at: null,
            created_at: '2026-03-10T00:00:00.000Z',
            updated_at: '2026-03-10T00:00:00.000Z',
        },
    ]))

    const backend = createLocalBackend({
        storage,
        randomUUID: () => 'unused',
        now: () => '2026-03-10T01:00:00.000Z',
    })

    const visible = await backend.core.listNotifications('space-a')
    assert.equal(visible.length, 1)
    assert.equal(visible[0].id, 'n-1')

    await backend.core.markNotificationRead('n-1')
    const stored = JSON.parse(storage.getItem(LOCAL_STORAGE_KEYS.notifications))

    assert.equal(stored[0].read_at, '2026-03-10T01:00:00.000Z')
    assert.equal(stored[1].read_at, null)
})

test('the template shell carries loading, empty, error and normal states', () => {
    const states = TEMPLATE_STATE_CARDS.map((item) => item.state).sort()

    assert.deepEqual(states, ['empty', 'error', 'loading', 'normal'])
})

test('the app shell renders meaningful SSR markup with Discipline Loop states and defaults', () => {
    const markup = renderToStaticMarkup(
        h(AppShellView, {
            backendProvider: 'LOCAL_ONLY',
            authMode: 'NONE',
            profile: 'SHARED_SYNC',
        })
    )

    assert.match(markup, /Discipline Loop Factory Template/)
    assert.match(markup, /Current template defaults/)
    assert.match(markup, /LOCAL_ONLY/)
    assert.match(markup, /data-state="loading"/)
    assert.match(markup, /data-state="empty"/)
    assert.match(markup, /data-state="error"/)
    assert.match(markup, /data-state="normal"/)
})

test('FIREBASE backend maps the current user and persists pending email on magic link', async () => {
    const calls = []
    const pendingEmails = []
    const authClient = {
        currentUser: {
            uid: 'user-42',
            email: 'owner@example.com',
        },
    }

    const backend = createFirebaseBackend({
        authClient,
        db: {},
        firestore: createFirestoreMock().firestore,
        sendSignInLinkToEmail: async (_authClient, email, settings) => {
            calls.push({ email, settings })
        },
        isSignInWithEmailLink: () => false,
        signInWithEmailLink: async () => undefined,
        signOut: async () => undefined,
        getOrigin: () => 'https://factory.example.test',
        getCurrentUrl: () => null,
        persistPendingEmail: (email) => pendingEmails.push(email),
        getPendingEmail: () => pendingEmails.at(-1) ?? null,
        clearPendingEmail: () => { pendingEmails.length = 0 },
    })

    const user = await backend.auth.getUser()
    await backend.auth.signInMagicLink('invite@example.com')

    assert.deepEqual(user, {
        id: 'user-42',
        email: 'owner@example.com',
    })
    assert.deepEqual(calls, [{
        email: 'invite@example.com',
        settings: {
            url: 'https://factory.example.test',
            handleCodeInApp: true,
        },
    }])
    assert.deepEqual(pendingEmails, ['invite@example.com'])
})

test('FIREBASE backend getUser ignores already-consumed email links without pending email', async () => {
    const backend = createFirebaseBackend({
        authClient: { currentUser: { uid: 'user-42', email: 'owner@example.com' } },
        db: {},
        firestore: createFirestoreMock().firestore,
        sendSignInLinkToEmail: async () => undefined,
        isSignInWithEmailLink: () => true,
        signInWithEmailLink: async () => { throw new Error('should not consume without pending email') },
        signOut: async () => undefined,
        getOrigin: () => 'https://factory.example.test',
        getCurrentUrl: () => 'https://factory.example.test/?mode=signIn&oobCode=used',
        persistPendingEmail: () => undefined,
        getPendingEmail: () => null,
        clearPendingEmail: () => undefined,
    })

    const user = await backend.auth.getUser()

    assert.deepEqual(user, {
        id: 'user-42',
        email: 'owner@example.com',
    })
})

test('FIREBASE backend stores a personal space and notification reads in Firestore', async () => {
    const { docs, firestore } = createFirestoreMock()
    const backend = createFirebaseBackend({
        authClient: { currentUser: { uid: 'user-42', email: 'owner@example.com' } },
        db: {},
        firestore,
        isSignInWithEmailLink: () => false,
        signInWithEmailLink: async () => undefined,
        sendSignInLinkToEmail: async () => undefined,
        signOut: async () => undefined,
        getOrigin: () => 'https://factory.example.test',
        getCurrentUrl: () => null,
        persistPendingEmail: () => undefined,
        getPendingEmail: () => null,
        clearPendingEmail: () => undefined,
    })

    const { space, membership } = await backend.core.ensurePersonalSpace()
    docs.set('notifications/n-1', {
        space_id: space.id,
        user_id: 'user-42',
        type: 'digest',
        payload_json: {},
        read_at: null,
        created_at: '2026-03-10T00:00:00.000Z',
        updated_at: '2026-03-10T00:00:00.000Z',
    })

    const notifications = await backend.core.listNotifications(space.id)
    await backend.core.markNotificationRead('n-1')

    assert.equal(membership.role, 'owner')
    assert.equal(notifications.length, 1)
    assert.equal(docs.get('notifications/n-1').read_at !== null, true)
})
