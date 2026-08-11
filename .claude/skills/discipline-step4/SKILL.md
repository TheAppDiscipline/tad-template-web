---
name: discipline-step4
description: "Automate Discipline Loop Step 4: expand the validated STEP_4_EXECUTION_PACKET into executable slices with STEP_5_SLICE_PACKET, patch blocks, and paste-readies. Triggers on /discipline-step4, 'run step 4', 'expand slices', or 'generate slice packet'."
---

# /discipline-step4 - Automate Step 4 of the Discipline Loop pipeline

This skill runs the full Step 4: it first resolves which origin it is running for (first expansion, reentry from Step 5, feedback from Step 6, or hardening from Step 7), then expands the slices into executable slices with scope, contracts, acceptance criteria, and DoD, generates one STEP_5_SLICE_PACKET per slice it promotes to `ready`, emits patch blocks, and leaves one paste-ready per promoted slice for Step 5.

## Origin resolution (fail-loud)

Step 4 has four origins, and this skill must not guess between them:

| Origin (`--mode`) | Comes from | Trigger packet |
|---|---|---|
| `4` | first expansion | validated `STEP_4_EXECUTION_PACKET`, no active reentry |
| `4-reentry` | Step 5 | `SLICE_COMPLETION_PACKET` (completion gate passed) |
| `4-feedback` | Step 6 | `POST_DEPLOY_FEEDBACK_PACKET` recommending a Step 4 mini-fix |
| `4-hardening` | Step 7 | `PROD_HARDENING_PACKET` |

The origin is resolved by the shared `discipline:step4-origin` resolver (the SAME code the watcher uses, so the direct command and the watcher can never disagree). This is **orthogonal** to `STEP4_EXPANSION_MODE` (`batch`/`full`), which controls *how many* slices to expand, not *where the work comes from*.

Honest limitation: Phase 1 validates structural and transitional coherence, not currency. Without a consumption model, one residual packet from a previous round is indistinguishable from an active one. Never tell the user a packet is "the live handoff"; if the resolver stops, surface exactly why.

## Execution policy (self-contained)

Read these optional keys from `discipline.md` §0 Profile. Defaults apply when they are absent:

- `STEP4_EXPANSION_MODE`: `batch` (default) expands the next 2–3 unblocked slices; `full` expands every slice in `STEP_4_EXECUTION_PACKET`.
- `READY_PROMOTION`: `per_packet` (default and the only supported value) means a slice becomes `ready` only when its own `STEP_5_SLICE_PACKET` exists and its dependencies are `done`.
- `DOCTRINE_VERSION`: informational compatibility marker; report its value when present.

Do not require the vault or any external path to apply this policy.
If `STEP4_EXPANSION_MODE` is not `batch|full`, or `READY_PROMOTION` is not `per_packet`, stop and ask the operator to correct `discipline.md`.

No external tools required. Claude generates everything directly.

## What the user sees

1. The skill checks that no unrelated patches are pending, and stops if there are (preflight)
2. It resolves the origin (input/reentry/feedback/hardening) and reports it, or stops if it is ambiguous or incoherent
3. It checks that the STEP_4_EXECUTION_PACKET exists and has STATUS: validated, plus the packets that origin requires
4. Reads all available packets and the project context
5. Expands each slice with detailed scope, contracts, acceptance criteria, and complexity
6. Generates one STEP_5_SLICE_PACKET per slice it promotes to ready (the others stay `planned`, with no packet)
7. Emits patch blocks for task_plan.md, discipline.md, and findings.md
8. Applies patches, assembles paste-readies, and reports a summary

## Prerequisites

- Step 2 completed (`STEP_4_EXECUTION_PACKET.md` with STATUS: validated)
- Node.js + npm (to run the Discipline Loop scripts)
- `.discipline/patches/pending/` empty (the skill verifies this and stops if not)
- **Recommended role: Premium Reliable - Implementation or Premium Reliable - Mechanical Work.** Slice expansion is structured work that does not require Critical Decisions. Frontier-Budget - Implementation is also valid for simple slices as long as you keep gates and review. Current concrete model: resolve it on your provider's official models/pricing page, using the model-selection guide in The App Discipline vault (sold separately) to map the role.

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

