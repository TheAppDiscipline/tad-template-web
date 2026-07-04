---
name: discipline-overengineering-check
description: "Flag over-engineering and under-engineering signals in the current project against the Anti-overengineering Doctrine from The App Discipline vault (sold separately). Reads discipline.md + package.json + progress.md + git log; flags the deps-per-slice ratio, premature abstractions, skipped gates, or under-engineering (RLS off, secrets in the client). Triggers on /discipline-overengineering-check, 'check overengineering', 'scope check', 'audit complexity'."
---

# /discipline-overengineering-check - Detect over/under engineering in the project

This skill auto-applies the 10 rules of the Anti-overengineering Doctrine from the vault (sold separately) against the current state of the project. It reports signals with a confidence level (clear violation / probable / possible) and suggests a concrete action.

NOTE: this skill is advisory, non-blocking. Scope decisions still belong to the user; the skill only flags when the patterns smell like over- or under-engineering.

## What the user sees

1. The skill reads 4 sources: `discipline.md`, `package.json`, `progress.md`, and the last 30 days of `git log`.
2. It applies the 10 checks from the doctrine (5 for over, 5 for under).
3. It reports a table per check with: signal (clear / probable / possible), evidence, rule violated, suggested action.
4. It summarizes at the end: how many clear, how many probable, top 3 actions by impact.
5. It records the result in `findings.md §Audits` as `audit-overengineering`.

## Prerequisites

- Repo with `.discipline/`, `discipline.md`, `progress.md`, `task_plan.md`.
- Git initialized (needed to evaluate the deps-per-slice ratio and commit patterns).
- Readable `package.json`.

---

## Internal implementation

### Phase 0: Gather context

Read:
- `discipline.md §0` for PROFILE, LANE, AI_FEATURES, SYNC_MODE, COLLAB_MODE.
- `package.json` for the `dependencies` + `devDependencies` count.
- `progress.md` for slices declared done (count of `## Slice` with outcome=done or `[x]`).
- `task_plan.md §Ready Slices` or equivalent.
- `git log --since="30 days ago" --oneline` (count + sample).
- `git log --since="30 days ago" --name-only` to detect created folders/files.
- `findings.md §Tech Debt` if it exists.

Capture for use in the checks:
- N_DEPS = count of runtime dependencies
- N_DEV_DEPS = count of devDependencies
- N_SLICES_DONE
- N_COMMITS_30D
- N_NEW_FOLDERS_SRC = new folders in src/ over the last 30 days (abstraction heuristic)
- PROFILE
- DAYS_SINCE_INIT = days since the first commit

### Phase 1: OVER engineering checks (5 rules)

Each check returns: `clear` (high confidence), `probable` (40-70% confidence), `possible` (weak alert), or `none`.

#### Check OE-1: Too many deps for the profile

**Rule 11c §1, §3:** complexity justified by real pain. A LITE profile should not go past ~10 deps; FAMILY_SYNC ~20; LAUNCH/PROD can go higher.

**Logic:**
- LITE + N_DEPS > 10 -> `probable`
- LITE + N_DEPS > 15 -> `clear`
- FAMILY_SYNC + N_DEPS > 25 -> `probable`
- FAMILY_SYNC + N_DEPS > 35 -> `clear`
- LAUNCH/PROD: warn only if growth is > 5 deps over the last 30 days with no new slices.

**Action:** review deps with `npm ls --depth=0`; ask the NN #16 Scope Guard question, does this dep have a 1-5 line equivalent implementation and observed pain?

#### Check OE-2: Deps-per-slice ratio (deps/slice)

**Rule 11c §3:** a dependency hostile to the budget.

**Logic:**
- If N_DEPS / max(N_SLICES_DONE, 1) > 5 -> `probable`
- If N_DEPS / max(N_SLICES_DONE, 1) > 8 and profile LITE/FAMILY_SYNC -> `clear`

**Action:** list the deps NOT actively imported in src/ (orphans); propose removal.

#### Check OE-3: Premature abstractions

**Rule 11c §4:** rule of three, do not abstract with 2 instances.

**Logic:**
- Detect folders in src/ named `helpers/`, `utils/`, `lib/`, `core/`, `abstract/`, `interfaces/` with < 2 files each -> `possible`
- Detect a `models/` or `types/` folder with files >300 lines and only 1 consumer in src/ (cross-import grep) -> `probable`
- A `services/` folder with 1 service that has 1 method and 1 caller -> `clear`

**Action:** suggest inlining the abstraction's code into the single caller until a second caller shows up.

#### Check OE-4: Gate skipping signal

**Rule 11c §6, §7:** the right gate for the phase.

**Logic:**
- Search the last 30 days of git log for commits whose messages contain `skip gate`, `--no-verify`, `bypass gate`, `WIP`, `quick fix without test`, `temporary` -> each hit is `possible`.
- Search `findings.md §Tech Debt` for items that mention "skipped gate" -> `probable`.
- If N_COMMITS_30D > 50 and N_TESTS is static (did not grow) -> `probable` (commits without tests).

**Action:** run `npm run gate:strict` on the current commit; review the documented tech debt.

#### Check OE-5: Pipeline overhead vs scope

**Rule 11c §2, §8:** profile scope + minimum viable packets.

**Logic:**
- LITE + every slice producing all 19 possible packets -> `clear` (overkill).
- LITE + `.discipline/scorecard.yaml` with >50 entries -> `probable`.
- FAMILY_SYNC + no Sentry preinstalled and > 5 slices done -> `possible` (under-overhead, see the inverse of OE5 under under-engineering).

