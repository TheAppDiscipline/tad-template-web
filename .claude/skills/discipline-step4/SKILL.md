---
name: discipline-step4
description: "Automate Discipline Loop Step 4: expand the validated STEP_4_EXECUTION_PACKET into executable slices with STEP_5_SLICE_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step4, 'run step 4', 'expand slices', or 'generate slice packet'."
---

# /discipline-step4 - Automate Step 4 of the Discipline Loop pipeline

This skill runs the full Step 4: it expands the slices from the validated STEP_4_EXECUTION_PACKET into executable slices with scope, contracts, acceptance criteria, and DoD, generates the STEP_5_SLICE_PACKET for the first ready slice, emits patch blocks, and leaves the paste-readies ready for Step 5.

## Execution policy (self-contained)

Read these optional keys from `discipline.md` §0 Profile. Defaults apply when they are absent:

- `STEP4_EXPANSION_MODE`: `batch` (default) expands the next 2–3 unblocked slices; `full` expands every slice in `STEP_4_EXECUTION_PACKET`.
- `READY_PROMOTION`: `per_packet` (default and the only supported value) means a slice becomes `ready` only when its own `STEP_5_SLICE_PACKET` exists and its dependencies are `done`.
- `DOCTRINE_VERSION`: informational compatibility marker; report its value when present.

Do not require the vault or any external path to apply this policy.
If `STEP4_EXPANSION_MODE` is not `batch|full`, or `READY_PROMOTION` is not `per_packet`, stop and ask the operator to correct `discipline.md`.

No external tools required. Claude generates everything directly.

## What the user sees

1. The skill checks that the STEP_4_EXECUTION_PACKET exists and has STATUS: validated
2. Reads all available packets and the project context
3. Expands each slice with detailed scope, contracts, acceptance criteria, and complexity
4. Generates the STEP_5_SLICE_PACKET for the first ready slice
5. Emits patch blocks for task_plan.md, discipline.md, and findings.md
6. Applies patches, assembles paste-readies, and reports a summary

## Prerequisites

- Step 2 completed (`STEP_4_EXECUTION_PACKET.md` with STATUS: validated)
- Node.js + npm (to run the Discipline Loop scripts)
- **Recommended role: Premium Reliable - Implementation or Premium Reliable - Mechanical Work.** Slice expansion is structured work that does not require Critical Decisions. Frontier-Budget - Implementation is also valid for simple slices as long as you keep gates and review. Current concrete model: resolve it on your provider's official models/pricing page, using the model-selection guide in The App Discipline vault (sold separately) to map the role.

---

## Internal implementation

### Phase 0: Verify inputs

Read the contents of these files. If the required one does not exist or is not validated, stop with a clear message.