### Phase 0a: Resolve the origin (fail-loud)

Before reading anything else, resolve which origin this run is for. Pass through the operator's
`--mode` if they gave one (`/discipline-step4 --mode 4-feedback`):

```bash
npm run discipline:step4-origin -- --json            # or: -- --json --mode <4|4-reentry|4-feedback|4-hardening>
```

Act on the exit code (do NOT re-derive the decision yourself; the resolver is the single source of truth):

- **exit 0 (chosen):** the `mode` field is the origin. Announce it with its evidence, for example:
  `Origin: 4-reentry - a SLICE_COMPLETION_PACKET is present and its completion gate passed.`
  Then continue to Phase 0b. Repeat the "coherence, not currency" caveat verbatim from the evidence;
  do not claim the packet is definitively the live handoff.
- **exit 3 (ambiguous):** two or more reentry handoffs are present at once. STOP, show the candidates,
  and ask the operator to re-run with an explicit `--mode`. This is EXPECTED in Fase 1 (no consumption
  model yet): the normal Step 5 -> 6 -> 7 flow leaves the earlier packets on disk, so a hardening pass
  collides with the lingering completion packet. Do not pick one yourself, and do not tell the operator
  to delete packets as the routine remedy: `--mode` is the intended resolution (Fase 2 will make it
  automatic).
- **exit 2 (invalid):** the resolved (or requested) mode is not coherent, OR the pipeline points to
  another step (a redirect). STOP and show the reason verbatim (execution packet not validated,
  completion gate not green, the feedback recommends Step 7, the feedback branch is undeclared, or
  nothing to expand) and name the step to run instead. Do not proceed.

`--mode` chooses the branch but never skips validation: the resolver still checks the STEP_4_EXECUTION_PACKET
is validated (required for EVERY mode), the completion gate (reentry), and the feedback branch (feedback),
and returns `invalid` if any fails.

### Phase 0b: Verify inputs

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

**Required for the resolved origin (in addition to STEP_4_EXECUTION_PACKET):**
- `4-reentry`: `.discipline/packets/SLICE_COMPLETION_PACKET.md` - the slice just closed in Step 5
- `4-feedback`: `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md` - real-usage feedback from Step 6
- `4-hardening`: `.discipline/packets/PROD_HARDENING_PACKET.md` - the hardening backlog from Step 7

The resolver already confirmed these are present and coherent for the mode; read them so the
expansion incorporates the reentry context (a new slice from feedback, or a hardening item),
not just the original plan.

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
15. `.discipline/metrics/slices.jsonl` - prior measured slices; read through the validated compact
    view with `npm run --silent discipline -- state-view --json`

### Reconcile the plan with the starter project

Before expanding a slice that touches stored data, permissions, or a backend adapter, read the
relevant starter migration or rules file, shared types, selected-provider adapter, and existing
tests or fixtures. Compare them with the validated contract.

For every difference, make the slice say exactly what changes: the physical name, fields,
timestamps or automatic behaviors, access rules, shared type, adapter, and tests. Put those
files in `Files to touch` and make the result verifiable. If the difference changes a product or
architecture decision that is not already resolved, stop and return it to Step 2; do not promote
the slice to `ready` by asking Step 5 to guess.

When a slice REMOVES or RENAMES any contract symbol (a `CoreStore`/`AuthStore` method, an exported
shared type, a table or column), do not assume its uses live only under the backend adapter directory.
Search the WHOLE repo for the identifier and list every hit in `Files to touch` / Scope IN, including
the root-level example tests and fixtures this template ships (they exercise the starter contract), not
just files under `src/lib/backend/`:

```bash
grep -rn "<symbol-you-remove-or-rename>" --include="*.ts" --include="*.tsx" --include="*.js" .
# or, if ripgrep is available: rg "<symbol-you-remove-or-rename>"
```

