---
name: discipline-step5-slice
description: "Close a Step 5 slice with the full Slice Loop: green gate, Repair Budget enforcement, SLICE_COMPLETION_PACKET emitted, run-log updated. Triggers on /discipline-step5-slice or 'close slice' / 'finish slice' / 'wrap up slice'."
---

# /discipline-step5-slice - Close a Step 5 slice following the Slice Loop

This skill orchestrates the formal close-out of an already-implemented slice: it runs the gate, applies the Repair Budget if it fails (max 3 attempts with model escalation), generates SLICE_COMPLETION_PACKET, records the run in run-log.md, and prepares the next paste-ready (step-4-reentry or step-6-input).

NOTE: Step 5 (implementation) is still iterative and manual in the daily driver. This skill does NOT implement the slice; it only closes it. If you need to write code, use the Claude Code CLI or Cursor directly.

## What the user sees

1. The skill verifies the slice's DoR (Definition of Ready in STEP_5_SLICE_PACKET).
2. Run `npm run gate` (or the lane variant).
3. If it fails, it applies the Repair Budget: 2 retries without escalating; a 3rd attempt (stronger model) only with a documented reason for why more reasoning could change the diagnosis; hard stop after that.
4. When the gate is green, it generates SLICE_COMPLETION_PACKET with all fields.
5. If the batch is ready to deploy, also DEPLOY_READINESS_PACKET.
6. Records the run in `.discipline/run-log.md`.
7. Generates the paste-ready for the next step.

## Prerequisites