**Required:**
1. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` - must exist AND have `STATUS: validated`

If it does not exist:
```
The STEP_4_EXECUTION_PACKET is missing. Run /discipline-step2 first.
Looked in: .discipline/packets/STEP_4_EXECUTION_PACKET.md
```

If it exists but does not have `STATUS: validated` (still a draft or has no STATUS):
```
The STEP_4_EXECUTION_PACKET is not validated (current STATUS: <status>).
Run /discipline-step2 to validate the architecture before expanding slices.
```

**Optional (read if they exist, they enrich the slices):**
2. `.discipline/packets/UI_HANDOFF_PACKET.md` - per-screen and per-state UI descriptions
3. `.discipline/packets/AI_IMPLEMENTATION_PACKET.md` - implementation details for AI features
4. `.discipline/packets/STEP_3_STITCH_PACKET.md` - screen flows and navigation
5. `.discipline/packets/STEP_2_ARCHITECTURE_PACKET.md` - original architecture context

**Project context (always read):**
6. `discipline.md` - switches, contracts, operating rules
7. `task_plan.md` - current slice plan and order
8. `findings.md` - documented decisions and risks
9. `progress.md` - if it exists, indicates which slice to run next

**Additional context (read if they exist):**
10. `.discipline/step1-outputs/05_Data_Model.md` - detailed data model
11. `.discipline/step1-outputs/04_User_Stories.md` - user stories for acceptance criteria
12. `.discipline/step2-outputs/Step2_01_Architecture_Core.md` - validated core architecture
13. `.discipline/step2-outputs/Step2_02_Permissions_Security.md` - permissions and security
14. `.discipline/step2-outputs/Step2_03_Migrations_Backend.md` - migrations and backend

### Reconcile the plan with the starter project

Before expanding a slice that touches stored data, permissions, or a backend adapter, read the
relevant starter migration or rules file, shared types, selected-provider adapter, and existing
tests or fixtures. Compare them with the validated contract.

For every difference, make the slice say exactly what changes: the physical name, fields,
timestamps or automatic behaviors, access rules, shared type, adapter, and tests. Put those
files in `Files to touch` and make the result verifiable. If the difference changes a product or
architecture decision that is not already resolved, stop and return it to Step 2; do not promote
the slice to `ready` by asking Step 5 to guess.

### Phase 1: Expand slices

**Context for the expansion:** Before expanding, Claude should keep in mind:
- The project switches and data contracts
- The validated architecture (components, dependencies, risks)
- The user stories and UI flows (if they exist)
- The slice order and dependencies defined in the STEP_4_EXECUTION_PACKET
- The risks documented in findings.md

**Read all available packets.** Build a mental map of the whole project before expanding.

**Determine the expansion set before writing:**
- `STEP4_EXPANSION_MODE=full`: select every slice listed in `STEP_4_EXECUTION_PACKET`.
- `STEP4_EXPANSION_MODE=batch` or absent: select the next 2–3 slices whose dependencies are not blocked, preserving execution order and any already `done` slices.

**For each selected slice:**

Expand it with the following detail:

1. **Goal**: One sentence describing what this slice achieves. It must be verifiable (you can demonstrate that it works).

2. **Scope IN**: An explicit list of what IS built in this slice:
   - Files to create or modify
   - Components, hooks, utilities
   - Endpoints or queries
   - Migrations or schema changes
   - Minimum tests

3. **Scope OUT**: An explicit list of what is NOT built in this slice (but could be mistaken for something that is):
   - Related features that belong in another slice
   - Optimizations that are not needed yet
   - Edge cases resolved later

4. **Contracts touched**: Which data contracts from the STEP_4_EXECUTION_PACKET are used or implemented in this slice:
   - Tables / collections affected
   - Endpoints consumed or created
   - Types / interfaces defined
   - RLS policies or security rules applied

5. **UI states affected**: If there is a UI_HANDOFF_PACKET, list which screens and states are implemented in this slice. If there is no UI, put "N/A (LANE without UI)" or "N/A (backend slice)".

6. **Acceptance criteria**: A checkbox-format list of verifiable criteria:
   ```
   - [ ] The user can <specific action>
   - [ ] Data is persisted in <where>
   - [ ] State <X> shows <Y>
   - [ ] Error handling: if <condition>, the user sees <message>
   ```
   Minimum 3 criteria, maximum 8. Each one must be verifiable manually or with a test.

7. **Definition of Done (DoD)**: Technical conditions for considering the slice complete:
   - Code committed and free of lint errors
   - Tests passing (if applicable to the slice)
   - UI states implemented (normal + at least 1 more)
   - No critical TODOs left pending
   - Documented in progress.md

8. **Dependencies**: Which slices must be complete before starting this one. If it is the first slice (bootstrap), it has no dependencies.

9. **Complexity estimate**: S (< 1 hour), M (1-3 hours), L (3-8 hours). Based on:
   - S: One new file, a localized change, no new integrations
   - M: Several files, one new integration, moderate logic
   - L: Multiple files, several integrations, complex logic or edge cases

10. **Provider impact**: State which backend, hosting, authentication, or other provider
    configuration the slice uses or changes. Write `None` when there is no provider impact.

11. **Files to touch**: List the planned files and whether each is new or modified. Include
    migrations, shared types, adapters, tests, and fixtures when the slice changes a data
    contract.

12. **Gates**: Name the automated checks that must pass for this slice, including the project
    gate and any relevant backend or security check.

13. **Manual verification**: Give the shortest real-world check that proves the slice works.
    Include a failure or access-boundary check when the slice touches data or permissions.

**Determine execution order.** Based on the dependencies:
- Slice 0 is always bootstrap (setup, config, schema, seed data)
- Slices without dependencies can be parallelized (document which ones)
- Slices with dependencies follow the graph order

**Generate READY_SLICES_BLOCK.** Assemble all the expanded slices into a single block with a consistent format:

```markdown
# READY_SLICES_BLOCK

Total slices: <N>
Complexity breakdown: <X>S / <Y>M / <Z>L
Estimated total: <sum of estimates>