A template example test that still calls a method you deleted is a LEGITIMATE gate failure, not a false
one: you cannot make a contract test independent of the contract it tests. Surfacing the full blast
radius in the packet turns it into planned work in this slice instead of a surprise when Step 5 runs the
gate.

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
   Also declare exactly one positive integer `MAX_CHANGED_LINES` for the whole slice (production, tests,
   fixtures/config, and documentation). Base it on prior metric records whose
   `affected_surfaces` overlap this slice. Name the comparable slice IDs and measured lines in
   `BASIS`; it must be exactly one substantive declaration. `none`, `N/A`, `TBD`, a duplicate, or
   a label without evidence is refused. When no comparable records exist, say so and give a
   concrete file/risk-based rationale. Never copy an estimate
   from an unrelated surface merely because one exists.

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

### Phase 2: Generate one STEP_5_SLICE_PACKET per promoted slice

**Which slices get a packet is the same question as which slices become `ready`.** `READY_PROMOTION:
per_packet` means a slice is `ready` only when its own packet exists, so generate a packet for every
slice you are about to promote, and promote exactly those. A slice you expanded but did not promote
stays `planned` and gets no packet and no paste-ready: Phase 4 assembles one handoff per promoted
slice, so a promoted slice with no packet would fail there.

**Determine which slice goes first.** Selection criteria:
1. If `progress.md` exists and indicates a specific slice as next, use that one
2. Otherwise, use the first slice in the execution order (typically Slice 0 / bootstrap)

**For each slice you are promoting to ready, assemble the full implementation context.** The packet
is the document an implementer builds from, so it carries a versioned contract: the frontmatter
below is **v2 and required**, and once `status: ready` the tooling refuses a packet that does not
meet it. While you are still filling it in, write `status: draft` and nothing is blocked.

