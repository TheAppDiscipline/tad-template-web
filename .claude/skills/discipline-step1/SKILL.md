---
name: discipline-step1
description: "Automate Discipline Loop Step 1: generate the PRD, contracts, switches, and handoff packets from an app description. Triggers on /discipline-step1, 'run step 1', 'generate the PRD', or 'set up my project from a description'."
---

# /discipline-step1 - Automate Step 1 of the Discipline Loop pipeline

This skill runs the full Step 1: it configures the project, generates the 13 outputs (PRD, user stories, data model, cross-validation, handoff packets), and leaves everything ready for Step 2.

No external tools required. Claude generates everything directly.

## What the user sees

1. The skill asks the user to describe their app (if there is no prior description)
2. It asks up to 3 clarifying questions if the description has gaps
3. It infers the technical configuration, shows it, and asks for confirmation
4. It generates 3 pre-filled input files for the user to review
5. Once confirmed, it generates the 13 outputs sequentially
6. If the cross-validation (Output 8) detects inconsistencies, it fixes them before generating the final packets
7. It reports progress (`✓ Output N/13: name`) and shows a summary at the end

## Prerequisites

- Node.js + npm (to run the Discipline Loop scripts)
- The project must be based on the Repo Template (or have a `package.json` with the `discipline:*` scripts)

Playwright and external accounts are not needed.

---

## Internal implementation

### Phase 0: Verify or configure the project

Check whether `discipline.md` exists in the current directory and whether its switches are configured. Read `discipline.md` and check whether the key fields have values (PROFILE, BACKEND_PROVIDER, AUTH_MODE). If they are empty or placeholders (e.g., `PROFILE:` with no value), the switches are NOT configured.

**If the switches are ALREADY configured:** continue to Phase 1.

**If `discipline.md` does NOT exist OR the switches are empty:**

Ask the user to describe their app in natural language:

```
Describe your app to me: what does it do, who is it for, and what does the user need to be able to do?

Example: "A web app for small teams to track their weekly tasks.
Each member creates an account with Google, sees their tasks and the team's,
and the lead can assign tasks to others."
```

If an `IDEA_VALIDATION_PACKET` already exists in `.discipline/packets/` or there is a description in `00_Raw_Input.md`, use that information instead of asking.

**Analyze the description and detect critical gaps.** Before inferring switches, check whether the description covers these 4 axes:

1. **Problem**: Is it clear what pain it solves? If not, ask.
2. **Users**: Is it clear who uses it and whether there are distinct roles? If not, ask.
3. **Key actions**: Is it clear what each user can do? If not, ask.
4. **Data**: Is it clear what information is stored and whether it is shared? If not, ask.

If 1 or more axes are missing, ask the clarifying questions **in a single message** (not one at a time). Example:

```
Before I configure the project I need to clarify a couple of things:

1. Does each person create their own tasks, or does someone assign them?
2. Do tasks have a due date, or are they just marked as complete?

With that I have what I need to continue.
```

Rules for the clarifying questions:
- At most 3 questions. If there are more than 3 gaps, prioritize the ones that affect switches (roles -> COLLAB, shared data -> BACKEND, login -> AUTH).
- Only ask about what cannot be reasonably assumed. If the obvious answer is "yes" or "no", assume it and move on.
- Do not ask about technology (backend, hosting, auth method). That is inferred.

Once the description covers all 4 axes, continue:

**Infer the switches from the description.** Analyze what the user said and deduce the technical configuration:

| Signal in the description | Switch | Inferred value |
|---|---|---|
| "web app", "opens in the browser", "PWA", or does not mention a platform | LANE | WEB |
| "mobile app", "iPhone", "Android", "App Store" | LANE | MOBILE |
| "Chrome/Firefox extension" | LANE | EXTENSION |
| "API", "backend", "service" | LANE | BACKEND |
| Few features, one type of user, personal use | PROFILE | LITE |
| Several data types, sharing with family/closed group | PROFILE | FAMILY_SYNC |
| Public beta / first paying users, without a complete PROD scorecard | PROFILE | LAUNCH |
| Roles, permissions, admin, multiple flows, commercial >=50 active | PROFILE | PROD |
| "login", "create account", "users", "team", "members" | AUTH | MAGIC_LINK (default if no method is specified) |
| "Google login", "sign in with Google" | AUTH | GOOGLE |
| "no login", "no account", personal use without mentioning accounts | AUTH | NONE |
| If AUTH=NONE and there is no mention of sharing or sync across devices | BACKEND | LOCAL_ONLY |
| If it needs accounts, shared data, or sync | BACKEND | SUPABASE (default) |
| Explicitly mentions "Firebase" or "Google Cloud" | BACKEND | FIREBASE |
| "share", "team", "collaborate", "assign to others" | COLLAB | COLLABORATIVE |
| "see other people's stuff", "share (read-only)", or no mention of collaboration | COLLAB | VIEW_ONLY |
| "AI", "generate text", "analyze with AI", "chatbot" | AI_FEATURES | enabled |
| No mention of AI | AI_FEATURES | none |
| "notifications", "alerts", "push reminders" | PUSH | true |
| No mention of notifications | PUSH | false |

