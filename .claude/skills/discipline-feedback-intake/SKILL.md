---
name: discipline-feedback-intake
description: "Capture real-usage findings days after a deploy WITHOUT re-running Step 6: interview the operator, dedupe against known issues, emit dated FINDINGS_APPEND_BLOCKs, apply them, and refresh the Step 4 feedback paste-ready. Never deploys, never runs gates, never edits packets or task_plan.md. Triggers on /discipline-feedback-intake, 'post-deploy feedback', 'register findings', 'log usage feedback'."
---

# /discipline-feedback-intake - Register real-usage findings between deploys

This skill covers the gap between Step 6 (deploy + verify) and the next Step 4 feedback loop: you deployed, you used the app for days, and now you have findings to register. Step 6 is the wrong tool for that moment (its contract requires gates, build, and a deploy). This skill only captures, classifies, and records.

**Scope fence (why this skill is narrow).** In Fase 1 the pipeline has no handoff-consumption model: the Step 4 origin resolver routes by the PRESENCE of packet files. Therefore this skill NEVER creates or modifies packets — a new packet type would become an unreadable router signal and increase origin collisions. Everything it writes goes through `FINDINGS_APPEND_BLOCK`s into `findings.md`, which Step 4 already reads (both the in-repo skill and the assembled paste-ready include it). A future version (Fase 2) will add deploy-scoped immutable deltas; this one deliberately does not.

## What the user sees

1. The skill checks that no unrelated patches are pending (preflight)
2. Reads the known open issues (packet + findings) so it does not re-ask about them
3. Asks the operator what they found during real usage
4. Classifies each finding and dedupes against what is already recorded
5. Generates dated FINDINGS_APPEND_BLOCKs (one per findings.md section, per the Step 6 doctrine mapping) and applies them with `discipline:patch`
6. Refreshes `step-4-feedback.md` so the new context travels with the handoff
7. Recommends the next move; the operator decides

## Prerequisites

- `findings.md` present with its canonical anchors (any Discipline Loop project has it)
- `.discipline/patches/pending/` empty (the skill verifies this and stops if not)
- Node.js + npm (for `discipline:patch` / `discipline:assemble`)
- A deploy on record (`POST_DEPLOY_FEEDBACK_PACKET.md` or deploy notes in `progress.md`) is recommended but NOT required: findings from local usage are valid too

---

## Internal implementation

### Phase 0: Preflight and context

**Preflight (before interviewing, before writing anything):** list `.discipline/patches/pending/*.md`. If ANY file is there, STOP.

Show what is there with each file's routing header, so the risk is visible before the operator decides (a `replace_section` leftover overwrites a whole section of a state file; an `append` one only adds lines):

```
There are pending patches from earlier work:
- <file>: TARGET_FILE <target> | PATCH_MODE <mode> | ANCHOR <anchor>
- ...

`npm run discipline:patch` applies EVERYTHING in pending/, so running intake now would apply that
unrelated work together with your feedback, in the same silent operation. Resolve them first, then
re-run /discipline-feedback-intake:

- read them, and if they still hold, apply them consciously with `npm run discipline:patch`; or
- move them out of pending/ (for example into `.discipline/patches/parked/`) to park them without
  applying them. Do not delete them: they are your evidence. Note that parking also takes them out
  of the pending count in `npm run discipline:validate`, so nothing else will remind you.
```

Do not interview, do not create files, do not offer to resolve it from inside the skill. This preflight exists because the patch engine has no per-file selection: it applies the whole directory or nothing. Intake is pure capture and has no legitimate reason to touch `pending/` at all, so it refuses and exits. Same contract as the producer steps (`/discipline-step2`, `/discipline-step4`, `/discipline-step6`, `/discipline-step7`).

Then read these files. Only `findings.md` is required.

