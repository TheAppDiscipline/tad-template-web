---
name: discipline-step2
description: "Automate Discipline Loop Step 2: validate the architecture with extended thinking, produce a validated STEP_4_EXECUTION_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step2, 'run step 2', 'validate architecture', or 'choose provider'."
---

# /discipline-step2 - Automate Step 2 of the Discipline Loop pipeline

This skill runs all of Step 2: it validates the MVP architecture, produces the STEP_4_EXECUTION_PACKET with STATUS: validated, emits patch blocks for the repo files, and leaves the paste-readies ready for the following steps.

No external tools required. Claude generates everything directly using Extended Thinking.

## What the user sees

1. The skill verifies that the Step 1 inputs exist
2. It runs 6 outputs sequentially with deep reasoning
3. It applies patch blocks to the repo and assembles the paste-readies
4. It reports progress and shows a summary with the next step

## Prerequisites

- Step 1 completed (packets in `.discipline/packets/`)
- `STEP_2_ARCHITECTURE_PACKET.md` must exist in `.discipline/packets/`
- `STEP_4_EXECUTION_PACKET.draft.md` must exist in `.discipline/packets/`
- Node.js + npm (to run the Discipline Loop scripts)
- **Required role: Premium Reliable - Critical Decisions** with the strongest reasoning available. Resolve the concrete current model on your provider's official models/pricing page; the model-selection guide in The App Discipline vault (sold separately) maps this role to what to look for. You may use Frontier-Budget only for an early draft; locking the architecture requires Premium.

---

## Internal implementation

### Phase 0: Verify inputs and model

**Before verifying files, show this warning to the operator:**

```
⚠️ This step requires the Premium Reliable - Critical Decisions role.
Check the concrete current model on your provider's official models page (map the role via the model-selection guide in the vault) before locking the architecture.
Do not use mechanical roles, free tiers, or Frontier-Budget without a Premium review for this lock.
```

Continue only after showing the warning.

Read the contents of these files. If any required file is missing, stop with a clear message.

**Required:**
1. `.discipline/packets/STEP_2_ARCHITECTURE_PACKET.md`
2. `.discipline/packets/STEP_4_EXECUTION_PACKET.draft.md`

If any is missing:
```
Step 1 inputs are missing. Run /discipline-step1 first.
Missing: <list of missing files>
```

**Optional (read if present):**
3. `.discipline/step1-outputs/03_PRD.md`
4. `.discipline/step1-outputs/04_User_Stories.md`
5. `.discipline/step1-outputs/05_Data_Model.md`
6. `.discipline/step1-outputs/08_Architecture_Switches.md`
7. `.discipline/step1-outputs/09_Export_for_DisciplineLoop.md`
8. `.discipline/step1-outputs/07_Events_and_Notifications.md`

**Project context (always read):**
9. `discipline.md`
10. `task_plan.md`
11. `findings.md`

**Starter code and templates (read when the selected backend uses them):**
12. The migration, rules, or persistence template for the selected backend.
13. The shared backend types and the implementation for the selected backend.
14. The existing tests or fixtures that create, read, or update the same data.

### Contract-to-scaffold check

Before producing permissions, migrations, or a `STATUS: validated` execution packet, compare
the proposed contracts with the starter files that already exist in the repository. This keeps
the plan aligned with the application people will actually build on.

For every table, collection, or shared data shape that the plan creates or changes, record:

- its physical name in the starter project;
- its final fields, including fields that will be removed;
- its access rules, timestamps, and automatic behaviors;
- the shared type or API shape that represents it; and
- the adapters, tests, or fixtures that must change with it.

If the plan differs from the starter project, Output 3 must state the exact final shape and the
exact delta from the starter. Output 6 must update the relevant project contracts and task plan.
Do not mark the architecture validated while it names a table or field that does not exist, or
while an adapter, type, or test still promises a different shape. Keeping the starter default is
always valid when it already meets the product contract; this check only makes deliberate
differences explicit.

### Phase 1: Generate the 6 outputs

Use Extended Thinking for each output. Include "think hard about this" internally to activate deep reasoning.

The context for each output includes:
- All files read in Phase 0
- All outputs already generated in this step

**Output 1: Core architecture** (`Step2_01_Architecture_Core.md`)

Analyze and produce:
1. Architecture validation: backend, auth mode, sync mode, collab mode. If something is wrong, recommend a change with justification.
2. Correct minimal architecture: component diagram (text), main surface per lane, backend, auth, sync.
3. Dependencies between slices: order, blockers, parallelizable ones.
4. What NOT to build in the MVP: premature features, unnecessary infra.

Save to: `.discipline/step2-outputs/Step2_01_Architecture_Core.md`
Report: `Output 1/6: Core architecture`

**Output 2: Permissions and security** (`Step2_02_Permissions_Security.md`)

Analyze and produce:
1. Permissions: sufficient roles, operations per role, RLS policies / security rules / minimal validations.
2. Data leak risks: cross-space scenarios, unfiltered queries, exposed endpoints.
3. Auth edge cases: expired link, multiple sessions, partial logout (skip if AUTH=NONE).
4. Minimal MVP security recommendations.

Save to: `.discipline/step2-outputs/Step2_02_Permissions_Security.md`
Report: `Output 2/6: Permissions and security`

