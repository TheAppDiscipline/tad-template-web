---
name: discipline-audit
description: "Run one or all 15 self-audit prompts (the auto-audit prompt set in The App Discipline vault, sold separately) against the project. Each prompt validates specific NN against current state, produces structured JSON/Markdown output, and auto-logs an entry to findings.md §Audits. Triggers on /discipline-audit <n|all|name>, 'audit project', 'security audit', 'launch audit'."
---

# /discipline-audit - Orchestrate the 15 Discipline Loop self-audit prompts

This skill runs one or all 15 of the auto-audit prompts (the set documented in The App Discipline vault, sold separately) in a single session. It turns 15 manual copy/paste operations into one command, captures structured output, and logs each run to `findings.md §Audits`.

Recommended use: pre-Gate D Launch (run `all`), pre-Gate E PROD (run `all` with a focus on the P-category), and the monthly factory retrospective in the vault (sold separately).

## What the user sees

1. The skill asks for the audit index or name (`1`-`15`, `all`, or a slug like `rls`, `secrets`, `a11y`).
2. For each audit that runs:
   a. Reads the required inputs (files, shell commands, tool output).
   b. Applies the criteria of the corresponding prompt.
   c. Produces output with the schema declared in the auto-audit prompt set.
   d. Records an entry in `findings.md §Audits`.
3. In `all` mode, at the end it reports an aggregate: how many PASS, how many GAP, and the top 3 actions by impact.

## Prerequisites

- Repo with `.discipline/` and the canonical artifacts (`discipline.md`, `task_plan.md`, `findings.md`, `progress.md`).
- Official template commands available depending on the audit (`npm run gate`, `npx gitleaks`, `npx tsc`, `npx lighthouse`, etc.).
- WebSearch not required (everything is local).
- Active credentials if the audit needs them (audits 3, 10, 15 reference external vendors).

---

## Catalog of the 15 audits

Mapping of index to slug and validated NN. When the user invokes the skill, they can use any of the three.

| # | Slug | Validates | Recommended frequency |
|---|---|---|---|
| 1 | `nn-coverage` | NN 1, 11, 12, 17 against discipline.md | Pre-Gate C, post-Step 2 |
| 2 | `rls` | NN 17.3 RLS against migrations | After every migration that touches PII |
| 3 | `privacy-policy` | NN 17 + 62 §Privacy against the real app | Pre-Gate D, when adding a vendor |
| 4 | `perf` | NN 20 (bundle + Lighthouse) | Pre-deploy, pre-Gate D |
| 5 | `progress-drift` | NN 5, 8 (progress.md vs git) | Start of a session with a retro |
| 6 | `findings-gaps` | NN 5 (memory) | End of a dev week |
| 7 | `test-coverage` | NN 22 (boundaries) | Pre-Gate C, pre-Gate D |
| 8 | `secrets` | NN 17.5 | Pre-push to main, inherited repo |
| 9 | `ts-strict` | NN 21 (any, ts-ignore) | Weekly, when tsc gets slow |
| 10 | `deps-vulns` | NN 17.7 | Every 2 weeks, pre-release |
| 11 | `query-discipline` | NN 23 (N+1, indexes) | After every slice with queries, pre-Gate D |
| 12 | `a11y` | NN 24 (WCAG AA) | Pre-Gate D |
| 13 | `error-handling` | NN 18 | Pre-Gate C |
| 14 | `tokens` | NN 9 (UI tokens) | After every UI PR |
| 15 | `backup-restore` | 62 + NN 17 operational | Monthly, pre-Gate E |

---

## Internal implementation

### Phase 0: Resolve the invocation

User input: a number `1`-`15`, `all`, a slug from the table, or a partial name.

Resolve it to the list of audits to run. If ambiguous (e.g. `coverage` matches 7 and 14), ask for clarification.

### Phase 1: Check context

Before each audit:
- Read `discipline.md §0` to extract PROFILE and switches (some audits apply only to certain profiles).
- Skip audits that do not apply. Examples:
  - audit 2 RLS: skip if BACKEND_PROVIDER != SUPABASE.
  - audit 3 privacy: skip if PROFILE = LITE with no external services.
  - audit 12 a11y: skip if the lane has no UI (CLI/Backend, archived as of v1.0).
  - audit 15 backup-restore: skip if BACKEND_PROVIDER = LOCAL_ONLY.

When skipping, log it in findings with the reason: `skipped: not_applicable (PROFILE=LITE)`.

### Phase 2: Run each audit

For each audit in the list, apply the corresponding prompt from the auto-audit prompt set in the vault (sold separately). The typical structure:

#### Audit 1, nn-coverage (example)

**Inputs:**
- Read all of `discipline.md`.
- Read the canonical list of 24 NN from `.claude/skills/discipline-step0a/SKILL.md` or the Discipline Loop doctrine in the vault (sold separately).

**Logic:**
- For each NN, check whether `discipline.md` declares it explicitly and with enough specificity.
- Mark PASS / GAP / N/A according to the current profile.

**JSON output:**
```json
{
  "audit": "nn-coverage",
  "profile": "SHARED_SYNC",
  "checks": [
    { "nn": 1, "status": "PASS", "evidence": "discipline.md §3 Data Model declares 4 tables", "action": null },
    { "nn": 17, "status": "GAP", "evidence": null, "action": "Add §Security Baseline with 17.1-17.4" }
  ],
  "summary": { "pass": 18, "gap": 4, "na": 2 }
}
```

#### Audit 2, rls

**Inputs:**
- Glob `supabase/migrations/*.sql`.
- For each detected table, parse:
  - `ENABLE ROW LEVEL SECURITY`?
  - How many policies?
  - Do they cover SELECT/INSERT/UPDATE/DELETE?
  - Is there `auth.uid() IS NOT NULL` without scoping to tenant/space?