Automatic inferences (not asked):
- SYNC: If BACKEND=LOCAL_ONLY -> OFFLINE_FIRST, anything else -> FAST_UI
- HOSTING: Vercel (default)

**Show the inferred configuration and ask for confirmation:**

```
Based on your description, this is the configuration I recommend:

- Type: Web (LANE=WEB)
- Complexity: Medium, several users, shared data (PROFILE=FAMILY_SYNC)
- Login: With Google (AUTH=GOOGLE)
- Database: Supabase, quick to set up, good free tier (BACKEND=SUPABASE)
- Collaboration: Users can edit shared data (COLLAB=COLLABORATIVE)
- Sync: Fast UI with sync to the backend (SYNC=FAST_UI)
- AI: No (AI_FEATURES=none)
- Push notifications: No (PUSH=false)
- Hosting: Vercel (HOSTING=Vercel)

Is this good, or do you want to change something?
```

The user can say "yes", "perfect", or "change X to Y". Adjust based on the feedback.

Once confirmed, run it. Use `--force` if `discipline.md` already exists (to overwrite the empty switches):

```bash
npm run discipline:hydrate -- --lane <LANE> --profile <PROFILE> --backend <BACKEND> --auth <AUTH> --collab <COLLAB> --sync <SYNC> --ai <AI> --push <PUSH> --hosting <HOSTING> --force
```

**After hydrate, fill in the identity fields in `discipline.md`.** Extract from the user's description:
- `PROJECT_NAME`: short name of the app (e.g., "MyWeek", "TaskFlow", "FamilyBudget"). If the user did not give a name, infer a descriptive one from the purpose.
- `PRIMARY_GOAL`: one sentence that sums up the main objective (e.g., "Help small teams organize their weekly tasks")
- `NORTH_STAR_METRIC`: a measurable metric (e.g., "% of tasks completed per week", "weekly active users")

Edit `discipline.md` directly to replace the placeholders `<APP_NAME>`, `<one sentence>`, `<measurable metric>` with the real values.

### Phase 1: Prepare inputs

**Save the user's description as the IDEA_VALIDATION_PACKET.** If the user gave their description in Phase 0, save it to `.discipline/packets/IDEA_VALIDATION_PACKET.md` in this format:

```markdown
# IDEA_VALIDATION_PACKET

## Problem
<extract from the user's description: what problem it solves>

## Target user
<extract from the description: who it is for>

## Differentiator
<extract from the description: what makes it different, or "To be defined in Step 1" if not mentioned>

## Original description
<the verbatim description the user gave>
```

```bash
npm run discipline:step1-prep
```

Generates:
- `.discipline/step1-input/00_Raw_Input.md` - pre-filled with the `IDEA_VALIDATION_PACKET`
- `.discipline/step1-input/01_Real_Examples.md` - template with the case format
- `.discipline/step1-input/02_Constraints.md` - pre-filled with the switches from `discipline.md`
- `.discipline/prompts/step-1-all-prompts.md` - the 13 prompts interpolated with the project's switches

**After `step1-prep` generates the files, enrich `01_Real_Examples.md` with a draft of use cases.** Analyze the user's description and generate 3-5 concrete use cases in this format:

```markdown
## Case: <descriptive name>
- Actor: <who>
- Action: <what they do, step by step>
- Expected result: <what they see/get>
- Key data: <what data is created, read, or modified>
```

Write the draft directly into `.discipline/step1-input/01_Real_Examples.md`.

**Open the 3 input files for the user to review.** Show a summary of what is in each one:

```
The 3 input files are ready for review:

1. 00_Raw_Input.md - Your app idea (pre-filled with what you described to me)
2. 01_Real_Examples.md - Use cases I generated based on your description (check that they make sense)
3. 02_Constraints.md - The technical configuration you confirmed

Review them and tell me if you want to change anything, or "ready" to continue.
```

Do not continue until the user confirms. If the user wants to change something, apply the changes and show the summary again.

### Phase 2: Generate the 13 outputs

Read the prompts from `.discipline/prompts/step-1-all-prompts.md`. Read the 3 input files as context. Read the system prompt from the "SYSTEM PROMPT" section of the prompts file.

**Context for generation:** Before generating each output, Claude should keep in mind:
- The system prompt (act as a Product Manager + Systems Designer)
- The 3 input files (idea, examples, constraints)
- All outputs generated so far (each output can reference the previous ones)

**Run outputs 1-7, then Output 8 (validation), resolve problems, and finally outputs 9-13.**

**For each output (1-7):**

1. **Check whether it applies.** The prompts file marks conditionals with "(SKIP)". If it says SKIP, skip it.

2. **Check whether it already exists.** If the destination file already exists (from an earlier partial run), ask whether to regenerate or skip.

3. **Generate the output.** Use the corresponding prompt from the prompts file. Apply the system prompt as context. Include the 3 input files and all previous outputs as reference.

4. **Save to** `.discipline/step1-outputs/<note_title>.md`

5. **Report:** `✓ Output N/13: <name>`

**Output 8 - Cross-validation (special handling):**