**Action:** prune packets down to the 7 minimum for LITE; defer the scorecard YAML until LAUNCH.

### Phase 2: UNDER engineering checks (5 rules)

The mirror image, NN-related. The rules come from 11c §"Under-engineering signals".

#### Check UE-1: RLS disabled on tables with PII

**Logic:**
- If BACKEND_PROVIDER=SUPABASE: read the migrations, detect `CREATE TABLE` with no following `ENABLE ROW LEVEL SECURITY` or with no policies.
- If the table has columns that look like PII (`email`, `name`, `phone`, `address`, `dob`) -> `clear` when RLS is off.

**Action:** run `/discipline-audit rls` (audit 2 of the self-audit prompt set in The App Discipline vault, sold separately) for a detailed report and fixes.

#### Check UE-2: Secrets in the client

**Logic:**
- Grep `src/**/*.{ts,tsx,js}` for the patterns `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `OPENAI_API_KEY` (without `process.env` wrapping) -> `clear`.
- Detect imports of `@supabase/supabase-js` with a literal API key -> `clear`.

**Action:** rotate the secret immediately; run `/discipline-audit secrets` (audit 8) for a gitleaks scan + remediation plan.

#### Check UE-3: Empty catch {}

**Logic:**
- The ESLint rule `no-empty` already catches this (NN #18). Verify it is active in eslint.config.js.
- If the rule is disabled or set to `warn`, mark `probable`.

**Action:** enable `'no-empty': ['error', { allowEmptyCatch: false }]` in the eslint config and run lint.

#### Check UE-4: Queries without LIMIT

**Logic:**
- Grep `.from('<table>').select` without `.limit(...)` -> `probable` (each hit).
- `npm run check-queries` already detects this as of Wave 3.1.

**Action:** run `npm run check-queries` or `/discipline-audit query-discipline` (audit 11).

#### Check UE-5: No Sentry/observability in a public app

**Logic:**
- PROFILE >= LAUNCH and `package.json` without `@sentry/*` or `posthog-js` -> `clear`.
- PROFILE = FAMILY_SYNC and the app is deployed (detect via `discipline:status` or git tags like `v0.x`) and there is no observability -> `probable`.

**Action:** install a minimal Sentry for Gate D; see the essential-security note (Observability baseline) in the vault (sold separately) or equivalent.

### Phase 3: Report

Aggregate table:

```markdown
## Discipline Loop · Overengineering / Underengineering Check

**Generated:** <date>
**Profile:** <profile>
**Status:** <N clears> · <N probables> · <N possibles>

### Over engineering

| Check | Signal | Evidence | Rule violated | Action |
|---|---|---|---|---|
| OE-1 deps per profile | clear | 18 deps in LITE (limit ~10) | NN #16 Scope Guard, 11c §1 | Review `npm ls --depth=0`; prune non-essential deps |
| OE-2 deps/slice ratio | probable | 6.0 (limit 5.0) | 11c §3 | List orphan deps |
| ... | ... | ... | ... | ... |

### Under engineering

| Check | Signal | Evidence | Rule violated | Action |
|---|---|---|---|---|
| UE-1 RLS | none | All tables with PII have RLS + policies | NN #17.3 | OK |
| ... | ... | ... | ... | ... |

### Top 3 actions by impact

1. <the most critical action among the clears>
2. ...
3. ...

### Overall verdict

<In balance | Over-engineered | Under-engineered | Mixed>
```

### Phase 4: Record in findings.md

```markdown
## Audits

- <date> · audit-overengineering · clears=<N> · probables=<N> · top-action=<action>
```

If there is a `clear` UE-1 (RLS off with PII) or UE-2 (secrets in the client), also add to `findings.md §Risks`:
```markdown
- <date> · CRITICAL · audit-overengineering UE-2 detected a hardcoded API key in src/<file> · rotate immediately.
```

### Phase 5: Summary to the user

```
Overengineering Check complete.

OVER engineering: <N clears> / <N probables> / <N possibles>
UNDER engineering: <N clears> / <N probables> / <N possibles>

Top 3 actions:
1. ...
2. ...
3. ...

Verdict: <In balance | Over-engineered | Under-engineered | Mixed>

Detail: findings.md §Audits.

Note: this skill is advisory. The user decides whether the signals justify action. For `clear` signals, especially UE-1/UE-2, action is practically mandatory before Gate D.
```

---

## Error handling

- Repo without git: mark OE-4 (gate skipping) as N/A; the other checks run normally.
- progress.md empty or absent: apply the checks assuming N_SLICES_DONE = 0; that amplifies the deps/slice ratio detection.
- discipline.md without PROFILE: use the default FAMILY_SYNC for the thresholds.
- src/ empty (freshly hydrated template): most checks return `none`; report that the repo is in a premature state.

---

## Critical rules

- The signals are advisory, non-blocking. Do not fail the gate or block merges.
- `clear` UE-1 and UE-2 (RLS off + secrets in the client) are the most urgent; prioritize them in the top 3.
- Do not suggest REMOVING deps in bulk without verifying imports; "orphan" is a heuristic (it could be a dep used via dynamic require or config).
- Do not mark an abstraction as premature without verifying there are only 1-2 callers (rule of three).
- Target time: <2 minutes for the whole report.
- If the user invokes the skill monthly, record the trend in findings.md (e.g. "deps growing +5 since the last audit").
