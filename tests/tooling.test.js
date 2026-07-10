import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
import { getProvider } from '../tools/llm_providers/index.js'
import {
    ANTHROPIC_JSON_TOOL_NAME,
    buildAnthropicJsonRequest,
    buildGeminiJsonRequest,
    buildOpenAiJsonRequest,
} from '../tools/llm_providers/payloads.js'

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

test('OpenAI provider payload keeps json_object only as the no-schema compatibility fallback', () => {
    const request = buildOpenAiJsonRequest({ model: 'model', system: 'system', input: { ping: true } })

    assert.deepEqual(request.response_format, { type: 'json_object' })
})

test('ai eval skips cleanly when no feature is configured and AI is disabled', () => {
    const result = runNode('tools/llm_eval.js', ['--mode=fixture'])

    assert.equal(result.status, 0)
    assert.match(getOutput(result), /No AI evals configured yet/)
    assert.match(getOutput(result), /\[SKIP\]/)
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
