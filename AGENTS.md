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

## Substrate: locks, ledger, and reports

Local, file-based coordination and observability for the pipeline. No daemon, no network, no new dependencies. Runtime state lives under `.discipline/` and is gitignored.

- **Writer lock** (`.discipline/locks/writer.lock`): `apply-patch` and `watch` hold it while mutating `discipline.md` / `task_plan.md` / `findings.md` / `progress.md`, so only one writer touches those files at a time. If a live owner holds it, the command fails with a clear message; a lock older than 3x its TTL is treated as stale and taken over.
- **Slice lease** (`.discipline/locks/slice-<id>.lock`): enforces One Writer Per Slice across processes. `npm run discipline:lease -- acquire|release|status <slice-id> [--force]`. Acquire is atomic; release only removes a lease this process owns (or with `--force`).
- **Kill switch** (`.discipline/STOP`): create this file to pause the watcher. It skips each queued packet with a warning (the packet stays in place) without killing the process. Delete the file to resume.
- **Machine-readable gate** (`npm run discipline:gate:report`, or `discipline gate --json`): re-runs the gate's own steps (parsed from the `gate` script) and writes `.discipline/gate-report.json` (`schema: discipline.gate_report.v1`) with per-step exit codes, durations, `failed_checks`, and an `error_signature`. Exit code is 0 iff every step passed. Plain `npm run gate` is unchanged.
- **Ledger** (`.discipline/ledger/YYYY-MM.jsonl`): append-only JSONL of pipeline events (`patch_applied`, `gate_result`). `error_signature` normalizes away paths, line numbers, and timestamps, which makes the Repair Budget rule (two identical signatures with no material change -> stop) computable.
- **Diff review** (`npm run discipline:review [-- --staged] [--open]`): renders `git diff` to one self-contained, fully HTML-escaped file under `.discipline/review/<timestamp>.html` for slice review. An empty diff writes nothing.
- **Providers preflight** (`npm run discipline:doctor:providers`, or `discipline:doctor --providers`): advisory checks for Node/git, the agent CLIs (claude/codex/gemini/cursor-agent), OneDrive placement, long-path risk, and Windows helpers. Informational only; it never fails the exit code by itself. Add `--json` to dump the findings.
- **Packet frontmatter** (optional): a packet MAY start with a `---` YAML block (`schema`, `version`, `id`, `status`, optional `slice` / `produced_by`). `discipline:validate` reports invalid frontmatter as warnings only; packets without it are legacy and fine. The markdown body remains canonical.

## Policy hooks and checkpoints (opt-in)

Local mechanisms that make the doctrine self-enforcing. Both are **opt-in by decision (v1.2)**: hooks add per-tool-call latency and can be noisy, so they ship as an example to copy, never enabled by default. The manual flow keeps working unchanged.

- **Policy hooks** (`tools/discipline/hooks/`, wired via `.claude/settings.hooks.example.json`): three plain-Node Claude Code hooks. `pre-tool-guard.mjs` (`PreToolUse`) **denies** `rm -rf` / `rd /s`, `git push --force`/`-f`, `git reset --hard`, `git config` mutations, `curl|wget | sh`, and any read/edit/write of `.env` / `.env.*`; it **asks** (forces the human prompt even in accept-edits mode) for edits to `supabase/migrations/**`, `.github/workflows/**`, `vercel.json`, `package.json`, and `*.rules`, and for `npm install`/`i`/`add`. `stop-gate.mjs` (`Stop`) blocks ending a session that has edited code while `.discipline/gate-report.json` is missing, stale, or failing (single nudge; run `npm run discipline -- gate --json` and respect the Repair Budget). `session-start-header.mjs` (`SessionStart`) injects the FIXED HEADER of `progress.md` as context. To enable, merge the example into `.claude/settings.json`; to disable, remove the `hooks` key. See `tools/discipline/hooks/README.md`. Rationale: policy as mechanism, opt-in by decision.
- **Checkpoints** (`npm run discipline:checkpoint`, or `discipline checkpoint|approve|reject`): approval packets that make a human decision a git-auditable artifact. `checkpoint create --slice <id> --kind pre-commit|scope|deploy [--summary "..."]` writes `.discipline/packets/CHECKPOINT_<KIND>_<slice>_<ts>.md` (frontmatter `status: ready-for-human`) with Summary, Gate (from the latest gate report), Diff (`git diff --stat HEAD`), and a `PENDING` Decision. `approve <packet-file-or-id>` / `reject <..> [--reason "..."]` rewrite the status and fill the Decision; approve refuses unless the status is still `ready-for-human`. Both hold the writer lock and append a `checkpoint_created` / `checkpoint_decided` ledger event.

## Headless runs (autonomy L0-L3)

`discipline run` is a **stateless single-tick reconciler**: one command advances one slice by one tick, then stops. No daemon, no residual state (the files are the state). It reuses the whole substrate and control plane above (assemble, adapters, patch engine, gate report, checkpoints, diff review, locks, ledger). The manual flow keeps working unchanged; headless execution is opt-in.

