---
name: discipline-verify
description: "Opt-in advanced verification fan-out. Runs the Discipline Loop audit subagents in parallel (rls, security, scope, a11y, architecture, legal/product), collects their JSON envelopes, and merges them deterministically into one advisory report. NOT part of npm run gate; requires Claude Code (LLM, costs tokens). Triggers on /discipline-verify, 'fan-out verify', 'run the audit subagents', 'advanced verification'."
---

# /discipline-verify - Verification fan-out (advisory, opt-in)

Run the Discipline Loop audit subagents **in parallel** and merge their results into a single report. This is **opt-in verification / an advanced gate**, NOT the base gate: `npm run gate` stays deterministic and LLM-free, and this skill does not touch it.

> **Advisory, no auto-blocking.** The report recommends; the human decides. No subagent blocks on its own. `blocking` is always `false`.

## Cost and dependency (read before running)

- **Requires Claude Code** (the subagent runtime). It does not run as a shell script, nor on a buyer's machine without an agent.
- **Costs tokens:** up to 6 subagents (5 on the `haiku` model, 1 on `sonnet` for architecture; security-reviewer is `sonnet`). Run the subset that applies to the slice, not always all 6.
- The **merge and validation** of the result IS deterministic (`tools/discipline/audit-merge.ts`), with no LLM.

## What it does (steps for the agent)

1. **Pick the timestamp** `TS` in the format `YYYYMMDD-HHMMSS` (UTC) and create the folder `.discipline/audits/raw/<TS>/`.
2. **Pick the applicable subagents** based on what the slice touched (by default, all that apply):
    - `discipline-scope-guard` and `discipline-security-reviewer`: almost always when closing a slice.
    - `discipline-rls-auditor`: if there were changes in `supabase/migrations/`.
    - `discipline-a11y-checker`: if there were UI changes (`src/**/*.tsx` or styles).
    - `discipline-architecture-auditor`: if deps or modules were added, or `src/lib/backend/**` was touched.
    - `discipline-legal-product-auditor`: if the profile is LAUNCH or PROD, or when productizing.
3. **Invoke them IN PARALLEL** with the `Agent()` tool (several calls in a single turn). One writer per slice: this fan-out is VERIFICATION only, it does not write product code.
4. **Save each envelope** a subagent returns, verbatim, to `.discipline/audits/raw/<TS>/<agent>.json` (one file per subagent; the filename must be the `agent` from the envelope). The parent agent writes these files because the subagents do not have a uniform write tool.
5. **Merge deterministically**, passing to `--expected` the EXACT list of subagents you decided to run in step 2 (comma-separated):
    ```bash
    npm run discipline:audit-merge -- \
        --raw-dir .discipline/audits/raw/<TS> \
        --expected discipline-scope-guard,discipline-security-reviewer,...
    ```
    This validates each envelope against `discipline.agent_audit.v1`, strips fences defensively, computes the global status, and writes `.discipline/audits/<TS>-fanout.json` plus a readable summary.
    **`--expected` matters:** if a subagent you were going to run did not deliver an envelope (failed or was skipped), the merge lists it under `missing_agents`, raises the global status to at least `WARN`, and the audit is NOT reported as a clean `PASS`. Without `--expected`, the merge cannot know that one is missing.
6. **Present the summary** to the user: global status (`PASS | WARN | FAIL`), counts by severity, and the `critical` findings first. Remember that it is advisory.

## Global status

- `FAIL` if any subagent returned `FAIL` (>= 1 `critical` finding).
- `WARN` if none `FAIL` but some `WARN` (only `moderate`/`minor`).
- `PASS` if all `PASS`.

## Degradation (no LLM / errors)

- If there is no Claude Code, this skill cannot run: the subagents belong to the LLM runtime. Say this clearly; do not fake a result.
- If a subagent fails or does not return an envelope, do NOT invent one: skip its file. Since you passed `--expected`, the merge will mark it under `missing_agents` and raise the status to `WARN`, so the partial audit stays visible instead of reading as `PASS`.
- If an envelope does not conform to `discipline.agent_audit.v1`, `audit-merge` **fails clearly (exit 2)** and does not merge: that is contract drift, you have to fix the subagent, not ignore it.

## CI use (opt-in)

For an optional advanced gate in CI, run the merge with `--strict`: it exits with a code != 0 if the global status is `FAIL`. It still is not part of `npm run gate`.

```bash
npm run discipline:audit-merge -- --raw-dir .discipline/audits/raw/<TS> --strict
```

## Prerequisites

- Repo with `.discipline/` and the subagents in `.claude/agents/discipline-*.md`.
- Claude Code available (the subagents run via `Agent()`).
- `tools/discipline/audit-merge.ts` present (the deterministic merge step).

## Does not do

- Not part of `npm run gate` and does not modify it.
- Does not apply fixes or write product code.
- Does not block on its own (advisory); the `--strict` for CI is an explicit user decision.
- Does not guarantee "quality" or "compliance": it adds auditor recommendations, nothing more.
