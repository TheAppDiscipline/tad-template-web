# Discipline Loop Web Template

Template repository for building web applications following the **Discipline Loop** methodology.

**Part of The App Discipline.** This is the public, MIT-licensed template (see `LICENSE`). The complete Discipline Loop methodology and vault (full system, playbooks, prompts, and extended materials) are a separate product, sold separately at https://theappdiscipline.gumroad.com/l/tad, and are **not** included in this repository.

**Stack:** React 19 + Vite 8 + TypeScript (strict) + semantic design tokens

**Features:** Modular Backend Factory (Supabase, Firebase, Local), PWA skeleton, quality gates, pipeline automation scripts, agent integration via `AGENTS.md` (canonical; read by Codex, Cursor, Copilot, and Claude Code via a `CLAUDE.md` stub).

## Getting Started

**Prerequisite:** Node.js 22 or newer.

1. Click **Use this template** to create a new repository.
2. Clone your new repository.
3. Install dependencies: `npm install`
4. Run the gate: `npm run gate`
5. Start dev server: `npm run dev`

The template starts with `LOCAL_ONLY`, so no `.env` is needed for the first run. `.env` holds credentials only after you choose a cloud backend in `discipline.md`.

## Recommended Operating Mode

After `npm install`, initialize the Discipline Loop structure if the project is still blank:

```bash
npm run discipline:hydrate -- --lane WEB --profile LITE --backend LOCAL_ONLY --auth NONE
```

For day-to-day pipeline work, the recommended mode is:

```bash
npm run discipline:watch
```

`discipline:watch` listens to `.discipline/packets/`, extracts patch blocks, applies them, updates `progress.md` when needed, and assembles the next `paste-ready` file automatically.

Use `discipline:patch` and `discipline:assemble` manually only as fallback.

## Key Files

| File | Purpose |
|---|---|
| `discipline.md` | Project constitution with switches, data model, contracts and Definition of Done |
| `task_plan.md` | Slice plan with statuses |
| `findings.md` | Decisions, risks and assumptions |
| `progress.md` | Current state, recent slices and open errors |
| `AGENTS.md` | Canonical agent instructions (Codex, Cursor, Copilot, Claude Code) |
| `CLAUDE.md` | Stub that imports `AGENTS.md` for Claude Code |
| `.discipline/` | Pipeline packets, patches, paste-ready files and run log |
| `.mcp.json.example` | Safe MCP starting point with minimal examples |
| `.pre-commit-config.yaml` | Optional local checks for Markdown and editorial consistency |
| `.github/workflows/docs.yml` | Optional pipeline and docs validation in PRs |
| `.github/workflows/security-review.yml` | Optional automated PR security review |

## Backend Selection

Choose the provider in `discipline.md`, then generate the versioned runtime contract:

```bash
npm run discipline:provider:generate
```

The initial contract is `LOCAL_ONLY` / `NONE` and works without credentials. Do not set `VITE_BACKEND_PROVIDER` or `VITE_AUTH_MODE`; those former architecture variables are rejected.

| Provider | Install | Use case |
|---|---|---|
| **SUPABASE** | `npm i @supabase/supabase-js` | Relational data + RLS security |
| **FIREBASE** | `npm i firebase` | Firestore + Auth |
| **LOCAL_ONLY** (initial) | none | Rapid prototyping with localStorage |

After choosing a cloud provider, copy its credential example (`.env.example.supabase` or `.env.example.firebase`) to `.env`, fill the credentials, then run `npm run gate:integration`.

### Firebase Production Setup

When `discipline.md` selects `BACKEND_PROVIDER: FIREBASE`, install the Firebase SDK, configure `.env` from `.env.example.firebase`, and deploy the checked-in Firestore artifacts before running launch/prod smoke tests:

```bash
firebase deploy --only firestore:rules,firestore:indexes
npm run firebase:smoke
```