**Markdown output:**
| table | RLS | policies (S/I/U/D) | red flag | action |
|---|---|---|---|---|

#### Audit 3, privacy-policy

**Inputs:**
- Read `public/privacy-policy.md` or URL.
- Grep imports in `src/**` to detect vendors (`@supabase/*`, `@sentry/*`, `resend`, `posthog-js`, `stripe`, etc.).
- Read `discipline.md §Data Model` for the declared retention.

**Logic:**
- Vendors in code must appear in the privacy policy.
- Retention in the policy must match the real config (Sentry default 90d).
- US vendors must mention a transfer mechanism (SCCs or DPF).

**JSON output:**
```json
{
  "vendors_in_code": ["supabase", "sentry"],
  "vendors_in_policy": ["supabase"],
  "missing_in_policy": ["sentry"],
  "retention_mismatches": [],
  "action_list": ["Add Sentry to §Third parties with 90d retention and SCCs"]
}
```

#### Audit 4, perf

**Commands (per lane):**
```bash
# Web / Desktop (Vite)
npm run build
npx vite-bundle-visualizer  # or equivalent
npx unlighthouse --site http://localhost:4173
# Mobile (Expo): no local `npm run build`; EAS builds in the cloud.
#   Inspect the JS bundle with `npx expo export` and review the output size.
# Extension (WXT): `npm run build`, then inspect .output/ bundle sizes; Lighthouse N/A.
```

**Logic:**
- Compare against the NN 20 thresholds (Web: entry < 200KB gzip · Lighthouse Perf > 70 mobile).

**Output:**
- Table of real entry size vs target.
- Top 5 deps by weight.
- Lighthouse score per category.
- List of actions if any threshold fails.

#### Audit 5, progress-drift

**Inputs:**
- Read `progress.md §Last Completed Slices` and `§Current Status`.
- `git log --oneline -50`.
- `git log --name-only -20`.

**Logic:**
- Slices declared done with no associated commit.
- Commits with no entry in progress.md.
- Errors closed in progress.md that are already resolved in code.

**Output:**
- Table of slice × commit × real state.
- List of entries to add/update/delete in progress.md.

#### Audit 6-15

Follow the structure declared in the auto-audit prompt set in the vault (sold separately) for each one. The output schema comes with each original prompt.

### Phase 3: Log to findings.md

For each audit that ran, add an entry to `findings.md §Audits`. If the section does not exist, create it.

Format:
```markdown
## Audits

- <date YYYY-MM-DD HH:MM> · audit-<slug> · status=<PASS|GAP|N/A counts> · top-action=<most critical action if GAP>
- <date> · audit-<slug> · ...
```

If an audit produces a critical GAP (e.g. committed secrets, RLS disabled on a table with PII), also add an entry to `findings.md §Risks`:
```markdown
- 2026-04-26 · CRITICAL · audit-secrets detects an API key in a committed .env · rotate and `git filter-repo` before the next push.
```

### Phase 4: `all` mode, final aggregate

If the user invokes `all`, after running the 15 audits:

```markdown
## Aggregate summary, /discipline-audit all (<date>)

Profile: <profile>
Total audits: 15
- PASS: <N>
- GAP: <N>
- N/A (skipped): <N>

### Top 5 actions by impact

1. <most critical action from the GAPs>
2. ...

### Audits with GAP

| Audit | GAPs | Top action |
|---|---|---|
| nn-coverage | 4 | Add §Security Baseline |
| ... | ... | ... |

### Gate D Launch verdict

<READY if 0 critical GAPs | NOT READY if there are GAPs in audits critical for Gate D>

Audits critical for Gate D: 1 (nn-coverage), 2 (rls), 3 (privacy-policy), 7 (test-coverage), 8 (secrets), 12 (a11y), 13 (error-handling).
Audits critical for Gate E PROD: all of the above + 4 (perf), 10 (deps-vulns), 11 (query-discipline), 15 (backup-restore).
```

### Phase 5: Summary to the user

If an individual audit was invoked:
```
Audit <slug> completed.
Status: PASS / GAP <N>
Top action: <action>
Detail: findings.md §Audits.
```

If `all` was invoked:
```
Audit batch completed in <minutes> minutes.
PASS: <N>/15
GAP: <N>/15
N/A skipped: <N>/15

Top 3 critical actions:
1. ...
2. ...
3. ...

Gate D Launch verdict: <READY|NOT READY>

Full detail: findings.md §Audits.
```

---

## Error handling

- An individual audit fails on a missing input (e.g. supabase/migrations/ does not exist but BACKEND=SUPABASE): log it as skipped with the reason, do not abort the batch in `all` mode.
- An external command fails (gitleaks, lighthouse, axe): install on demand with `npx -y <package>` or skip with a notice.
- Output too long (e.g. `npm audit` with 100 vulns): truncate to the top 20, create an attached entry in `.discipline/audits/<slug>-<date>.md` with the full detail.
- If the user interrupts `all` mode partway through, log the audits already run to findings.md and report partial progress.

---

## Critical rules

- Do not mark items as `done` or `fixed` from the skill. It only audits; the user applies the fixes.
- Do not add false entries to findings. If there is no GAP, the audit result goes to findings.md §Audits with status PASS, not to §Risks.
- audit 8 (secrets): if it detects a real secret, do NOT log the secret in findings; only the pattern and the action (rotate + filter-repo).
- audit 3 (privacy-policy): if it detects a vendor in code that is not listed in the policy, alert but do not write anything into public/privacy-policy.md (that is the responsibility of `/discipline-legal-init`).
- `all` mode is not for running on every commit. Typically pre-Gate D or monthly retros.
- Target time: individual audit <1min, `all` mode 15-30 min.
