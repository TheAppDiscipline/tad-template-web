---
name: discipline-step7
description: "Automate Discipline Loop Step 7: turn a product decision into a hardening backlog with the PROD_HARDENING_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step7, 'run step 7', 'harden for production', or 'evolve into a product'."
---

# /discipline-step7 - Automate Step 7 of the Discipline Loop pipeline

This skill runs the full Step 7: it analyzes real-usage feedback, decides which hardening areas to activate, turns them into concrete slices, produces the PROD_HARDENING_PACKET, emits patch blocks (including PROFILE: PROD), and leaves the paste-readies ready to expand hardening in Step 4.

No external tools required. Claude generates everything directly using Extended Thinking.

## What the user sees

1. The skill checks that no unrelated patches are pending, and stops if there are (preflight)
2. It verifies that the Step 6 inputs exist
3. It asks for confirmation of the product decision (if it is not explicit)
4. It runs 5 outputs sequentially with deep reasoning
5. It applies patch blocks to the repo and assembles paste-readies
6. It reports progress and shows a summary with the next step

## Prerequisites

- Step 6 completed (`POST_DEPLOY_FEEDBACK_PACKET` in `.discipline/packets/`)
- An explicit decision to take the app to product (sell it or open it to the public)
- Node.js + npm (to run the Discipline Loop scripts)
- `.discipline/patches/pending/` empty (the skill verifies this and stops if not)
- **Required role: Premium Reliable - Critical Decisions** with the strongest reasoning available. Hardening decisions are architectural. Do not close them out with mechanical roles, free tiers, or Frontier-Budget without a Premium review.

---

## Internal implementation

### Preflight: pending patches

Before reading inputs, before reasoning, before writing anything: list `.discipline/patches/pending/*.md`.

If no `.md` file is there, continue. If ANY file is there, STOP.

A non-empty `pending/` on entry is an anomaly, not a handoff. This step applies its own blocks before it finishes, so whatever is still sitting there is the residue of an earlier run that was interrupted between writing its blocks and applying them. That residue deserves a review, not a bulk apply.

Show what is there, with each file's routing header, so the risk is visible before the operator decides (a `replace_section` leftover overwrites a whole section of a state file; an `append` one only adds lines):

```
There are pending patches from earlier work:
- <file>: TARGET_FILE <target> | PATCH_MODE <mode> | ANCHOR <anchor>
- ...

`npm run discipline:patch` applies EVERYTHING in pending/, so running this step now would apply that
unrelated work together with this step's own blocks, in the same silent operation. Resolve them
first, then re-run this step:

- read them, and if they still hold, apply them consciously with `npm run discipline:patch`; or
- move them out of pending/ (for example into `.discipline/patches/parked/`) to park them without
  applying them. Do not delete them: they are your evidence. Note that parking also takes them out
  of the pending count in `npm run discipline:validate`, so nothing else will remind you.
```

Do not read inputs, do not create files, do not offer to resolve it from inside the skill.

**Why this stops instead of asking for confirmation.** `discipline:patch` has no per-file selection: it applies the whole directory or nothing. A confirmation prompt would not give the operator control over that, it would only move an unreviewed old patch one keystroke closer to being applied, inside a run whose summary would then present it as this step's work. Pending work is resolved deliberately, outside the skill, with the files in front of you; then the step is re-run against an empty `pending/`. That a producer step legitimately writes to `pending/` is exactly why it must not inherit anything there: from Phase 0 on, every phase assumes `pending/` holds only what this run wrote. Same contract as `/discipline-feedback-intake`.

### Phase 0: Verify inputs and the product decision

**Show the model warning:**

```
⚠️ This step requires the Premium Reliable - Critical Decisions role.
Check the current concrete model on your provider's official models page (map the role via the model-selection guide in the vault).
Do not use mechanical roles, free tiers, or Frontier-Budget without a Premium review for this step.
```

**Verify the required inputs:**

Read these files. If a required one is missing, stop with a clear message.

**Required:**
1. `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md`

If it is missing:
```
The POST_DEPLOY_FEEDBACK_PACKET is missing. Run /discipline-step6 first.
Hardening must be based on real-usage feedback, not on assumptions.
```

**Project context (always read):**
2. `discipline.md`
3. `task_plan.md`
4. `findings.md`
5. `progress.md`

**Optional (read if present):**
6. `.discipline/paste-ready/step-7-input.md` (preferred, already assembled)
7. `.discipline/packets/STEP_4_EXECUTION_PACKET.md`
8. `.discipline/packets/DEPLOY_READINESS_PACKET.md`
9. `.discipline/step2-outputs/Step2_02_Permissions_Security.md`

**Verify the path decision.** Step 7 offers **3 paths** (see the "Step 7 - Evolving into a Product" note in The App Discipline vault, sold separately). Look for an explicit decision in `POST_DEPLOY_FEEDBACK_PACKET` or `step-7-input.md`. If there is none, ask:

```
Step 7 offers 3 paths. Which do you choose?

A) Keep it as is
   - The app works, you do not need to scale, you are not selling.
   - Stay on PROFILE=LITE or SHARED_SYNC.
   - Maintenance runbook: the solo-maintenance runbook in the vault (sold separately).
   - No hardening applies. This skill stops here.

B) Scale within the vault
   - You are going to sell small (Gate C indie, up to ~500 paying users) or open to the public.
   - Apply hardening PROFILE=LAUNCH or PROD.
   - This skill continues with feedback analysis and the area decision.

C) Leave the vault
   - Your case grew beyond the Discipline Loop scope (>500 paying users, enterprise SaaS,
     regulated compliance, complex real-time collaboration).
   - See the guide-limits note (§3) in the vault (sold separately) for alternative resources.
   - This skill stops here; it does not apply Discipline Loop hardening to that scope.

Which do you choose? (A/B/C)
```

**If A or C:** stop with a clear message and a link to the corresponding note. Do not generate a hardening packet.

**If B:** continue with Phase 1. Record the trigger in the packet ("Reason for activating hardening: <reason>").

Do not continue without an explicit decision.

### Phase 1: Generate the 5 outputs

Use Extended Thinking for each output. The context includes every file read in Phase 0 and every output already generated.

**Output 1: Feedback analysis** (`Step7_01_Feedback_Analysis.md`)

Analyze the `POST_DEPLOY_FEEDBACK_PACKET` and produce:

1. Positive signals: what works well, what users validate, what generates satisfaction
2. Real friction: bugs, confusing UX, broken flows, frequent errors
3. Observed risks: security, performance, data, dependencies
4. Business signals: demand, willingness to pay, competition, urgency
5. Mapping to hardening areas: for each signal, indicate which of the 10 areas applies

The 10 areas are:
- 0: Data migration and compatibility
- 1: Auth hardening
- 2: Permissions and audit
- 3: Observability
- 4: Rate limiting
- 5: Billing
- 6: Legal and compliance
- 7: Testing
- 8: Deploy CI/CD
- 9: AI hardening (only if AI_FEATURES=enabled)

Save to: `.discipline/step7-outputs/Step7_01_Feedback_Analysis.md`
Report: `✓ Output 1/5: Feedback analysis`

**Output 2: Hardening decision** (`Step7_02_Hardening_Decision.md`)

For each of the 10 areas, decide:

| Area | Decision | Phase | Justification |
|---|---|---|---|
| 0: Migration | ACTIVATE / SKIP / DEFER | PROD-1/2/3 | evidence from the feedback |
| 1: Auth | ACTIVATE / SKIP / DEFER | PROD-1/2/3 | evidence from the feedback |
| ... | ... | ... | ... |

Decision criteria:
- **ACTIVATE**: there is real evidence of need (feedback, an observed risk, a legal requirement)
- **SKIP**: there is no evidence and it is not a requirement for this type of product
- **DEFER**: there are indications but it is not urgent; document a trigger to reevaluate

Phase assignment:
- **PROD-1** (minimum to launch): auth hardening, permissions audit, basic observability, CI/CD
- **PROD-2** (first users): rate limits, e2e testing, billing if you charge, minimal analytics
- **PROD-3** (scale): load testing, cost tracking, advanced analytics, deep security audit

Save to: `.discipline/step7-outputs/Step7_02_Hardening_Decision.md`
Report: `✓ Output 2/5: Hardening decision (<N> areas activated)`

**Output 3: Hardening slices** (`Step7_03_Hardening_Slices.md`)

For each ACTIVATED area, generate 1-3 concrete slices:

```markdown
## Area <N>: <name>
### Phase: PROD-<1/2/3>

#### Slice H-<N>.1: <slice name>
- Goal: <what it achieves>
- Scope IN: <what gets built>
- Scope OUT: <what does not>
- Contracts touched: <tables, endpoints, configs>
- Complexity: S / M / L
- Dependencies: <prior slices needed>

#### Slice H-<N>.2: <name>
...
```

Order the slices by phase, and within each phase by dependencies.

Save to: `.discipline/step7-outputs/Step7_03_Hardening_Slices.md`
Report: `✓ Output 3/5: Hardening slices (<N> slices across <M> phases)`

**Output 4: PROD_HARDENING_PACKET**

Assemble the canonical packet with these sections:

```markdown
# PROD_HARDENING_PACKET

STATUS: ready
SOURCE_STEP: Step 7
GENERATED: <date>

## Target phase
PROD-<1/2/3> (the immediate phase to implement)

## Rationale from feedback
<summary of the signals that justify the hardening>

## Hardening domains
| Area | Decision | Phase | Slices |
|---|---|---|---|
<table of the 10 areas with their decision>

## Mandatory slices (current phase)
<list of slices that go in now, ordered by dependency>

## Deferred items
<areas and slices that were postponed, with their reevaluation trigger>

## Lane impact
<changes specific to the project's LANE>

## Gates to add
<additional gates that PROD requires: e2e, security review, load test>

## SOPs to activate
<vault SOPs that now apply: Security SOP, Testing SOP, etc.>
```

Save to: `.discipline/packets/PROD_HARDENING_PACKET.md`
Report: `✓ Output 4/5: PROD_HARDENING_PACKET`

