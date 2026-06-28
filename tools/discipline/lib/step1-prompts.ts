/**
 * Step 1 — All 13 prompts from vault note 20.
 * Each prompt is a function that receives the project config and returns the interpolated text.
 * Used by discipline:step1-prep and the /discipline-step1 skill (Claude Code, Sonnet by default).
 */
import type { DisciplineConfig } from './types.js';

// ─── System prompt ──────

export function systemPrompt(c: DisciplineConfig): string {
  const stacks: Record<string, string> = {
    WEB: 'React + Vite + TypeScript + Tailwind (PWA). No sugieras tecnologías móviles nativas.',
    MOBILE: 'Expo + React Native + TypeScript. Diseña para iOS/Android. No menciones Vite ni PWA.',
    DESKTOP: 'Tauri + React + Vite + TypeScript. Diseña para ventana de escritorio Mac/Win/Linux.',
    EXTENSION: 'WXT + React + TypeScript. Manifest V3, cross-browser Chromium + Firefox. Popup (360x480) + options page + background service worker + content script opcional. Patrón canónico: extensión free + sidecar web app para Pro tier.',
    BACKEND: 'Hono (TypeScript) o FastAPI (Python). Sin UI. Solo endpoints, schemas y contratos de API.',
    WEB_SSR: 'Next.js + TypeScript (App Router). SSR con backend integrado.',
    CLI: 'Node.js o Python CLI. Sin UI gráfica. Diseña para terminal y argumentos de línea de comandos.',
  };
  return `Usa mis notas para transformar esta idea en una especificación ejecutable para construir una app con el menor costo posible, lo más rápido posible, con el menor debugging posible.

Quiero que pienses como Product Manager + Systems Designer.

Reglas:
- No inventes features que no estén justificadas.
- Si algo no está claro, asume lo mínimo y márcalo como supuesto.
- Prioriza MVP brutalmente pequeño.
- Si la app parece multi-dispositivo o compartida, usa spaces/memberships/roles.
- Si la app parece solo personal/local, indícalo explícitamente.
- Si una feature parece "bonita pero no esencial", márcala fuera de alcance del MVP.
- El stack tecnológico es inamovible según el LANE que ya elegiste. No cambies el stack:
  - LANE=${c.lane}: ${stacks[c.lane] || stacks.WEB}

Quiero outputs concretos, no teoría.`;
}

// ─── Output metadata ────────────────────────────────────

export interface OutputMeta {
  /** 1-based output number */
  number: number;
  /** Output title (used in prompts file and packet naming) */
  noteTitle: string;
  /** Packet filename if this goes to .discipline/packets/, null if intermediate only */
  packetFile: string | null;
  /** Whether this output is conditional */
  condition: (c: DisciplineConfig) => boolean;
}

export const OUTPUT_META: OutputMeta[] = [
  { number: 1,  noteTitle: '03_PRD',                          packetFile: null, condition: () => true },
  { number: 2,  noteTitle: '04_User_Stories',                 packetFile: null, condition: () => true },
  { number: 3,  noteTitle: '05_Data_Model',                   packetFile: null, condition: () => true },
  { number: 4,  noteTitle: '06_UI_States',                    packetFile: null, condition: () => true },
  { number: 5,  noteTitle: '07_Events_and_Notifications',     packetFile: null, condition: () => true },
  { number: 6,  noteTitle: '08_Architecture_Switches',        packetFile: null, condition: () => true },
  { number: 7,  noteTitle: '09_Export_for_DisciplineLoop',             packetFile: null, condition: () => true },
  { number: 8,  noteTitle: '10_Validation',                   packetFile: null, condition: () => true },
  { number: 9,  noteTitle: '16_STEP_2_ARCHITECTURE_PACKET',   packetFile: 'STEP_2_ARCHITECTURE_PACKET.md', condition: () => true },
  { number: 10, noteTitle: '17_STEP_2_5_AI_PACKET',           packetFile: 'STEP_2_5_AI_PACKET.md', condition: (c) => c.aiFeatures === 'enabled' },
  { number: 11, noteTitle: '18_STEP_3_STITCH_PACKET',         packetFile: 'STEP_3_STITCH_PACKET.md', condition: (c) => !['BACKEND', 'CLI'].includes(c.lane) },
  { number: 12, noteTitle: '19_STEP_4_EXECUTION_PACKET',      packetFile: 'STEP_4_EXECUTION_PACKET.draft.md', condition: () => true },
  { number: 13, noteTitle: '20_REPO_READY_BLOCKS',            packetFile: null, condition: () => true }, // produces 2 files, handled specially
];