```markdown
---
schema: discipline.packet.step5
version: 2.0.0
id: step5:<slice>:<YYYYMMDDTHHMMSS>
status: ready
slice: <slice>
affected_surfaces:
  - <ui | authenticated-ui | backend | schema | permissions | deployment-artifact | ai | docs-only>
required_gates:
  - gate
---

# STEP_5_SLICE_PACKET

SLICE: <number and name>
COMPLEXITY: <S/M/L>

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

## Provider Impact
<provider configuration used or changed>
<when it does not apply: `- APPLIES: no` plus `- RATIONALE: <why this slice cannot touch it>`>

## AI Impact
<model, prompt, schema or evals this slice touches>
<when it does not apply: `- APPLIES: no` plus `- RATIONALE: <why this slice cannot touch it>`>

## Reachable States
| State | Trigger | Committed effects | Returned result | Recovery |
|---|---|---|---|---|
| <state> | <what puts the system there> | <what is already written> | <what the caller sees> | <how to get out> |

## Acceptance Criteria
| ID | Setup | Action | Observable result | Negative control |
|---|---|---|---|---|
| AC1 | <starting state> | <what is done> | <what is observed> | <what would have to break for this to fail> |

## Falsifiability
- METHOD: <red-evidence | mutation | rationale>
- <the failing run, the mutation that must break a test, or why this slice cannot be falsified>

## Files to touch
<new and modified files, including contract-related types, adapters, tests, and fixtures>

## Deployment Compatibility
<migrations, feature flags, config or artifact changes this slice needs, and whether the previous
build keeps working while it lands>

## Manual Verification
<short happy-path and failure or access-boundary check>

## Estimate
- MAX_CHANGED_LINES: <positive integer covering all changed-line categories>
- BASIS: <similar slice IDs, shared surfaces and measured lines; or no comparable history plus a file/risk rationale>
<when actual scope later exceeds the maximum, add exactly `- SPLIT_DECISION: split` or
`- SPLIT_DECISION: exception-approved`; a repeated measurement also requires the reviewed
declaration `- DUPLICATE_METRICS: allowed`>

## UI Reference
<if there is a UI_HANDOFF_PACKET: copy the sections for the screens affected by this slice>
<include all 4 states of each affected screen>
<if there is no UI: `- APPLIES: no` plus a RATIONALE>

## AI Implementation Reference
<if there is an AI_IMPLEMENTATION_PACKET and the slice touches AI features: copy the relevant sections>
<if not: `- APPLIES: no` plus a RATIONALE>

## DoD
<definition of done>

## Gates
<automated checks required before this slice is complete; keep them in sync with required_gates>

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

**Fill the tables; do not leave a cell for later.** A row with `TBD` in it is refused, and so is an
acceptance criterion whose negative control says `none`: a check that passes proves nothing until
you can say what would have made it fail. Two criteria may not share an ID, because an ID is how a
failure is referred to later. `Committed effects: none` is a fine answer, it just has to be true.

**Fill the sections too: a heading is not an answer.** Every required section is checked for
content, so an empty one, or one holding only sub-headings, is refused exactly like an empty cell.
Emit `status: draft` while you are still writing them and nothing is blocked; `ready` is the claim
that an implementer can build from this.

**Keep `version: 2.0.0`.** A version the tooling cannot read (missing, malformed, or from a future
it does not know) is refused outright rather than treated as a legacy packet: a packet that opted
into a versioned contract is never validated against no contract at all.

**`APPLIES: no` needs a reason somebody can check.** Declaring a section irrelevant is the fastest
way to satisfy it, so `RATIONALE: n/a` is refused and a real sentence is not.

**Declare the surfaces honestly.** `affected_surfaces` is what routes the gates this slice has to
pass, so an omitted surface is a gate the slice never runs. Declaring one extra is harmless; leaving
one out is the failure mode this field exists to prevent.

This list is checked, not trusted: `discipline gate --changed --slice <id>` compares the surfaces
the diff implies against it and **refuses to run any gate at all** when the diff touches one that is
missing here. The fix is to declare it (or to take those files out of the slice), never to widen the
diff quietly.

Save to: `.discipline/packets/STEP_5_SLICE_PACKET_<slice>.md`, where `<slice>` is the slice id in
lowercase (`S13` -> `STEP_5_SLICE_PACKET_13.md`, `S13.2` -> `STEP_5_SLICE_PACKET_13.2.md`).
Report: `STEP_5_SLICE_PACKET_<slice>.md generated for Slice <N>: <name>`

**One packet per file, and never a shared slot.** Do not write, overwrite, rename or move
`STEP_5_SLICE_PACKET.md`: that single slot is what made two ready slices fight over one file, and
what made "which slice is this packet for" a guess. Expanding a second slice writes a second file.

**The packet must name its slice, and only its slice.** The frontmatter `slice:`, the `id:` middle
segment and the `SLICE: <id> - <name>` header line all carry the id, and they must agree. Two
declarations that disagree stop the pipeline on purpose.

**Existing projects:** a packet written before this contract keeps working, with a warning.
`npm run discipline -- migrate-packets` shows what a v2 version of it would look like, and
`--write` applies it, keeping the original and its SHA-256 under `.discipline/packets/legacy/`.

**The slice must already exist in `task_plan.md`, exactly once.** A packet for a slice the plan does
not describe is refused by `discipline:assemble`, by `discipline run` and by `discipline:validate`.
Emit the TASK_PLAN_PATCH_BLOCK below in the same run so the plan and the packets agree.

### Phase 3: Generate patch blocks

**Evaluate which repo files need updating and generate the corresponding blocks.**

**1. TASK_PLAN_PATCH_BLOCK** (always generated):

Update the Ready Slices section of `task_plan.md` with the expanded slices. **Copy the anchor from the file you are patching**, do not retype it from here: the template ships `## 4) Ready Slices`, and an anchor that does not exist fails the whole batch.

```markdown
## TASK_PLAN_PATCH_BLOCK - Step 4 ready slices

TARGET_FILE: task_plan.md
PATCH_MODE: replace_section
ANCHOR: ## 4) Ready Slices

### CONTENT
| Slice | Name | Complexity | Dependencies | Status |
|---|---|---|---|---|
| 0 | <name> | S/M/L | none | ready |
| 1 | <name> | S/M/L | 0 | planned |
| 2 | <name> | S/M/L | 0 | planned |
...
```

