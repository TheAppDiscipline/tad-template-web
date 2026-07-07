# Discipline Loop - Project Instructions

This project follows the Discipline Loop methodology. `discipline.md` is the law. Read it before any implementation.

## Core Rules

- **Data-First:** contracts before code
- **One Writer Per Slice:** never have two agents editing the same slice
- **Gates before merge:** `npm run gate` must pass before any commit
- **No breaking schema changes** without migrations
- **Self-annealing:** 2 identical error signatures with no material change (evidence, context, hypothesis, strategy) -> stop; escalating the model grants a single third attempt only when you document why more reasoning capacity could change the diagnosis; hard stop at 3 failures of the same gate

## Recommended Pipeline Mode

Use `npm run discipline:watch` as the default operating mode.

That watcher is responsible for:
- reading new packets in `.discipline/packets/`
- extracting patch blocks
- applying patches
- updating `progress.md` after `SLICE_COMPLETION_PACKET`
- assembling the next `paste-ready` handoff

Use `discipline:patch` and `discipline:assemble` manually only as fallback.

## Key Files

| File | Purpose |
|---|---|
| `discipline.md` | Project constitution with switches, contracts and DoD |
| `task_plan.md` | Slice plan with statuses |
| `findings.md` | Decisions, risks and assumptions |
| `progress.md` | Current state, recent slices and open errors |
| `.discipline/packets/` | Handoff packets between pipeline steps |
| `.discipline/patches/pending/` | Patch blocks waiting to be applied |
| `.discipline/paste-ready/` | Assembled handoffs ready to paste into the next tool |
| `.mcp.json.example` | Minimal MCP baseline for this repo |

## Gate Command

```bash
npm run gate        # lint + typecheck + tests + visual token gate
npm run gate:full   # gate + bundle size check
npm run gate:visual # opt-in browser/UI verification (e2e/a11y), lane-specific; see package.json. NOT part of npm run gate
npm run check-db-types  # opt-in (BACKEND_PROVIDER=SUPABASE): DB schema vs committed database.types.ts. In gate:strict; NOT in npm run gate. Fix: npm run db:types:generate
```

## Discipline Automation Scripts

```bash
npm run discipline:patch      # apply pending patches to discipline.md/task_plan.md/findings.md/progress.md
npm run discipline:assemble   # assemble paste-ready file for the next step
npm run discipline:progress   # update progress.md from SLICE_COMPLETION_PACKET
npm run discipline:status     # show pipeline dashboard
npm run discipline:validate   # check pipeline integrity and packet completeness
npm run discipline:watch      # auto-run the plumbing on new packets
```

There is no batch-to-cloud script: the former `discipline:codex-batch` depended on a non-public Codex API endpoint and was removed. For parallel or unattended slice execution, use the GitHub lane instead: one branch/PR per slice driven by your cloud agent (Claude Code GitHub Action, Codex cloud, Copilot coding agent), with CI running `npm run gate` on every push (`.github/workflows/ci.yml`) as the merge check.

## Validation Rule

Run `npm run discipline:validate` before closing a pipeline branch or opening a PR that touches Discipline Loop artifacts.

`discipline:validate` now checks:
- pending patches
- canonical anchors in `discipline.md`, `task_plan.md`, `findings.md` and `progress.md`
- required directories under `.discipline/`
- semantic completeness of key packets such as `STEP_5_SLICE_PACKET`, `DEPLOY_READINESS_PACKET`, `POST_DEPLOY_FEEDBACK_PACKET` and `PROD_HARDENING_PACKET`

## Backend Adapter Pattern

Backend is a plugin: `src/lib/backend/index.ts` is the factory. Never import Supabase or Firebase directly. Use the adapter interface.

SDKs are installed on demand:
- `npm i @supabase/supabase-js`
- `npm i firebase`

## Anchor Rules

