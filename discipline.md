<!--
  This is the project constitution. It will be populated by /discipline-step1
  with your app's contracts, switches, data model and Definition of Done.
  Do NOT rename the H2 anchor headings (## 0) Profile, ## 1) Non-Negotiables,
  etc.); the discipline:patch scripts depend on the exact heading text.
-->

# discipline.md — Project Constitution

## 0) Profile
- PROJECT_NAME:
- PRIMARY_GOAL:
- NORTH_STAR_METRIC:
- PROFILE:
- BACKEND_PROVIDER: LOCAL_ONLY
- AUTH_MODE: NONE
- COLLAB_MODE:
- STACK:
  - Frontend: PWA (Web)
  - Hosting:
  - Backend:
- SYNC_MODE:
- PUSH_PLUGIN:
- AI_FEATURES:
- LANE: WEB
- STEP4_EXPANSION_MODE: batch
- READY_PROMOTION: per_packet
- DOCTRINE_VERSION: 1.0

## Env Configuration
- Backend and auth are selected in this file, then materialized by `npm run discipline:provider:generate`.
- `.env` stores credentials only; it must not declare provider or auth mode.

### Supabase Env
- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY
Rule: ANON_KEY only in frontend. Service role key never in frontend.

### Firebase Env
- VITE_FIREBASE_API_KEY
- VITE_FIREBASE_AUTH_DOMAIN
- VITE_FIREBASE_PROJECT_ID
- VITE_FIREBASE_APP_ID

## 1) Non-Negotiables
- (inherited from Discipline Loop)

## 2) Tenancy & Permissions
- N/A

## 3) Data Model
- N/A

## 4) API / IO Shapes
- N/A

## 5) Sync Rules
- N/A

## 6) UI State Model
- N/A

## 7) Event / Notifications Model
- PUSH_PLUGIN=false

## 8) Design Tokens Contract
- N/A

## 9) Testing / Gates Contract
- N/A

## 10) LLM Contracts
- AI_FEATURES=none

## 11) Universal Definition of Done
- N/A