**The ID goes in the `Slice` column.** That is the column `discipline:validate` reads to pair the table with each slice's own section; an id parked in a `#` column while `Slice` holds the name makes the whole table invisible, and the plan then says nothing about which slices are ready.

**A table row is not a slice.** `discipline:assemble`, `discipline run` and `discipline:validate` resolve a slice through its own `## Slice <id> - <name>` section, so a slice you promote to `ready` without one is refused as "not in task_plan.md" the moment Step 5 tries to use it. `replace_section` at this anchor rewrites only what sits between the heading and the first `## Slice ...` heading, which is the table: the sections already in the file survive untouched. For a slice that does not have a section yet, emit a SECOND block that appends it:

```markdown
## TASK_PLAN_SLICES_APPEND_BLOCK - Step 4 new slice sections

TARGET_FILE: task_plan.md
PATCH_MODE: append
ANCHOR: ## 4) Ready Slices

### CONTENT
## Slice <id> - <name>
- Status: <ready|planned|blocked|done>
### Goal
<one sentence>
#### Scope IN
- <...>
#### Scope OUT
- <...>
#### Contracts
- <...>
#### Acceptance Criteria
- [ ] <...>
```

**Write the status in BOTH places, with the same word.** `discipline run` reads the table row and the slice's own `- Status:` line, and it stops when they disagree rather than picking one. A status written in neither place is the legacy case: the slice is assumed `ready`, which is exactly how a slice already `done` gets handed back to the runner. Use a bare status word in the table cell (`planned`, not `planned (awaiting the packet)`): the cell is compared to the section, not read as prose.

Only a slice with its own emitted packet and satisfied dependencies may be `ready`, and every slice you promote must have one (that is what `READY_PROMOTION: per_packet` means). Preserve slices already marked `done`; detailed expansion alone never promotes a slice.

Save to: `.discipline/patches/pending/TASK_PLAN_PATCH_step4_<YYYY-MM-DD-HHMMSS>.md`, using this run's timestamp so a retry never overwrites an unapplied patch from an earlier run.

**2. DISCIPLINE_MD_PATCH_BLOCK** (only if contracts need updating):

If during slice expansion you identified contracts that need refinement (e.g. a missing field, an undocumented endpoint, an incomplete type), generate the patch:

```markdown
## DISCIPLINE_MD_PATCH_BLOCK - Step 4 contract update

TARGET_FILE: discipline.md
PATCH_MODE: replace_section
ANCHOR: <specific section to update, exactly as it reads in discipline.md>

### CONTENT
<the new BODY of that section, WITHOUT repeating its heading>
```

**`replace_section` keeps the anchor heading and replaces only what follows it.** Never repeat the heading inside `### CONTENT`: that would leave the heading twice, and a duplicate anchor makes every later patch to that section fail with "Duplicate anchor". The content you write is the section body, starting at its first line after the heading.

Only generate this block if there are concrete changes. Do not generate it "just in case".

Save to: `.discipline/patches/pending/DISCIPLINE_MD_PATCH_step4_<YYYY-MM-DD-HHMMSS>.md`, using this run's timestamp so a retry never overwrites an unapplied patch from an earlier run.

**3. FINDINGS_APPEND_BLOCK** (always generated):

Document the scope decisions made during the expansion:

```markdown
## FINDINGS_APPEND_BLOCK - Step 4 slice expansion (origin: <mode>)

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Decisions

### CONTENT
- <date> · Step 4 slice expansion (origin: <mode>): <decision 1, what was included/excluded and why>; <decision 2>
```

If the expansion postponed items or uncovered new risks, emit additional blocks, one file per section, with `ANCHOR: ## Deferred` (items postponed to a later slice or post-MVP) and `ANCHOR: ## Risks` (risks discovered during the expansion). Use dated list entries only, never headings inside the content: the anchors of `findings.md` are headings, and appending a heading would corrupt the section structure.