1. `findings.md` — verify the canonical anchors exist (`## Decisions`, `## Open Questions`, `## Risks`, `## Constraints`, `## Assumptions`, `## Deferred`). If any is missing, stop: "findings.md is missing canonical anchors. Run npm run discipline:validate and fix before intake."
2. `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md` (optional) — extract: DEPLOY_TARGET, GENERATED date, the list of open issues and UX frictions. This packet is **immutable evidence of its deploy and a router signal: never edit it.**
3. `progress.md` (optional) — deploy notes, open errors.
4. `task_plan.md` (optional, read-only) — pending backlog items, for dedupe only.

Build an internal list of KNOWN OPEN ITEMS (issue + where it is recorded). Show it to the operator up front:

```
Known open items (I will not re-record these):
- <#N from POST_DEPLOY_FEEDBACK_PACKET: short title>
- <open error from progress.md>
...
New findings only from here on.
```

Also fix the RUN_STAMP for this run: `<YYYY-MM-DD-HHMMSS>` (local time). Every file this run creates uses it.

### Phase 1: Interview

Ask the operator:

```
Usage feedback intake:

1. Since when have you been using this build? (deploy URL/date if you know it)
2. Bugs or broken flows you hit? (what you did, what you expected, what happened)
3. UX frictions? (confusing, slow, ugly, annoying)
4. Features you missed while using it?
5. Performance, security, or data concerns?
6. Did your priorities change? (something that should move up or down in the backlog)
7. For anything matching a KNOWN OPEN ITEM: any new information about it?
```

Wait for the operator's answers. Ask follow-ups only to make a finding concrete enough to act on (repro steps, screen, frequency). Do not push for more findings than the operator has.

### Phase 2: Classify and dedupe

For each finding, record:

- **Type:** bug | ux-friction | missing-feature | performance | security/data | priority-change | open-question | non-issue
- **Severity (operator's call):** blocks-main-flow | friction | minor
- **Deploy context:** URL/date from Phase 0/1, or "local usage" if none
- **Dedupe status:** new | update-to-known (name the known item; an update adds the new information and references the original — it never duplicates the entry)

If EVERYTHING the operator reports is already recorded and brings no new information, stop here: "Nothing new to record. findings.md and the packet already cover this." Write no files.

### Phase 3: Generate FINDINGS_APPEND_BLOCKs

Route each finding to its `findings.md` section following the Step 6 doctrine mapping (one block file per section, only when that section has content):

| Finding type | ANCHOR |
|---|---|
| bug, ux-friction, performance, security/data | `## Risks` |
| missing-feature | `## Deferred` |
| priority-change, classification calls ("confirmed as defect", "checked and discarded as non-issue") | `## Decisions` |
| open-question (needs the operator's answer before expanding slices) | `## Open Questions` |

Every entry carries: date, observed behavior, impact, and evidence or repro steps. Use dated list entries only, never headings inside the content: the anchors of `findings.md` are headings, and appending a heading would corrupt the section structure.

**Risks block:** save to `.discipline/patches/pending/FEEDBACK_INTAKE_<RUN_STAMP>_risks.md`

```markdown
## Usage feedback intake <RUN_STAMP> - risks

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Risks

### CONTENT
- <YYYY-MM-DD> · [<bug|ux-friction|performance|security> · <severity>] <observed behavior> — impact: <impact>. Evidence/repro: <steps or screen>. (deploy: <URL or "local usage">)
```

**Deferred block:** save to `.discipline/patches/pending/FEEDBACK_INTAKE_<RUN_STAMP>_deferred.md`

```markdown
## Usage feedback intake <RUN_STAMP> - missing features

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Deferred

### CONTENT
- <YYYY-MM-DD> · Missing feature observed in real usage: <what was missed and in which moment of use>. Candidate for Step 4 expansion; not a backlog edit.
```

**Decisions block:** save to `.discipline/patches/pending/FEEDBACK_INTAKE_<RUN_STAMP>_decisions.md`

```markdown
## Usage feedback intake <RUN_STAMP> - decisions

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Decisions

### CONTENT
- <YYYY-MM-DD> · Usage feedback intake (deploy: <URL or "local usage">, in use since <date>): <priority change or classification decision>. Updates to known items: <"none" | item → new information>. Non-issues checked and discarded: <"none" | list>.
```

**Open Questions block:** save to `.discipline/patches/pending/FEEDBACK_INTAKE_<RUN_STAMP>_openq.md`

```markdown
## Usage feedback intake <RUN_STAMP> - open questions

TARGET_FILE: findings.md
PATCH_MODE: append
ANCHOR: ## Open Questions

### CONTENT
- <YYYY-MM-DD> · <question the operator must answer before expanding slices>
```

Format rules (the patch engine is strict): the heading line is the patch name; `TARGET_FILE:`, `PATCH_MODE:`, `ANCHOR:` are required; the content starts after a standalone `### CONTENT` line; the ANCHOR must be one of the six canonical `findings.md` headings, exactly as written there. The RUN_STAMP in the file names prevents a second run (same day or after a failure) from overwriting the previous run's evidence.

### Phase 4: Apply and refresh

Apply the patches (pending/ contains ONLY this run's files, guaranteed by the preflight):
```bash
npm run discipline:patch
```

If `POST_DEPLOY_FEEDBACK_PACKET.md` exists AND its recommended branch is the Step 4 feedback loop, refresh the paste-ready so it carries the updated `findings.md` (the old one is a stale snapshot):
```bash
npm run discipline:assemble -- --step 4-feedback
```
If the packet is missing or recommends Step 7, skip this and say why.

Log the run:
```bash
npm run discipline:log -- --step 6-intake --tool "Claude" --notes "Usage feedback intake: <N> new, <M> updates. No deploy, no gates."
```

### Phase 5: Summary

```
Feedback intake complete.

Recorded: <N> new findings, <M> updates to known items
Applied to: findings.md (<§Risks, §Deferred, §Decisions, §Open Questions — only the ones written>)
Paste-ready: <refreshed step-4-feedback.md | skipped (<reason>)>

Next (your call, not mine):
- Expand into slices now: /discipline-step4 --mode 4-feedback
- Keep using the app and run /discipline-feedback-intake again later
- If a finding blocks the main flow: consider a direct Step 5 mini-fix
```

---

## Error handling

- If the preflight finds pending patches: stop before the interview. Never apply someone else's pending work as a side effect of intake.
- If `findings.md` is missing or lacks canonical anchors: stop before the interview. Nothing to patch against.
- If `npm run discipline:patch` fails: report the exact error, leave the patch files in `.discipline/patches/pending/` (they are the operator's evidence), do not retry blindly. The next run's preflight will surface them.
- If `discipline:assemble` fails: report and continue. The findings are already applied; the paste-ready can be regenerated later.
- If the operator reports nothing new: exit without writing any file. An empty intake entry is noise.
- If a duplicate-anchor error appears: `findings.md` has two identical headings; tell the operator to fix it manually and re-run.

## Critical rules

- Never deploy, never run gates or builds. That is Step 6's contract, not this skill's.
- Never run `discipline:patch` if pending/ contained files before this run. The command applies everything; the preflight is the only guard.
- Never create, edit, or delete anything under `.discipline/packets/`. `POST_DEPLOY_FEEDBACK_PACKET.md` is immutable evidence of a specific deploy AND a router signal for Step 4 origin resolution.
- Never edit `task_plan.md`. Backlog changes belong to Step 4; if a finding demands one, record it as a priority-change decision and Step 4 produces the `TASK_PLAN_PATCH_BLOCK`.
- Never write code or fix anything, even a "quick one". Capture is the whole job.
- Do not invent, inflate, or complete findings. Record what the operator said, at the severity the operator chose.
- Follow the Step 6 doctrine mapping for sections (bug/UX/performance → Risks, missing feature → Deferred, priority → Decisions). Do not funnel everything into one section.
- This skill is NOT a router signal: it never changes which Step 4 mode applies. The operator chooses `--mode 4-feedback` explicitly (Fase 1 rule).
- Dated entries are append-only history: never rewrite a previous intake entry, including your own from an earlier run.