## Execution Order
1. Slice 0: <name> [S/M/L] - bootstrap
2. Slice 1: <name> [S/M/L] - depends on: 0
3. Slice 2: <name> [S/M/L] - depends on: 0 (parallelizable with 1)
...

---

## Slice 0: <name>
### Goal
...
### Scope IN
...
### Scope OUT
...
### Contracts touched
...
### UI states affected
...
### Acceptance criteria
...
### DoD
...
### Dependencies
...
### Complexity
...
### Provider impact
...
### Files to touch
...
### Gates
...
### Manual verification
...

---

## Slice 1: <name>
...
```

Save to: `.discipline/step4-outputs/READY_SLICES_BLOCK.md`
Report progress per slice: `Slice N/M expanded: <name> [complexity]`

### Phase 2: Generate STEP_5_SLICE_PACKET

**Determine which slice goes first.** Selection criteria:
1. If `progress.md` exists and indicates a specific slice as next, use that one
2. Otherwise, use the first slice in the execution order (typically Slice 0 / bootstrap)

**For the selected slice, assemble the full implementation context:**

```markdown
# STEP_5_SLICE_PACKET

SLICE: <number and name>
COMPLEXITY: <S/M/L>
STATUS: ready

---

## Goal
<slice goal>

## Scope
### IN
<detailed scope IN>

### OUT
<detailed scope OUT>

## Contracts
<relevant data contracts, copied from the STEP_4_EXECUTION_PACKET in full detail>
<include types/interfaces, table schemas, endpoints with request/response>

## UI Reference
<if there is a UI_HANDOFF_PACKET: copy the sections for the screens affected by this slice>
<include all 4 states of each affected screen>
<if there is no UI: "N/A">

## AI Implementation Reference
<if there is an AI_IMPLEMENTATION_PACKET and the slice touches AI features: copy the relevant sections>
<if not: "N/A">

## Acceptance Criteria
<acceptance criteria in checkbox format>

## DoD
<definition of done>

## Provider Impact
<provider configuration used or changed; write "None" when there is no impact>

## Files To Touch
<new and modified files, including contract-related types, adapters, tests, and fixtures>

## Gates
<automated checks required before this slice is complete>

## Manual Verification
<short happy-path and failure or access-boundary check>

## Architecture Context
<relevant extract from the STEP_4_EXECUTION_PACKET: locks, guardrails, decisions that affect this slice>

## Known Risks
<risks from findings.md that apply to this slice>

## Implementation Hints
<slice-specific hints based on the architecture analysis:>
<- which pattern to use (e.g. server actions, API routes, RPC)>
<- which repo templates to leverage>
<- what to avoid (anti-patterns documented in guardrails)>
```

Save to: `.discipline/packets/STEP_5_SLICE_PACKET.md`
Report: `STEP_5_SLICE_PACKET generated for Slice <N>: <name>`

### Phase 3: Generate patch blocks

**Evaluate which repo files need updating and generate the corresponding blocks.**

**1. TASK_PLAN_PATCH_BLOCK** (always generated):

Update the Ready Slices section of `task_plan.md` with the expanded slices. Format:

```markdown
TARGET_FILE: task_plan.md
PATCH_MODE: replace_section
ANCHOR: ## Ready Slices

CONTENT:
## Ready Slices

| # | Slice | Complexity | Dependencies | Status |
|---|---|---|---|---|
| 0 | <name> | S/M/L | none | ready |
| 1 | <name> | S/M/L | 0 | planned (awaiting its own STEP_5_SLICE_PACKET) |
| 2 | <name> | S/M/L | 0 | planned (awaiting its own STEP_5_SLICE_PACKET) |
...
```

Only the selected slice with an emitted packet and satisfied dependencies may be `ready`. Preserve slices already marked `done`; detailed expansion alone never promotes a slice.

Save to: `.discipline/patches/pending/TASK_PLAN_PATCH_BLOCK.md`

**2. DISCIPLINE_MD_PATCH_BLOCK** (only if contracts need updating):

If during slice expansion you identified contracts that need refinement (e.g. a missing field, an undocumented endpoint, an incomplete type), generate the patch:

```markdown
TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: <specific section to update>

CONTENT:
<updated content>
```

Only generate this block if there are concrete changes. Do not generate it "just in case".

Save to: `.discipline/patches/pending/DISCIPLINE_MD_PATCH_BLOCK.md`

**3. FINDINGS_APPEND_BLOCK** (always generated):

Document the scope decisions made during the expansion:

```markdown
TARGET_FILE: findings.md
PATCH_MODE: append