Save to: `.discipline/patches/pending/FINDINGS_APPEND_step4_<YYYY-MM-DD-HHMMSS>_<section>.md`, using this run's timestamp. The stamp is what makes the name unique: without it, a second run (or a retry after a failure) silently overwrites the pending patch of an earlier one.

Report: `Patch blocks generated: <N> (TASK_PLAN, DISCIPLINE_MD?, FINDINGS)`

### Phase 4: Post-processing

Apply pending patches:
```bash
npm run discipline:patch
```

**If that command exits non-zero, this step stops here.** The patch engine treats the batch as all-or-nothing: it restores from `.discipline/backups/` every state file it had already written, and moves those patch files from `applied/` back to `pending/`. The repo is left as it was before this phase and every block this run produced is still in `pending/`, where the next run's preflight will surface it. Do not assemble, do not log the run, do not show the summary. A paste-ready assembled now would carry a `task_plan.md` whose Ready Slices were never patched, so Step 5 would implement against a slice table that does not exist yet. Report the failing patch name and the engine's error verbatim, and hand the decision back to the operator.

If the output says `Rollback incomplete` instead of `Rollback complete`, stop harder and say so: the state files may be half-patched, and the operator has to compare them against `.discipline/backups/` before running anything else.

Assemble one paste-ready PER SLICE you expanded, naming the slice explicitly:
```bash
npm run discipline:assemble -- --step 5 --slice <slice>
```

Run it once per expanded slice. Each run reads that slice's own `STEP_5_SLICE_PACKET_<slice>.md`
and writes `.discipline/paste-ready/step-5-<slice>-input.md`. Without `--slice` the command looks
for the generic `STEP_5_SLICE_PACKET.md`, which this step no longer writes, so it would fail on a
packet that does not exist while the real one sits next to it.

Each run generates `.discipline/paste-ready/step-5-<slice>-input.md` with that slice's STEP_5_SLICE_PACKET and all the context Step 5 needs to implement it. One file per slice: expanding a second slice adds a file, it never overwrites the first.

**If any assemble exits non-zero, this step also stops here.** The patches are applied but that slice's handoff is not: report the error verbatim, name the slice, do not log the run, and do not present Step 5 as ready. A `step-5-<slice>-input.md` left over from an earlier expansion of the same slice is indistinguishable from a fresh one for whoever pastes it.

Record in the run-log:
```bash
npm run discipline:log -- --step 4 --tool "Claude" --notes "Automated via /discipline-step4"
```

### Phase 5: Summary and next step

Show the user:

```
Step 4 complete.

Origin: <mode> (input | reentry | feedback | hardening)
Slices expanded: <N>
Total complexity: <X>S / <Y>M / <Z>L (estimated: <total hours>h)

Ready slices:
<table with number, name, complexity, dependencies>

First slice prepared: Slice <N> - <name> [complexity]

Generated files:
- .discipline/step4-outputs/READY_SLICES_BLOCK.md
- .discipline/packets/STEP_5_SLICE_PACKET_<slice>.md (one per expanded slice)
- .discipline/paste-ready/step-5-<slice>-input.md (one per expanded slice)
- .discipline/patches/pending/ (<N> patch blocks)

Patches applied: <N>
- task_plan.md: Ready Slices updated
<if applicable:>
- discipline.md: Contracts updated
- findings.md: Decisions and deferred items

Paste-readies ready:
- .discipline/paste-ready/step-5-<slice>-input.md (one per expanded slice)

Next step: implement Slice <N> - <name> using `.discipline/paste-ready/step-5-<slice>-input.md` in your coding agent, one slice at a time. After its DoD is verified and the gate passes, run `/discipline-step5-slice` to close the slice formally.
```

---

## Error handling

