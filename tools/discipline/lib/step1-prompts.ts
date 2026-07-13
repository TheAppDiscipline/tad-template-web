/**
 * Step 1 - All 13 prompts from the public Discipline Loop scaffold.
 * Each prompt is a function that receives the project config and returns the interpolated text.
 * Used by discipline:step1-prep and the /discipline-step1 skill (Claude Code, Sonnet by default).
 */
import type { DisciplineConfig } from './types.js';

// System prompt

export function systemPrompt(c: DisciplineConfig): string {
  const stacks: Record<string, string> = {
    WEB: 'React + Vite + TypeScript + semantic design tokens (PWA). Do not suggest native mobile technologies.',
    MOBILE: 'Expo + React Native + TypeScript. Design for iOS/Android. Do not mention Vite or PWA.',
    DESKTOP: 'Tauri + React + Vite + TypeScript. Design for a Mac/Windows/Linux desktop window.',
    EXTENSION: 'WXT + React + TypeScript. Manifest V3, cross-browser Chromium + Firefox. Popup (360x480) + options page + background service worker + optional content script. Canonical pattern: free extension + sidecar web app for Pro tier.',
    BACKEND: 'Hono (TypeScript) or FastAPI (Python). No UI. Only endpoints, schemas, and API contracts.',
    WEB_SSR: 'Next.js + TypeScript (App Router). SSR with integrated backend.',
    CLI: 'Node.js or Python CLI. No graphical UI. Design for terminal usage and command-line arguments.',
  };
  return `Use my notes to transform this idea into an executable specification for building an app with the lowest reasonable cost, the fastest path, and the least debugging.

Think like a Product Manager + Systems Designer.

Rules:
- Do not invent features that are not justified.
- If something is unclear, assume the minimum and mark it as an assumption.
- Prioritize a brutally small MVP.
- If the app seems multi-device or shared, use spaces/memberships/roles.
- If the app seems personal/local only, say that explicitly.
- If a feature seems nice but non-essential, mark it out of scope for the MVP.
- The technology stack is locked by the LANE already chosen. Do not change the stack:
  - LANE=${c.lane}: ${stacks[c.lane] || stacks.WEB}

I want concrete outputs, not theory.`;
}

// Output metadata

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
  { number: 7,  noteTitle: '09_Export_for_DisciplineLoop',    packetFile: null, condition: () => true },
  { number: 8,  noteTitle: '10_Validation',                   packetFile: null, condition: () => true },
  { number: 9,  noteTitle: '16_STEP_2_ARCHITECTURE_PACKET',   packetFile: 'STEP_2_ARCHITECTURE_PACKET.md', condition: () => true },
  { number: 10, noteTitle: '17_STEP_2_5_AI_PACKET',           packetFile: 'STEP_2_5_AI_PACKET.md', condition: (c) => c.aiFeatures === 'enabled' },
  { number: 11, noteTitle: '18_STEP_3_STITCH_PACKET',         packetFile: 'STEP_3_STITCH_PACKET.md', condition: (c) => !['BACKEND', 'CLI'].includes(c.lane) },
  { number: 12, noteTitle: '19_STEP_4_EXECUTION_PACKET',      packetFile: 'STEP_4_EXECUTION_PACKET.draft.md', condition: () => true },
  { number: 13, noteTitle: '20_REPO_READY_BLOCKS',            packetFile: null, condition: () => true }, // produces 2 files, handled specially
];

// The 13 prompts