**Output 5: Patch blocks**

Generate the 3 blocks:

1. **DISCIPLINE_MD_PATCH_BLOCK** — change PROFILE to PROD and update the relevant sections:

```markdown
## DISCIPLINE_MD_PATCH_BLOCK - Step 7 profile change

TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: ## 0) Profile

### CONTENT
PROFILE: PROD
<rest of the switches unchanged>
```

**`replace_section` keeps the anchor heading and replaces only what follows it.** Never repeat the heading inside `### CONTENT`: that would leave the heading twice, and a duplicate anchor makes every later patch to that section fail with "Duplicate anchor". The content you write is the section body, starting at its first line after the heading, and it must carry over every switch you are not changing.

If the hardening adds new gates, rate limits, or contracts, generate additional patches for the corresponding sections of discipline.md.

2. **TASK_PLAN_PATCH_BLOCK** — add hardening slices to Ready Slices:

```markdown
## TASK_PLAN_PATCH_BLOCK - Step 7 hardening slices

TARGET_FILE: task_plan.md
PATCH_MODE: replace_section
ANCHOR: ## 4) Ready Slices

### CONTENT
### Hardening - PROD-<phase>

| # | Slice | Complexity | Dependencies | Status |
|---|---|---|---|---|
| H-0.1 | <name> | M | none | ready |
| H-1.1 | <name> | M | H-0.1 | ready |
...
```

3. **FINDINGS_APPEND_BLOCK** — document the decisions:

```markdown
## FINDINGS_APPEND_BLOCK - Step 7 hardening decision

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Decisions

### CONTENT
- <date> · Step 7 hardening decision:
  - Activated: <area>, <justification>
  - Deferred: <area>, <trigger to reevaluate>
  - Skipped: <area>, <why it does not apply>
  - Accepted risks: <risk that is consciously accepted>
```

Use dated list entries only, never headings inside the content: the anchors of `findings.md` are headings, and appending a heading would corrupt the section structure.

Save to: `.discipline/patches/pending/`, one file per block, named `<BLOCK_NAME>_step7_<YYYY-MM-DD-HHMMSS>.md` with this run's timestamp. The stamp is what makes the name unique: without it, a second run (or a retry after a failure) silently overwrites the pending patch of an earlier one.
Report: `✓ Output 5/5: Patch blocks`

### Phase 2: Post-processing

Apply pending patches:
```bash
npm run discipline:patch
```

Assemble the paste-ready for hardening in Step 4:
```bash
npm run discipline:assemble -- --step 4-hardening
```

Record it in the run-log:
```bash
npm run discipline:log -- --step 7 --tool "Claude Extended Thinking" --notes "Automated via /discipline-step7"
```

### Phase 3: Summary and next step

Show the user:

```
Step 7 completed.

Decision: PROFILE changed to PROD

Activated areas:
<list with assigned phase>

Deferred areas:
<list with trigger>

Hardening slices generated: <N>
- PROD-1: <N> slices
- PROD-2: <N> slices
- PROD-3: <N> slices

Files generated:
- .discipline/step7-outputs/ (3 analyses)
- .discipline/packets/PROD_HARDENING_PACKET.md
- Patch blocks applied: 3

Paste-readies ready:
- .discipline/paste-ready/step-4-hardening.md

Next step: /discipline-step4 to expand the hardening slices
```

---

## Error handling

- If the preflight finds pending patches: stop before reading inputs. Never apply work this run did not produce as a side effect of running this step.
- If `POST_DEPLOY_FEEDBACK_PACKET` does not exist: stop with "Run /discipline-step6 first."
- If the user has no product decision: stop with clear options (stay on SHARED_SYNC, gather more feedback, etc.)
- If `npm run discipline:patch` fails: report the error and continue with the assembly. The patch blocks are in `.discipline/patches/pending/` for manual application.
- If `npm run discipline:assemble` fails: report which files were missing. The PROD_HARDENING_PACKET is already in `.discipline/packets/`.
- If `npm run discipline:log` fails: report it but do not block.
- If the feedback does not have enough evidence to decide areas: document the uncertainty in findings.md and recommend more real usage before hardening.

---

## Critical rules

- Never run `discipline:patch` if `pending/` contained files before this run. The command applies everything in the directory with no per-file selection; the preflight is the only guard.
- Use Extended Thinking for all outputs. Hardening decisions are architectural.
- Do not activate areas without real evidence from the feedback. "Just in case" is not a justification.
- Do not harden everything at once. Assign PROD-1/2/3 phases and start with only the immediate phase.
- Every activated area must be turned into concrete slices with scope, contracts, and DoD.
- Hardening slices enter the normal pipeline (Step 4 -> Step 5). They are not shortcuts outside the system.
- Do not invent billing, legal, or compliance requirements that the user has not mentioned.
- The DISCIPLINE_MD_PATCH_BLOCK must change PROFILE to PROD. This is not optional once hardening is activated.
- Patch blocks must be exact and pasteable, not narrative suggestions.
- If AI_FEATURES=none, skip Area 9 (AI hardening) entirely.