- Rules: `firebase/firestore.rules`
- Indexes: `firebase/firestore.indexes.json`
- Email-link auth requires an HTTPS app URL that is authorized in Firebase Auth settings.

## Quality Gates

```bash
npm run gate        # lint + typecheck + tests + visual tokens + security checks (secrets, RLS, CORS, HTTPS, FK indexes, migration lint, Firebase rules)
npm run gate:full   # gate + bundle size check (<200 KB)
```

## Pipeline Automation (`discipline:*` scripts)

These scripts automate the mechanical operations between Discipline Loop pipeline steps:

```bash
npm run discipline:status     # Dashboard: where you are and what comes next
npm run discipline:patch      # Apply pending patch blocks to discipline.md/task_plan.md/findings.md/progress.md
npm run discipline:assemble   # Assemble the paste-ready file for the next step
npm run discipline:progress   # Update progress.md from SLICE_COMPLETION_PACKET
npm run discipline:log        # Append entry to the run log
npm run discipline:validate   # Check pipeline integrity and packet completeness
npm run discipline:watch      # Watch new packets and run the mechanical plumbing automatically
```

## Optional Repo Hardening

This template includes the safe base for pipeline enforcement:

- `.mcp.json.example` with minimal MCP examples
- `.pre-commit-config.yaml` for local Markdown and Vale checks
- `.markdownlint-cli2.jsonc` for Markdown structure
- `.vale.ini` and `.vale/styles/DisciplineLoop/` for editorial consistency
- `.github/workflows/docs.yml` for docs and pipeline validation in pull requests
- `.github/workflows/security-review.yml` for automated PR security review

Recommended activation path:

1. Install dependencies with `npm install`
2. Optional: install `pre-commit` and enable it locally
3. Optional: install Vale on your machine
4. Keep `Docs CI` active for pull requests
5. Add `ANTHROPIC_API_KEY` only if you want automated security review on PRs

## Playwright Smoke Test

For UI lanes, the template also supports a minimal browser smoke check:

```bash
npm run e2e:install
npm run e2e
```

This smoke test is intentionally lightweight and stays outside the main gate until the project decides to enforce browser checks in CI.

## AI Features (Optional)

If `AI_FEATURES=enabled` in `discipline.md`:

```bash
npm i -D openai           # or @google/genai or @anthropic-ai/sdk
npm run ai:smoke          # Verify provider responds
npm run ai:eval           # Run eval cases
```

When `AI_FEATURES=none`, AI scripts skip cleanly.

## MCP Setup (Optional)

Start from `.mcp.json.example` and enable only the servers the project really needs.

Recommended order:
- GitHub in read-only mode when you need PRs, Actions or issues in context
- Playwright for browser verification in UI lanes
- Stitch only during Step 3; it can modify design assets, so use a dedicated key and disable it after the approved handoff
- Supabase only when the backend provider is Supabase

Do not add write-heavy MCPs by default.

## Project Structure

```text
src/
  lib/backend/        Modular adapters (Supabase, Firebase, Local)
  config/             Runtime configuration (provider, auth mode)
  styles/tokens.css   Semantic design tokens
tools/
  discipline/         Pipeline automation scripts (discipline:*)
  *.js                Quality gates (smoke tests, token check, bundle check, LLM eval)
.discipline/
  packets/            Handoff packets between pipeline steps
  patches/            Patch blocks (pending -> applied)
  paste-ready/        Pre-assembled prompts for next step
  run-log.md          Append-only pipeline execution log
```

## Methodology

- **Data-First:** Define contracts in `src/lib/backend/types.ts` before building UI
- **One Writer Per Slice:** Never have two agents editing the same slice
- **Semantic Tokens:** All styling through `tokens.css` with no hex hardcodes
- **Gates Before Merge:** `npm run gate` must pass before any commit
- **Anchor Rules:** Never rename headings in `discipline.md`, `task_plan.md`, `findings.md`, or `progress.md` because the `discipline:*` scripts depend on them