The autonomy ladder (ceiling configured in discipline.md; invocation flags can only **lower** it, never raise it):

| Level | Name | What runs |
|---|---|---|
| L0 | Manual | Human pastes; tooling only assembles/transports. `discipline run` prints where the paste-ready lives and exits. |
| L1 | Plumbing | `discipline run` assembles the slice paste-ready and exits (patch/progress/assemble automation). No LLM. |
| L2 | Step-confirmed | One headless builder step per tick, with a y/N confirmation before the spawn and a diff review after. |
| L3 | Slice run | Full slice: build -> plumb -> gate -> repair (within budget) -> advisory cross-validation -> **stop before commit** for human review. |
| L4 | GitHub lane only | Unattended, on a remote machine, PR as the review artifact, §7 protected by branch protection. **Never local** (see the GitHub lane section below). |

The ceiling and providers are read from an OPTIONAL `## Autonomy` section in `discipline.md` (not shipped by default; add it only if you want headless runs). Keys are a simple `- key: value` list:

```
## Autonomy
- level: 3
- builder: claude
- validator: gemini
- repair_max: 2
- per_run_usd: 0.50
```

Defaults when the section (or a key) is absent: `level 1`, `builder claude`, `validator gemini`, `repair_max 2`, no cost cap. Malformed values fall back to defaults with a warning. The **validator family must differ from the builder family**; if they collide, a family-different validator is chosen deterministically (gemini -> codex -> claude).

Usage and exit codes:

```
discipline run --slice <id> [--autonomy 0..3] [--dry-run] [--yes] [--allow-dirty] [--no-open] [--timeout-min N]
discipline run --with-llm --provider claude|codex|gemini|cursor --slice <id>   # --provider overrides the builder
discipline cross-validate --with-llm [--provider X]                            # advisory review of the current diff only
```

- **0** green (gate passed, stopped before commit) - **2** config/precondition error (STOP switch, dirty tree without `--allow-dirty`, unknown/not-ready slice, missing `STEP_5_SLICE_PACKET`, bad provider) - **3** parked (rate limit / auth / CLI not found; **never** consumes the repair budget) - **4** stopped by the repair budget (two identical error signatures, or attempts exhausted).

Preconditions for level >=2: a clean working tree (else `--allow-dirty`), the slice present and `ready` in `task_plan.md` §Ready Slices, and a `STEP_5_SLICE_PACKET` for the slice under `.discipline/packets/`. The run takes the slice lease, writes a pre-run tag `disc/run-<id>-pre` (rollback: `git reset --hard <tag>`), logs `run_started` before any spawn, and releases the lease on exit.

**RUN CONTRACT** (appended to the builder prompt): implement ONLY this slice; obey discipline.md contracts; write code + tests; emit patch blocks and a `SLICE_COMPLETION_PACKET` under `.discipline/packets/`; do **not** `git commit`; do **not** touch `.env*`, workflows, or migrations without saying so in the packet; keep the diff under ~500 lines. A terminal run ALWAYS stops before commit: it writes a `pre-commit` checkpoint + a self-contained diff HTML for review, then prints NEXT STEPS (review diff, `discipline approve <checkpoint>`, commit, rollback).

**Crash recovery = re-run.** There is no recovery state to repair: the files are the checkpoint and the ledger records intent before each action. If a prior run crashed (a `run_started` with no `run_finished`) and its lease is stale, `discipline run` warns and continues fresh.

## GitHub lane (L4: unattended slice runs)

The ONLY home for unattended autonomy is a remote runner with a pull request as the review artifact. One blessed path ships with this template:

1. **Gate as the arbiter:** `.github/workflows/ci.yml` already runs `npm run gate` on every push and PR. In your repo settings, make the CI `gate` job a **required status check** on `main` (branch protection or a ruleset).
2. **Protect the never-auto-approve paths:** require review (CODEOWNERS or a ruleset) for `.env*`, `supabase/migrations/**`, and `.github/workflows/**`. That way GitHub enforces the list, not a prompt.
3. **The example workflow:** copy `.github/workflow-examples/agent-slice.yml` into `.github/workflows/`, add the `ANTHROPIC_API_KEY` secret, then label an issue `slice-ready` naming ONE ready slice. The agent implements it on branch `disc/slice-<id>` and opens a PR. You review the PR; the merge is yours.
4. **One writer per slice, cross-machine:** mark the slice `in-progress-cloud` in `task_plan.md` when you hand it to the lane. `discipline run` refuses slices that are not `ready`, so local and cloud never collide; the workflow's `concurrency` group also serializes runs per issue.

Equivalent patterns (same shape, not shipped): Codex cloud / `@codex` review on the PR, or the GitHub Copilot coding agent assigned to the issue. Cloud runs write the four state files through the same patch engine (packets and patch blocks inside the PR), never directly.

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

1. **Plan:** Read `STEP_5_SLICE_PACKET` from `.discipline/packets/` and review `discipline.md` contracts. Acquire the slice lease (`npm run discipline -- lease acquire <id>`) here and release it after the completion packet (`npm run discipline -- lease release <id>`).
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