CONTENT:
## Step 4 - Slice expansion (<date>)

### Scope decisions
- <decision 1: what was included/excluded and why>
- <decision 2>
...

### Deferred items
- <item postponed to a later slice or post-MVP>
...

### New risks identified
- <risk discovered during the expansion, if any>
...
```

Save to: `.discipline/patches/pending/FINDINGS_APPEND_BLOCK.md`

Report: `Patch blocks generated: <N> (TASK_PLAN, DISCIPLINE_MD?, FINDINGS)`

### Phase 4: Post-processing

Apply pending patches:
```bash
npm run discipline:patch
```

Assemble the paste-ready for Step 5:
```bash
npm run discipline:assemble -- --step 5
```

This generates `.discipline/paste-ready/step-5-input.md` with the STEP_5_SLICE_PACKET and all the context Step 5 needs to implement the slice.

Record in the run-log:
```bash
npm run discipline:log -- --step 4 --tool "Claude" --notes "Automated via /discipline-step4"
```

### Phase 5: Summary and next step

Show the user:

```
Step 4 complete.

Slices expanded: <N>
Total complexity: <X>S / <Y>M / <Z>L (estimated: <total hours>h)

Ready slices:
<table with number, name, complexity, dependencies>

First slice prepared: Slice <N> - <name> [complexity]

Generated files:
- .discipline/step4-outputs/READY_SLICES_BLOCK.md
- .discipline/packets/STEP_5_SLICE_PACKET.md (Slice <N>)
- .discipline/patches/pending/ (<N> patch blocks)

Patches applied: <N>
- task_plan.md: Ready Slices updated
<if applicable:>
- discipline.md: Contracts updated
- findings.md: Decisions and deferred items

Paste-readies ready:
- .discipline/paste-ready/step-5-input.md

Next step: /discipline-step5 (Implement Slice <N>: <name>)
```

---

## Error handling

- If `STEP_4_EXECUTION_PACKET` does not exist: stop with "Run /discipline-step2 first."
- If `STEP_4_EXECUTION_PACKET` does not have STATUS validated: stop with a message telling the user to run /discipline-step2 to validate.
- If the EXECUTION_PACKET has no slices defined: stop with "The STEP_4_EXECUTION_PACKET contains no slices. Review the output of Step 2."
- If `npm run discipline:patch` fails: report the error and continue with the assembly. The patch blocks are saved in `.discipline/patches/pending/` and the operator can apply them manually.
- If `npm run discipline:assemble` fails: report which files were missing and suggest a review. The STEP_5_SLICE_PACKET is already saved in `.discipline/packets/` and can be used directly.
- If `npm run discipline:log` fails: report the error but do not stop. The log is informational, not critical.
- If there are inconsistencies between the EXECUTION_PACKET and other packets (e.g. UI_HANDOFF_PACKET references screens that do not match the slices): document the inconsistency in FINDINGS_APPEND_BLOCK and resolve it using the EXECUTION_PACKET as the source of truth for scope and the specialized packets as the source of truth for detail.

---

## Critical rules

- Use Extended Thinking for slice expansion. The value of this step is precise scope and verifiable acceptance criteria.
- Do not invent slices that are not in the STEP_4_EXECUTION_PACKET. Only expand the ones that already exist. If the expansion reveals that a slice should be split, document the reason and propose the split, but do not apply it unless the execution packet reflects it.
- Do not change the slice order without strong justification documented in findings.md.
- Acceptance criteria must be verifiable. "Works well" is not a criterion. "The user can create an item and see it in the list" is.
- Scope OUT is as important as Scope IN. Explicitly documenting what does NOT belong in each slice prevents scope creep during implementation.
- The contracts copied into the STEP_5_SLICE_PACKET must be exact, not summarized. Step 5 implements directly from this packet.
- Before a data or backend slice is `ready`, reconcile its contract with the relevant starter
  schema, shared types, adapters, and fixtures. An intentional difference is fine only when the
  packet names the exact delta, files, tests, and verification that make every layer agree.
- Never require the vault at execution time. Enforce `STEP4_EXPANSION_MODE` and `READY_PROMOTION` from `discipline.md` instead.
- Do not recommend premature optimization in the slices. The bootstrap should be minimal and functional.
- Patch blocks must be exact and pasteable, not narrative suggestions.
- If `progress.md` indicates a slice other than the first, respect that indication. The operator may be resuming a partial pipeline.