**Important: use Extended Thinking for this output.** The cross-validation is a critical quality gate. Include "think deeply about inconsistencies" to trigger deep reasoning. The value of this output is catching errors that the generation of outputs 1-7 introduced without noticing.

Generate Output 8 using the validation prompt. This prompt asks it to review all of outputs 1-7 looking for inconsistencies.

Save to `.discipline/step1-outputs/10_Validation.md`. Then analyze the content:

- **If there are NO inconsistencies**: report `✓ Output 8/13: Validation - no inconsistencies` and continue to outputs 9-13.

- **If there ARE inconsistencies (whether they seem minor or serious)**:
  **MANDATORY: fix ALL inconsistencies BEFORE continuing to outputs 9-13.** Do not defer fixes for later. Do not judge whether they are "minor". Packets 9-13 are built on top of outputs 1-7; if there are errors, they propagate.
  1. Report: `⚠ Output 8: N inconsistencies detected. Fixing before generating packets...`
  2. For each affected output (1-7), regenerate the entire output applying the fixes indicated by the validation.
  3. Overwrite the file in `.discipline/step1-outputs/` with the corrected version.
  4. Report: `✓ Output N corrected: <name>`
  5. **Do NOT continue to outputs 9-13 until all fixes are applied.**

**For each output (9-13), after resolving validation:**

Same logic as 1-7, but save to different locations:
   - Outputs 9-13: save to `.discipline/packets/<packet_file>.md`
   - Output 12: add `STATUS: draft` at the top of the file
   - Output 13: split into `DISCIPLINE_MD_READY_BLOCK.md` + `TASK_PLAN_READY_BLOCK.md`

**Reference of outputs and destinations:**

| Output | Note | File | Destination |
|---|---|---|---|
| 1 | PRD | `03_PRD.md` | `.discipline/step1-outputs/` |
| 2 | User Stories | `04_User_Stories.md` | `.discipline/step1-outputs/` |
| 3 | Data Model | `05_Data_Model.md` | `.discipline/step1-outputs/` |
| 4 | UI States | `06_UI_States.md` | `.discipline/step1-outputs/` |
| 5 | Events | `07_Events_and_Notifications.md` | `.discipline/step1-outputs/` |
| 6 | Architecture Switches | `08_Architecture_Switches.md` | `.discipline/step1-outputs/` |
| 7 | Export for Discipline Loop | `09_Export_for_DisciplineLoop.md` | `.discipline/step1-outputs/` |
| 8 | Validation | `10_Validation.md` | `.discipline/step1-outputs/` |
| 9 | STEP_2_ARCHITECTURE_PACKET | `STEP_2_ARCHITECTURE_PACKET.md` | `.discipline/packets/` |
| 10 | STEP_2_5_AI_PACKET | `STEP_2_5_AI_PACKET.md` | `.discipline/packets/` (only if AI_FEATURES=enabled) |
| 11 | STEP_3_STITCH_PACKET | `STEP_3_STITCH_PACKET.md` | `.discipline/packets/` (only if LANE is not BACKEND or CLI) |
| 12 | STEP_4_EXECUTION_PACKET | `STEP_4_EXECUTION_PACKET.draft.md` | `.discipline/packets/` (with STATUS: draft) |
| 13 | REPO_READY_BLOCKS | `DISCIPLINE_MD_READY_BLOCK.md` + `TASK_PLAN_READY_BLOCK.md` | `.discipline/packets/` |

### Phase 3: Post-processing

```bash
npm run discipline:assemble -- --step 2
```

If AI_FEATURES=enabled:
```bash
npm run discipline:assemble -- --step 2.5
```

If LANE is not BACKEND or CLI:
```bash
npm run discipline:assemble -- --step 3
```

Apply the ready blocks to the repo:
- `DISCIPLINE_MD_READY_BLOCK.md` -> `discipline.md`
- `TASK_PLAN_READY_BLOCK.md` -> `task_plan.md`

Record in the run-log:
```bash
npm run discipline:log -- --step 1 --tool "Claude" --notes "Automated via /discipline-step1"
```

### Phase 4: Summary and final validation

Show the user:
- How many outputs were generated (out of the 13 possible)
- Which packets are ready in `.discipline/packets/`
- Which paste-readies were assembled
- What the next step is (Step 2: Architecture)

**Final cross-validation (automatic, do not ask).** Read all the generated packets and the reference outputs. Look for inconsistencies among them: contradictory data, user stories that do not line up with the PRD, contracts that do not cover the described flows, switches that are not reflected in the packets.

- If it finds inconsistencies: report each one, fix the affected files directly, and report the fixes.
- If it finds no inconsistencies: confirm that everything is consistent.

---

## Error handling

- If `npm run discipline:step1-prep` fails: check that `package.json` has the script and that the dependencies are installed (`npm install`). If `tsx` is not found, use `npx tsx`.
- If `npm run discipline:assemble` fails: check that the packets exist in `.discipline/packets/`.
- If an output fails to generate: record which one failed and continue with the next. At the end, report the missing outputs so the user can re-run `/discipline-step1` (the already-completed outputs are not regenerated).