Never rename or delete headings in `discipline.md`, `task_plan.md`, `findings.md`, or `progress.md`. The `discipline:*` scripts depend on exact heading text to apply patches and validate state.

## Model Routing (Step 5)

Choose the right **model role** based on slice complexity. Concrete model IDs, prices, lifecycle and free tiers live in the separately-sold The App Discipline vault's model registry; do not hardcode versions here.

- **Simple slices** (CRUD, UI layout, static pages): Use `Premium Reliable - Mechanical Work`, `Premium Reliable - Async Agent`, or `Frontier-Budget - Implementation` when gates and review are strong.
- **Complex slices** (business logic, multi-table operations, state management): Use `Premium Reliable - Implementation`.
- **Slices touching RLS, auth, sync, or permissions**: Use `Premium Reliable - Implementation` plus cross-review. Do not use a cheap/async-only path.
- **If the gate fails 2 times with the same error**: Escalate to `Premium Reliable - Critical Decisions` before the 3rd attempt.
- **Architecture decisions or persistent bugs**: Escalate to `Premium Reliable - Critical Decisions` with the strongest available reasoning mode.
- **Visual UI / design system / brand-aware mockups (Step 3)**: Use `Premium Reliable - Visual Design` (Claude Design) when there is brand, design system, realistic prototypes or handoff to Claude Code; `Frontier-Budget - UI/Frontend` (Stitch, v0.dev) for budget exploration without established brand. Both produce `UI_HANDOFF_PACKET` for Step 5.

## Slice Loop (Step 5)

For each slice follow the 8-step loop: Plan -> Implement -> Self-Review -> Gate -> Repair -> Log -> Commit -> Deploy/Verify.

1. **Plan:** Read `STEP_5_SLICE_PACKET` from `.discipline/packets/` and review `discipline.md` contracts
2. **Implement:** Write the code for the slice. One writer per slice.
3. **Self-Review:** Read your own diff. Look for debug logs, hardcoded secrets, empty catches, unused imports, `any` without justification.
4. **Gate:** Run `npm run gate` until it passes. If `AI_FEATURES=enabled`, also run `npm run ai:smoke && npm run ai:eval`.
5. **Repair:** If the gate fails, analyze the error, apply a fix with new information, and return to Gate. After 2 attempts with the same signature and no material change (evidence, context, hypothesis, strategy), stop; escalating the model grants a single third attempt only when you document (in `progress.md` Open Errors or `run-log.md`) why more reasoning capacity could change the diagnosis. Hard stop at 3 failures of the same gate. If the signature points to spec, architecture, data, or environment, return to the producing step.
6. **Log:** Update `progress.md` with what changed, what was tested, what failed, and what comes next.
7. **Commit:** With a green gate, commit with a descriptive message (e.g., `feat(S03): item list with pull-to-refresh`). Never end a session with working code uncommitted.
8. **Deploy/Verify:** Run the minimal smoke test for the lane.

After closing the slice, generate `SLICE_COMPLETION_PACKET` in `.discipline/packets/` and let `discipline:watch` update progress and assemble the next handoff.

## TypeScript Rules

- `strict: true`
- No `any` in business logic
- No `@ts-ignore` without a comment explaining why

## Testing

For UI lanes, you can also run the minimal browser smoke:

```bash
npm run e2e:install
npm run e2e
```

That check is intentionally separate from `npm run gate` so the project can adopt browser verification progressively.

- Minimum: 1 happy path + 1 error path per slice
- Test boundaries, not internals
- No mocking your own code unless justified
- Tooling tests under `tests/tooling.discipline.test.js` protect pipeline handoffs and semantic validation

## Security

- Never commit `.env` or API keys
- `ANON_KEY` only in frontend
- `SERVICE_ROLE_KEY` never in frontend
- All queries with `limit`
- RLS on all Supabase tables before production
- Use `.github/workflows/security-review.yml` only after configuring `ANTHROPIC_API_KEY` in repository secrets