// ─── The 13 prompts ─────────────────────────────────────

export function getPrompt(number: number, _c: DisciplineConfig): string {
  const prompts: Record<number, string> = {
    1: `Genera un PRD de 1 página con esta estructura exacta:

1. North Star:
   - ¿Cuál es el resultado único deseado de esta app?
   - Métrica: ¿cómo sabrías que está funcionando? (ej: "X% de usuarios hacen Y en semana 1", "N registros por sesión", "retention a 7 días")

2. Usuario(s) objetivo:
   - Yo
   - Mi grupo compartido
   - Público futuro (si aplica)

3. Problema principal:
   - ¿Qué dolor resuelve?

4. Solución propuesta:
   - ¿Qué hace la app en términos simples?

5. Alcance MVP:
   - Qué sí entra en la primera versión

6. Fuera de alcance:
   - Qué NO entra todavía

7. Requisitos no funcionales:
   - costo
   - velocidad
   - confiabilidad
   - privacidad
   - multi-dispositivo
   - PWA/iPhone/PC

8. Pantallas principales:
   - lista de 3 a 8 pantallas

9. Riesgos y supuestos:
   - máximo 8`,

    2: `Genera 10–15 user stories priorizadas usando P0 / P1 / P2.

Reglas:
- Las P0 deben representar el verdadero MVP.
- Cada story debe poder implementarse en slices pequeños.
- Evita historias demasiado abstractas.
- Prioriza historias verticales (que toquen data + API + UI en un solo slice, no "crear todas las tablas" primero).

Para las P0, agrega criterios Given/When/Then claros y testeables.`,

    3: `Define el modelo de datos mínimo del MVP.

Instrucciones:
- Si la app es multi-dispositivo o compartida, usa:
  - spaces
  - memberships
  - roles
- Si es solo personal/local, dilo explícitamente.
- Para cada entidad, define:
  - nombre
  - propósito
  - campos
  - tipos aproximados
  - relaciones
  - timestamps (created_at, updated_at)
- Regla estricta: si la app es multi-usuario o compartida, TODAS las entidades de negocio deben incluir obligatoriamente el campo space_id.
- Si una entidad NO necesita space_id, justifica explícitamente por qué.
- Si aplica, incluye tabla notifications con: id, space_id, user_id, type, payload_json, read_at, created_at.
- Si aplica sync, usa Last-Write-Wins con updated_at como estrategia MVP.
- Mantén el modelo lo más pequeño posible.`,

    4: `Para cada pantalla principal, define los estados de UI obligatorios:

- loading
- empty
- error

Para cada estado, explica:
- qué ve el usuario
- qué acción puede tomar
- cómo se recupera`,

    5: `Lista los eventos del sistema que deberían generar notificaciones in-app si aplica.

Para cada evento, define:
- nombre del evento
- qué lo dispara
- payload mínimo
- quién lo recibe
- si podría convertirse en push más adelante`,

    6: `Con base en la idea y restricciones, confirma o ajusta los switches de arquitectura para esta app:

- LANE: WEB | MOBILE | DESKTOP | BACKEND | WEB_SSR | CLI (ya elegido al configurar el proyecto. Confirma que es correcto.)
- PROFILE: LITE | SHARED_SYNC | LAUNCH | PROD
- BACKEND_PROVIDER: SUPABASE | FIREBASE | LOCAL_ONLY
- AUTH_MODE: MAGIC_LINK | GOOGLE | GITHUB | EMAIL_PASSWORD | NONE
- COLLAB_MODE: VIEW_ONLY | COLLABORATIVE
- SYNC_MODE: FAST_UI | OFFLINE_FIRST
- AI_FEATURES: none | enabled
- PUSH_PLUGIN: true | false
- HOSTING: Vercel | Cloudflare Pages | Netlify | Railway | otro

Para cada decisión, explica brevemente por qué.

Reglas:
- Para LANE: ya se eligió al configurar el proyecto. Confirma que es correcto para este caso. Si detectas un problema claro, señálalo, pero no cambies el LANE sin justificación fuerte.
- Si la app es personal y no necesita sync real, considera LOCAL_ONLY.
- Si la app es multi-dispositivo o compartida, considera SUPABASE o FIREBASE.
- Si es panel/reportes, favorece VIEW_ONLY.
- Si es lista/tracker compartido, favorece COLLABORATIVE.
- Si no hay necesidad clara de IA, recomienda AI_FEATURES=none.
- Para HOSTING: Vercel para Web/Web SSR, Railway/Fly.io para Backend / Services, EAS para Mobile. Ajustar si hay restricciones.`,

    7: `Ahora convierte todo lo anterior en 2 outputs listos para usar:

Output A:
Un bloque para pegar en discipline.md con:
- PROFILE
- BACKEND_PROVIDER
- AUTH_MODE
- COLLAB_MODE
- SYNC_MODE
- AI_FEATURES
- PUSH_PLUGIN
- HOSTING
- modelo de datos resumido
- reglas clave de acceso
- reglas clave de sync
- reglas clave de notificaciones

Output B:
Un task_plan.md inicial con:
- Slice 0
- Slice 1
- Slice 2
- Slice 3
- Slice 4

Cada slice debe incluir:
- Goal
- Scope IN
- Scope OUT
- Acceptance Criteria
- Riesgos
- Definition of Done

Reglas:
- Los slices deben ser verticales y pequeños.
- Cada slice debe poder hacerse en 0.5 a 2 días.
- Slice 0 DEBE incluir:
  - Instalar SDK del provider elegido (ej: npm install @supabase/supabase-js o npm install firebase)
  - Configurar .env desde el .env.example correspondiente
  - Ejecutar npm run backend:smoke
  - Si AI_FEATURES=enabled: instalar LLM SDK(s) y ejecutar npm run ai:smoke
  - Aplicar migración core si el backend lo requiere`,

    8: `Revisa todos los outputs que generamos y busca inconsistencias.

Verifica:
1. ¿Todas las entidades del modelo de datos están respaldadas por al menos una user story P0 o P1?
2. ¿Todas las pantallas del PRD tienen estados UI definidos (loading/empty/error)?
3. ¿Las user stories P0 cubren el alcance MVP del PRD y no se exceden?
4. ¿El modelo de datos es consistente con el COLLAB_MODE y SYNC_MODE elegidos?
5. ¿Si es SHARED_SYNC, todas las entidades de negocio tienen space_id?
6. ¿Los eventos/notificaciones corresponden a acciones reales del modelo de datos?
7. ¿Hay entidades huérfanas (definidas pero no usadas en ninguna story)?
8. ¿Hay stories que referencian pantallas o datos que no existen en el modelo?
9. ¿El Slice 0 tiene todos los pasos de setup necesarios según el BACKEND_PROVIDER?

Si encuentras problemas, lista cada uno con:
- qué output tiene el problema
- cuál es la inconsistencia
- corrección sugerida`,

    9: `Ahora genera un único bloque llamado STEP_2_ARCHITECTURE_PACKET.

Debe ser autocontenido y listo para pegar en el Paso 2.

Incluye, en este orden:

1. PRODUCT SUMMARY
- North Star
- problema principal
- solución propuesta
- alcance MVP
- fuera de alcance

2. USERS
- usuarios objetivo
- si es de uso propio, compartida, multiusuario o futuro público

3. P0 STORIES
- solo las stories P0 más importantes

4. DATA MODEL SUMMARY
- entidades mínimas
- relaciones clave
- si aplica: spaces, memberships, roles, space_id

5. ARCHITECTURE SWITCHES
- LANE
- PROFILE
- BACKEND_PROVIDER
- AUTH_MODE
- COLLAB_MODE
- SYNC_MODE
- AI_FEATURES
- PUSH_PLUGIN
- HOSTING

6. RISKS / ASSUMPTIONS
- máximo 8

7. MVP BOUNDARY
- qué NO construir todavía

Reglas:
- Debe caber en un solo bloque pegable.
- No expliques teoría.
- No repitas texto innecesario.
- Formato claro para que un modelo de arquitectura lo pueda consumir directamente.`,

    10: `Si AI_FEATURES=enabled, ahora genera un único bloque llamado STEP_2_5_AI_PACKET.

Debe dejar cada feature IA P0 lista para trabajar en AI Studio sin reconstruir contexto.

Para cada feature incluye:

1. FEATURE_NAME
2. USER_VALUE
3. TRIGGER
4. INPUTS
- qué datos entran
- de dónde vienen
- tamaño o forma esperada
5. OUTPUTS
- qué campos debe producir
- si requiere JSON estructurado
6. UX_SURFACE
- en qué pantalla o flujo aparece
7. FALLBACK_BEHAVIOR
- qué pasa si el modelo falla o devuelve output inválido
8. DATA_SENSITIVITY
- si toca datos personales, de personas cercanas o sensibles
9. PROVIDER_PREFERENCE
- gemini | openai | anthropic | por decidir
10. EVAL_HINTS
- 3 a 5 casos que sí o sí habría que evaluar
11. MVP BOUNDARY
- qué parte IA sí entra en MVP y qué se pospone

Reglas:
- No generes este packet si AI_FEATURES=none.
- No inventes features IA nuevas.
- No escribas prompts finales ni schemas todavía.
- Debe quedar en formato fácil de pegar en el Paso 2.5.`,

    11: `Ahora genera un único bloque llamado STEP_3_STITCH_PACKET.

Debe dejar listas las pantallas P0 para Stitch sin que yo tenga que rellenar nada a mano.

Para cada pantalla P0 incluye exactamente:

- SCREEN_NAME
- USER
- GOAL
- MUST_SHOW
- PRIMARY_ACTION
- SECONDARY_ACTIONS
- ROLE_VARIANTS (si aplica)
- REQUIRED_STATES: normal, loading, empty, error

Reglas:
- Solo incluir pantallas P0 del MVP.
- No inventar pantallas nuevas.
- Debe estar en formato fácil de copiar pantalla por pantalla.
- Debe poder pegarse casi directo en Stitch.
- Mobile-first siempre.`,

    12: `Ahora genera un único bloque llamado STEP_4_EXECUTION_PACKET.

Debe ser autocontenido y dejar el Paso 4 casi listo, aunque luego el Paso 2 podrá validarlo y reemplazarlo.

Incluye, en este orden:

1. PRODUCT SUMMARY
- objetivo del producto
- usuario principal
- caso de uso principal

2. MVP BOUNDARY
- qué sí entra
- qué no entra todavía

3. ARCHITECTURE LOCKS
- switches de arquitectura ya elegidos
- restricciones no negociables del sistema

4. DATA / ACCESS / SYNC CONTRACTS
- entidades clave
- relaciones clave
- access rules mínimas
- sync rules mínimas

5. SLICE DRAFT
- Slice 0 a Slice 4
- goal breve
- scope tentativo
- dependencias obvias

6. BOOTSTRAP REQUIREMENTS
- qué necesita existir primero para arrancar la app

7. UI SURFACE SUMMARY
- nombres de pantallas P0

8. AI SURFACE SUMMARY
- features IA P0 si existen

9. RISKS / EDGE CASES
- máximo 8

10. IMPLEMENTATION GUARDRAILS
- qué no debe reinventarse después
- qué no debe crecer antes de tiempo

Reglas:
- No escribas código.
- No expliques teoría.
- No repitas el PRD entero.
- Debe ser consumible por un modelo que expandirá slices.`,

    13: `Ahora genera dos bloques finales con estos nombres exactos:

1. DISCIPLINE_MD_READY_BLOCK
2. TASK_PLAN_READY_BLOCK

Reglas:
- Deben quedar listos para pegar en el repo template.
- No expliques nada fuera de los bloques.
- DISCIPLINE_MD_READY_BLOCK debe incluir switches, data model resumido, access rules, sync rules y notification rules.
- TASK_PLAN_READY_BLOCK debe incluir Slice 0 a Slice 4.`,
  };

  return prompts[number] || '';
}