**Output 3: Migrations and backend** (`Step2_03_Migrations_Backend.md`)

Analyze and produce:
1. Migrations: SQL if Supabase (starting from templates), collections if Firebase, local persistence if LOCAL_ONLY. Indexes, FKs, constraints.
2. Seed / bootstrap data: initial data, first user, initial space.
3. Data edge cases: orphans, cascades, soft deletes, LWW conflicts.
4. Critical queries: the 3-5 most frequent, needed indexes, complex joins.

Save to: `.discipline/step2-outputs/Step2_03_Migrations_Backend.md`
Report: `Output 3/6: Migrations and backend`

**Output 4: Risks and final decisions** (`Step2_04_Risks_Final.md`)

Analyze and produce:
1. Top 5 technical risks: what, probability, impact, mitigation.
2. Decisions to make now: the ones that would cost refactors if postponed.
3. Decisions to postpone: the ones that become clear after 2-3 slices.
4. Final slice validation: order, split, combine, correct bootstrap.
5. Executive summary: 10 lines max.
6. Hard-to-reverse decisions.

Save to: `.discipline/step2-outputs/Step2_04_Risks_Final.md`
Report: `Output 4/6: Risks and decisions`

**Output 5: Validated STEP_4_EXECUTION_PACKET**

Consolidate everything validated into the canonical format with 12 sections:
1. PRODUCT SUMMARY
2. MVP BOUNDARY
3. ARCHITECTURE LOCKS
4. DATA / ACCESS / SYNC CONTRACTS
5. SLICE DRAFT
6. SLICE ORDER / DEPENDENCIES
7. BOOTSTRAP REQUIREMENTS
8. PROVIDER IMPACT
9. AI SURFACE SUMMARY
10. INTERACTION SURFACE SUMMARY
11. RISKS / EDGE CASES
12. IMPLEMENTATION GUARDRAILS

Add `STATUS: validated` at the top.

Save to: `.discipline/packets/STEP_4_EXECUTION_PACKET.md`
Rename `.discipline/packets/STEP_4_EXECUTION_PACKET.draft.md` to `.discipline/packets/STEP_4_EXECUTION_PACKET.draft.superseded.md`
Report: `Output 5/6: STEP_4_EXECUTION_PACKET (validated)`

**Output 6: Repo patch blocks**

Generate the blocks that apply:

1. `DISCIPLINE_MD_PATCH_BLOCK` - only if switches, contracts, or operational rules changed
2. `TASK_PLAN_PATCH_BLOCK` - to reflect the real order, split, or combination of slices
3. `FINDINGS_APPEND_BLOCK` - to record decisions, accepted risks, and deferred ones

Each block must use TARGET_FILE, PATCH_MODE, ANCHOR, and CONTENT.

Save to: `.discipline/patches/pending/` (one file per block)
Report: `Output 6/6: Patch blocks`

### Phase 2: Post-processing

Apply pending patches:
```bash
npm run discipline:patch
```

Assemble paste-readies for the following steps:

```bash
npm run discipline:assemble -- --step 4
```

If `AI_FEATURES=enabled` in discipline.md:
```bash
npm run discipline:assemble -- --step 2.5
```

If LANE is neither BACKEND nor CLI (has UI):
```bash
npm run discipline:assemble -- --step 3
```

Record in the run-log:
```bash
npm run discipline:log -- --step 2 --tool "Claude Extended Thinking" --notes "Automated via /discipline-step2"
```

### Phase 3: Summary and next step

Show the user:

```
Step 2 complete.

Generated outputs:
- Step2_01_Architecture_Core.md
- Step2_02_Permissions_Security.md
- Step2_03_Migrations_Backend.md
- Step2_04_Risks_Final.md
- STEP_4_EXECUTION_PACKET.md (STATUS: validated)
- Patch blocks applied: <N>

Paste-readies ready:
- .discipline/paste-ready/step-4-input.md
<if applicable:>
- .discipline/paste-ready/step-2.5-input.md
- .discipline/paste-ready/step-3-input.md

Next step: <determine per config>
- If AI_FEATURES=enabled: /discipline-step2.5 or manual Step 2.5
- If there is UI (LANE != BACKEND, CLI): Step 3 (Stitch)
- Otherwise: Step 4 (executable slices)
```

---

## Error handling

- If `STEP_2_ARCHITECTURE_PACKET` does not exist: stop with "Run /discipline-step1 first."
- If `npm run discipline:patch` fails: report the error and continue with the assembly. The operator can apply patches manually.
- If `npm run discipline:assemble` fails: report which files were missing and suggest a review.
- If an output is inconsistent with the previous ones: fix it before continuing (same pattern as Output 8 of Step 1).

---

## Critical rules

- Use Extended Thinking for outputs 1-5. The value of this step is the deep reasoning.
- Do not invent business logic. If information is missing, document the assumption in findings.md.
- Do not change the lane or the stack without strong justification.
- Do not recommend premature optimization.
- Patch blocks must be exact and pasteable, not narrative suggestions.
- The validated STEP_4_EXECUTION_PACKET replaces any earlier draft version.
- A validated contract must agree with the relevant starter schema, shared types, adapters, and
  fixtures, or must name the exact changes that will bring them into agreement.