export function getPrompt(number: number, _c: DisciplineConfig): string {
  const prompts: Record<number, string> = {
    1: `Generate a one-page PRD with this exact structure:

1. North Star:
   - What is the single desired outcome of this app?
   - Metric: how would you know it is working? (examples: "X% of users do Y in week 1", "N records per session", "7-day retention")

2. Target user(s):
   - Me
   - My shared group
   - Future public audience (if applicable)

3. Main problem:
   - What pain does it solve?

4. Proposed solution:
   - What does the app do in simple terms?

5. MVP scope:
   - What is included in the first version

6. Out of scope:
   - What is NOT included yet

7. Non-functional requirements:
   - cost
   - speed
   - reliability
   - privacy
   - multi-device
   - PWA/iPhone/PC

8. Main screens:
   - list of 3 to 8 screens

9. Risks and assumptions:
   - maximum 8`,

    2: `Generate 10-15 prioritized user stories using P0 / P1 / P2.

Rules:
- P0 stories must represent the true MVP.
- Each story must be implementable in small slices.
- Avoid stories that are too abstract.
- Prioritize vertical stories (touching data + API + UI in one slice, not "create all tables" first).

For P0 stories, add clear, testable Given/When/Then criteria.`,

    3: `Define the minimum MVP data model.

Instructions:
- If the app is multi-device or shared, use:
  - spaces
  - memberships
  - roles
- If it is personal/local only, say that explicitly.
- For each entity, define:
  - name
  - purpose
  - fields
  - approximate types
  - relationships
  - timestamps (created_at, updated_at)
- Strict rule: if the app is multi-user or shared, ALL business entities must include the space_id field.
- If an entity does NOT need space_id, explicitly justify why.
- If applicable, include a notifications table with: id, space_id, user_id, type, payload_json, read_at, created_at.
- If sync applies, use Last-Write-Wins with updated_at as the MVP strategy.
- Keep the model as small as possible.`,

    4: `For each main screen, define the required UI states:

- loading
- empty
- error

For each state, explain:
- what the user sees
- what action they can take
- how recovery works`,

    5: `List the system events that should generate in-app notifications, if applicable.

For each event, define:
- event name
- what triggers it
- minimum payload
- who receives it
- whether it could become push later`,

    6: `Based on the idea and constraints, confirm or adjust the architecture switches for this app:

- LANE: WEB | MOBILE | DESKTOP | BACKEND | WEB_SSR | CLI (already chosen during project setup. Confirm that it is correct.)
- PROFILE: LITE | SHARED_SYNC | LAUNCH | PROD
- BACKEND_PROVIDER: SUPABASE | FIREBASE | LOCAL_ONLY
- AUTH_MODE: MAGIC_LINK | GOOGLE | GITHUB | EMAIL_PASSWORD | NONE
- COLLAB_MODE: VIEW_ONLY | COLLABORATIVE
- SYNC_MODE: FAST_UI | OFFLINE_FIRST
- AI_FEATURES: none | enabled
- PUSH_PLUGIN: true | false
- HOSTING: Vercel | Cloudflare Pages | Netlify | Railway | other

For each decision, briefly explain why.

Rules:
- For LANE: it was already chosen during project setup. Confirm that it is correct for this case. If you detect a clear problem, call it out, but do not change the LANE without strong justification.
- If the app is personal and does not need real sync, consider LOCAL_ONLY.
- If the app is multi-device or shared, consider SUPABASE or FIREBASE.
- If it is a dashboard/reporting surface, favor VIEW_ONLY.
- If it is a shared list/tracker, favor COLLABORATIVE.
- If there is no clear need for AI, recommend AI_FEATURES=none.
- For HOSTING: Vercel for Web/Web SSR, Railway/Fly.io for Backend / Services, EAS for Mobile. Adjust if constraints require it.`,

    7: `Now convert everything above into 2 ready-to-use outputs:

Output A:
A block to paste into discipline.md with:
- PROFILE
- BACKEND_PROVIDER
- AUTH_MODE
- COLLAB_MODE
- SYNC_MODE
- AI_FEATURES
- PUSH_PLUGIN
- HOSTING
- summarized data model
- key access rules
- key sync rules
- key notification rules

Output B:
An initial task_plan.md with:
- Slice 0
- Slice 1
- Slice 2
- Slice 3
- Slice 4

Each slice must include:
- Goal
- Scope IN
- Scope OUT
- Acceptance Criteria
- Risks
- Definition of Done

Rules:
- Slices must be vertical and small.
- Each slice should fit in 0.5 to 2 days.
- Slice 0 MUST include:
  - Install the chosen provider SDK (examples: npm install @supabase/supabase-js or npm install firebase)
  - Configure .env from the matching .env.example
  - Run npm run backend:smoke
  - If AI_FEATURES=enabled: declare the P0 AI feature name(s), create the minimum prompt/schema/eval fixture files needed for npm run ai:eval to pass, and run npm run ai:eval in fixture mode.
  - If AI_FEATURES=enabled but Step 2.5 has not chosen the live provider yet: do NOT install a paid/live LLM SDK in Slice 0 unless the provider is already decided. Keep the fixture eval green first.
  - Apply the core migration if the backend requires it`,

    8: `Review all outputs we generated and look for inconsistencies.

Verify:
1. Are all data model entities backed by at least one P0 or P1 user story?
2. Do all PRD screens have UI states defined (loading/empty/error)?
3. Do the P0 user stories cover the MVP scope without exceeding it?
4. Is the data model consistent with the chosen COLLAB_MODE and SYNC_MODE?
5. If it is SHARED_SYNC, do all business entities have space_id?
6. Do events/notifications correspond to real actions in the data model?
7. Are there orphan entities (defined but unused by any story)?
8. Are there stories that reference screens or data that do not exist in the model?
9. Does Slice 0 include all setup steps required by BACKEND_PROVIDER?

If you find problems, list each one with:
- which output has the problem
- what the inconsistency is
- suggested correction`,

    9: `Now generate one block called STEP_2_ARCHITECTURE_PACKET.

It must be self-contained and ready to paste into Step 2.

Include, in this order:

1. PRODUCT SUMMARY
- North Star
- main problem
- proposed solution
- MVP scope
- out of scope

2. USERS
- target users
- whether it is personal, shared, multi-user, or future public use

3. P0 STORIES
- only the most important P0 stories

4. DATA MODEL SUMMARY
- minimum entities
- key relationships
- if applicable: spaces, memberships, roles, space_id

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
- maximum 8

7. MVP BOUNDARY
- what NOT to build yet

Rules:
- It must fit in one pasteable block.
- Do not explain theory.
- Do not repeat unnecessary text.
- Use a clear format that an architecture model can consume directly.`,

    10: `If AI_FEATURES=enabled, now generate one block called STEP_2_5_AI_PACKET.

It must make each P0 AI feature ready to work on in AI Studio without rebuilding context.

For each feature include:

1. FEATURE_NAME
2. USER_VALUE
3. TRIGGER
4. INPUTS
- what data goes in
- where it comes from
- expected size or shape
5. OUTPUTS
- what fields it must produce
- whether it requires structured JSON
6. UX_SURFACE
- which screen or flow it appears in
7. FALLBACK_BEHAVIOR
- what happens if the model fails or returns invalid output
8. DATA_SENSITIVITY
- whether it touches personal data, close-person data, or sensitive data
9. PROVIDER_PREFERENCE
- gemini | openai | anthropic | grok | mistral | deepseek | qwen | minimax | ollama | llama | gemma | openai-compatible | undecided
10. EVAL_HINTS
- 3 to 5 cases that must be evaluated
11. MVP BOUNDARY
- which AI part is in the MVP and what is postponed

Rules:
- Do not generate this packet if AI_FEATURES=none.
- Do not invent new AI features.
- Do not write final prompts or schemas yet.
- Make it clear which prompt/schema/eval files Step 2.5 must create so Slice 0 can keep npm run ai:eval green in fixture mode before any live provider is wired.
- PROVIDER_PREFERENCE may stay undecided here. Do not force a paid/live SDK choice before Step 2.5 has enough evidence.
- It must be easy to paste into Step 2.5.`,

    11: `Now generate one block called STEP_3_STITCH_PACKET.

It must make the P0 screens ready for Stitch without requiring manual filling.

For each P0 screen include exactly:

- SCREEN_NAME
- USER
- GOAL
- MUST_SHOW
- PRIMARY_ACTION
- SECONDARY_ACTIONS
- ROLE_VARIANTS (if applicable)
- REQUIRED_STATES: normal, loading, empty, error

Rules:
- Include only P0 screens from the MVP.
- Do not invent new screens.
- It must be easy to copy screen by screen.
- It should paste almost directly into Stitch.
- Always mobile-first.`,

    12: `Now generate one block called STEP_4_EXECUTION_PACKET.

Use this packet header exactly:

# STEP_4_EXECUTION_PACKET

STATUS: draft

Then use these exact markdown section headings so discipline:validate can read the packet:

It must be self-contained and leave Step 4 almost ready, even though Step 2 may later validate and replace it.

## Product summary
- product goal
- main user
- main use case

## MVP boundary
- what is included
- what is not included yet

## Architecture locks
- architecture switches already chosen
- non-negotiable system constraints

## Data / access / sync contracts
- key entities
- key relationships
- minimum access rules
- minimum sync rules

## Slice
- Slice 0 to Slice 4
- short goal
- tentative scope
- obvious dependencies

## Bootstrap requirements
- what must exist first to start the app

## UI surface summary
- P0 screen names

## AI surface summary
- P0 AI features, if any

## Risks / edge cases
- maximum 8

## Implementation guardrails
- what must not be reinvented later
- what must not grow prematurely

Rules:
- Do not write code.
- Do not explain theory.
- Do not repeat the entire PRD.
- It must be consumable by a model that will expand slices.`,

    13: `Now generate two final blocks with these exact names:

1. DISCIPLINE_MD_READY_BLOCK
2. TASK_PLAN_READY_BLOCK

Rules:
- They must be ready to paste into the repo template.
- Do not explain anything outside the blocks.
- DISCIPLINE_MD_READY_BLOCK must include switches, summarized data model, access rules, sync rules, and notification rules.
- TASK_PLAN_READY_BLOCK must include Slice 0 to Slice 4.`,
  };

  return prompts[number] || '';
}