- If the preflight finds pending patches: stop before reading inputs. Never apply work this run did not produce as a side effect of running this step.
- If `discipline:step4-origin` exits 3 (ambiguous): stop, show the candidate modes, and ask the operator to re-run with `--mode <x>`. Expected in Fase 1 (packets linger with no consumption model); `--mode` is the remedy, not deleting packets. Never pick one silently.
- If `discipline:step4-origin` exits 2 (invalid): stop, show the reason verbatim (execution packet not validated, completion gate not green, feedback recommends Step 7, feedback branch not declared, or nothing to expand), and name the step to run instead.
- If `STEP_4_EXECUTION_PACKET` does not exist: stop with "Run /discipline-step2 first."
- If `STEP_4_EXECUTION_PACKET` does not have STATUS validated: stop with a message telling the user to run /discipline-step2 to validate.
- If the EXECUTION_PACKET has no slices defined: stop with "The STEP_4_EXECUTION_PACKET contains no slices. Review the output of Step 2."
- If `npm run discipline:patch` fails: stop. Report the failing patch and the engine's error verbatim. The batch was rolled back and every block is back in `.discipline/patches/pending/`; do not assemble, do not log, do not summarize. Fixing the block and re-running the step is the operator's call.
- If `npm run discipline:assemble` fails: stop. Report which files were missing. The patches are applied, so re-running only the assemble is safe once the cause is fixed. The STEP_5_SLICE_PACKET is already in `.discipline/packets/` and the operator may use it directly, but do not present Step 5 as ready on the strength of an old paste-ready.
- If `npm run discipline:log` fails: report the error but do not stop. The log is informational, not critical.
- If there are inconsistencies between the EXECUTION_PACKET and other packets (e.g. UI_HANDOFF_PACKET references screens that do not match the slices): document the inconsistency in FINDINGS_APPEND_BLOCK and resolve it using the EXECUTION_PACKET as the source of truth for scope and the specialized packets as the source of truth for detail.

---

## Critical rules

- Never run `discipline:patch` if `pending/` contained files before this run. The command applies everything in the directory with no per-file selection; the preflight is the only guard.
- Never assemble, log, or announce this step as complete after a failed `discipline:patch` or `discipline:assemble`. A handoff built on unpatched state files is worse than no handoff: it looks finished and sends Step 5 at a slice table that was never written.
- Never guess the origin. Resolve it with `discipline:step4-origin`; on ambiguous or invalid, stop and ask. `--mode` chooses the branch but never skips the resolver's validation.
- Do not claim currency. The resolver proves structural/transitional coherence only (Phase 1 has no consumption model); a single residual packet reads as coherent. Say so if relevant.
- Use Extended Thinking for slice expansion. The value of this step is precise scope and verifiable acceptance criteria.
- Do not invent slices that are not in the STEP_4_EXECUTION_PACKET. Only expand the ones that already exist. If the expansion reveals that a slice should be split, document the reason and propose the split, but do not apply it unless the execution packet reflects it.
- Do not change the slice order without strong justification documented in findings.md.
- Acceptance criteria must be verifiable. "Works well" is not a criterion. "The user can create an item and see it in the list" is.
- Scope OUT is as important as Scope IN. Explicitly documenting what does NOT belong in each slice prevents scope creep during implementation.
- The contracts copied into the STEP_5_SLICE_PACKET must be exact, not summarized. Step 5 implements directly from this packet.
- Before a data or backend slice is `ready`, reconcile its contract with the relevant starter
  schema, shared types, adapters, and fixtures, AND grep the whole repo for any contract symbol the
  slice removes or renames (its uses are not confined to `src/lib/backend/`; the template ships example
  tests at the repo root). An intentional difference is fine only when the packet names the exact delta,
  files (including those root-level example tests), tests, and verification that make every layer agree.
- Never require the vault at execution time. Enforce `STEP4_EXPANSION_MODE` and `READY_PROMOTION` from `discipline.md` instead.
- Do not recommend premature optimization in the slices. The bootstrap should be minimal and functional.
- Patch blocks must be exact and pasteable, not narrative suggestions.
- If `progress.md` indicates a slice other than the first, respect that indication. The operator may be resuming a partial pipeline.