- `STEP_5_SLICE_PACKET.md` exists in `.discipline/packets/` with a clear DoR.
- The slice code is already implemented (not this skill's job).
- `discipline.md`, `task_plan.md`, `findings.md`, `progress.md` are up to date.
- Repo with `.discipline/` and `discipline:*` scripts available.

---

## Internal implementation

### Phase 0: Verify DoR

Read `.discipline/packets/STEP_5_SLICE_PACKET.md`. Confirm:
- Goal defined
- Scope IN/OUT explicit
- Contracts (data model, API/IO, interaction surface)
- Verifiable acceptance criteria
- Risks / edge cases listed

If DoR is missing, abort:
```
DoR incomplete in STEP_5_SLICE_PACKET. Go back to /discipline-step4 to refine the spec before closing the slice.

Missing: <list of fields>
```

### Phase 1: Verify preconditions

- The slice lease is yours. Acquire it before touching any state (One Writer Per Slice as mechanism, not just doctrine):

```bash
npm run discipline:lease -- acquire <slice-id>
```

If the lease is already held by a live owner, STOP: another agent or session owns this slice. Do not double-write. Take it over only after a human confirms the other writer is gone (`npm run discipline:lease -- release <slice-id> --force` is a deliberate human action, never automatic).

- `.discipline/patches/pending/` is empty (if there are patches, apply them first with `npm run discipline:patch`).
- Repo changes match the slice's scope (check `git diff --stat`).
- Touched files are inside the slice's scope IN.

If patches are pending:
```bash
npm run discipline:patch
```

If scope drift is detected:
```
The diff includes files outside the slice's scope IN. Review:
<file list>

Options:
1. If they are legitimate, update STEP_5_SLICE_PACKET §Scope IN.
2. If it is drift, revert and keep the slice bounded.
```

### Phase 2: Run gate

Run the lane gate:
- Web/Desktop: `npm run gate`
- Mobile: `npm run gate` (lint + tsc + tests + checks)
- Extension: `npm run gate`

Capture the exit code and the full output.

If `AI_FEATURES=enabled` (read from discipline.md):
```bash
npm run ai:smoke
npm run ai:eval
```

### Phase 3: Repair Budget if the gate fails

**Policy (summary of NN 10 Repair Budget; full rule in `discipline.md` / the Discipline Loop reference §Group C in The App Discipline vault, sold separately):** 2 attempts with the same signature and no material change (evidence, context, hypothesis, or strategy) = early stop; **escalating the model enables a single third attempt only when you document in `progress.md §Open Errors` (or `run-log.md`) why more reasoning capacity could change the diagnosis** (it is not an automatic pass), which is what Attempt 3 below does; if the signature points to spec, architecture, data, or environment, go back to the producing step (Step 2/4); 3 failures of the same gate = hard stop, no exceptions.

**Attempt 1 (gate fails, first time):**
1. Analyze the error signature (TypeScript code, ESLint rule, test name).
2. Look for a direct fix in the common gate errors reference in the vault (sold separately).
3. If it matches, apply the fix manually (the user approves it).
4. Retry: `npm run gate`.

**Attempt 2 (same error or new one):**
1. Paste the full error + slice context to the current model.
2. Ask for a targeted fix without adding features or dependencies.
3. Retry.

**Attempt 3 (escalate the model, only with a documented reason):**
1. If the previous 2 attempts failed with the same signature, **first document in `progress.md §Open Errors` why more reasoning capacity could change the diagnosis** (if you cannot, the problem is spec/architecture/data/environment: stop and go back to the producing step). Then escalate from the current role to `Premium Reliable - Critical Decisions`, or turn on the strong reasoning mode of the current model.
2. Paste the error + attempted changes + why each one failed.
3. Retry.

**Hard stop after the 3rd failure:**
```
Repair Budget exhausted (3 failures with no new info).

Errors in order:
1. <signature 1>
2. <signature 2>
3. <signature 3>

Possible causes:
- Slice spec incomplete or contradictory, go back to /discipline-step4 with `step-4-reentry.md`.
- Architecture change needed, go back to /discipline-step2.
- Structural bug in deps, check `npm audit`.

Actions:
1. Document the 3 attempts and signatures in progress.md §Open Errors.
2. Decide: retry with new info, or escalate to Step 2/4.

Do NOT retry this skill until you have new info.
```

Record the repair budget used in SLICE_COMPLETION_PACKET (`REPAIR_BUDGET_USED: N/3`).

### Phase 4: Manual verification

A green gate does not guarantee the slice works from the user's side. Ask for manual verification:

```
Gate green. Manual verification is mandatory before closing the slice:

1. Happy path: does the main action work?
2. Failure path if applicable: is the error shown to the user without a crash?
3. If SHARED_SYNC, smoke test on 2 devices.
4. If the UI has loading/empty/error states, do they render correctly?

Confirm with "manual verification OK" when you are done, or report what failed.
```

If manual verification fails, do not close the slice. Go back to Phase 2 with new info.

### Phase 5: Generate SLICE_COMPLETION_PACKET

Write `.discipline/packets/SLICE_COMPLETION_PACKET.md` using the canonical structure from the vault (Step 5 - Implementation, the minimal SLICE_COMPLETION_PACKET structure, in The App Discipline vault, sold separately):

```markdown
## SLICE_COMPLETION_PACKET

### Slice
- <id and name>

### Outcome
- done | partial | blocked

### Scope delivered
- <what actually got implemented>

### Files touched
- <file 1>
- <file 2>

### Gates passed
- GATE_STATE: <replace with exactly one of: passed | failed | unverified>
- npm run gate: <evidence, e.g. 0 failures>
- <other smoke/evals as evidence>

### Manual verification
- happy path: OK
- failure path: OK / N/A
- devices: <list>

### Repair budget used
- N/3 (with error signatures if N>0)

### Open issues
- <none or list>

### Next recommendation
- <next slice or go back to another step>

### Deploy signal
- not_ready | ready_for_preview | ready_for_production_candidate
```

`### Outcome` and `### Gates passed` are mandatory: `discipline:progress` refuses a packet that omits either. The gate result is taken ONLY from the explicit `GATE_STATE:` declaration (exactly one of `passed | failed | unverified`); the rest of the section is human-readable evidence and is never parsed into a state. Without a single, exact `GATE_STATE:` line the gate is recorded as `unverified` (fail-closed), so free text like "the gate cannot pass yet" -- or evidence in any language (e.g. "sin red", "0 errores", "0 errors") -- is never misread as a pass OR a fail. Always replace the `GATE_STATE:` placeholder with the real value. The watcher auto-advances to the next step's handoff ONLY when `GATE_STATE: passed`; a `failed` or `unverified` gate is recorded but the pipeline waits for you.

### Phase 6: Deploy signal and possible outputs

If `Deploy signal != not_ready`, also generate `.discipline/packets/DEPLOY_READINESS_PACKET.md` using the vault structure (Step 5 - Implementation, the minimal DEPLOY_READINESS_PACKET structure, in the vault, sold separately).

If new info came up:
- `TASK_PLAN_PATCH_BLOCK` to reorder slices or add a new one.
- `FINDINGS_APPEND_BLOCK` for new risks/decisions.
- `DISCIPLINE_MD_PATCH_BLOCK` only if the constitution changes (rare).

### Phase 7: Update progress.md and run-log

```bash
npm run discipline:progress      # updates progress.md from SLICE_COMPLETION_PACKET
npm run discipline:log -- --step 5 --tool "/discipline-step5-slice" --notes "<slice id> closed, repair=<N>/3, deploy=<signal>"
npm run discipline:lease -- release <slice-id>   # close-out: frees One Writer Per Slice
```

If the watcher is running, these steps are automatic. If not, run them manually.

### Phase 8: Generate the next paste-ready

`discipline:assemble` requires an explicit `--step`. Pick it from the `Deploy signal` of the packet you just produced:

```bash
npm run discipline:assemble -- --step 4   # Deploy signal: not_ready (more slices to do -> step-4-reentry)
npm run discipline:assemble -- --step 6   # ready_for_preview | ready_for_production_candidate -> step-6-input
```

(The continuous watcher `npm run discipline:watch` applies this same rule automatically when a new packet lands; `discipline:watch --once` is only a health check that reports pending packets without processing them.)

Report to the user which paste-ready is ready and open the file.

### Phase 9: Summary

```
Step 5 slice closed.

Slice: <id>
Outcome: done | partial
Repair budget: <N>/3
Deploy signal: <signal>

Files generated:
- SLICE_COMPLETION_PACKET.md
- DEPLOY_READINESS_PACKET.md (if applicable)

Next: <paste `paste-ready/step-X-input.md` into /discipline-stepX or continue the loop with /discipline-step4>
```

---

## Error handling

- If STEP_5_SLICE_PACKET does not exist: abort and redirect to /discipline-step4.
- If patches are pending and `discipline:patch` fails: stop, report the conflict, redirect to the apply-patch-blocks guide in the vault (sold separately).
- If the gate fails with an error outside the 20 listed in 81a: apply the Repair Budget normally.
- If manual verification is reported as failed: update SLICE_COMPLETION_PACKET with `Outcome: partial` or `blocked` and leave the slice open for a new iteration.
- If the slice stays open (`partial` / `blocked` / Repair Budget stop): still release the slice lease before ending the session. The lease guards against concurrent writers, not the slice's status.

---

## Critical rules

- The Repair Budget does not relax: 3 attempts with no new info = hard stop.
- Manual verification is not optional. A green gate does not mean the slice is done.
- Do not touch code from ANOTHER slice while this one is running.
- Acquire the slice lease at the start and release it at the end, every time. Never work on a slice whose lease a live owner holds.
- Do not update `discipline.md` from this skill (that is Step 2).
- If 5+ open issues come up, the slice was probably poorly defined, go back to Step 4.
- The skill does not write the slice's code. It only closes it.
- Target time: 5-15 min to close an already-implemented slice.
