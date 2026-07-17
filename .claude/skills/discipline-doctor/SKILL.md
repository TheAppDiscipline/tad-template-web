---
name: discipline-doctor
description: "Diagnose Discipline Loop project health in 30 seconds. Reports profile, last gate, pending packets/patches, progress.md drift, scorecard status. Triggers on /discipline-doctor, 'check project status', 'doctor project', 'why is gate failing'."
---

# /discipline-doctor - Fast diagnosis of a Discipline Loop project

This skill gathers the current project state in a single pass and returns a readable tabular report. It does not modify files. It does not run heavy gates. It requires no internet.

## What the user sees

1. The skill reads 5 sources: `discipline.md`, `progress.md`, `.discipline/packets/`, `.discipline/patches/pending/`, git status.
2. If `PROFILE>=LAUNCH`, it tries to read `.discipline/scorecard.yaml`.
3. It reports a table with: current profile, last gate run, packets generated/applied, pending patches, `progress.md` vs git drift, scorecard status.
4. It suggests one concrete next action (a single step).

## Prerequisites

- Initialized project (`.discipline/` and `discipline.md` exist).
- If the project was just cloned without `.discipline/`, say so and suggest `npm run discipline:hydrate`.
- Does not require any green gate to run.

---

## Internal implementation

### Phase 0: Verify the project is initialized

Verify these exist:
- `discipline.md` at the root
- `.discipline/` directory
- `package.json` with `discipline:*` scripts

If any is missing:
```
This project does not appear to have Discipline Loop initialized.

Missing: <file or directory>

Possible causes:
1. Repo just cloned without hydrate. Run: npm run discipline:hydrate
2. Not a Discipline Loop template. Verify you cloned tad-template-{web,mobile,desktop,extension}.

Stop here until resolved.
```

### Phase 1: Extract PROFILE and switches

Read `discipline.md` and extract the `§0 Switches` section (or equivalent). Capture:
- `PROFILE` (LITE / SHARED_SYNC / LAUNCH / PROD)
- `LANE` (WEB / MOBILE / DESKTOP / EXTENSION)
- `BACKEND_PROVIDER`
- `AUTH_MODE`
- `AI_FEATURES`

If `PROFILE` is not declared, flag a warning: "discipline.md does not declare PROFILE. The template ships `PROFILE: LITE`; declare it explicitly (when undeclared, the Discipline Loop boot protocol falls back to SHARED_SYNC)."

### Phase 2: Read `progress.md`

Capture:
- Total number of lines
- Number of slices marked done (count of `- [x]` or `## Slice` with status done)
- Last 5 entries (title and date if present)
- If it has an `§Open Errors` section, list it

If `progress.md > 150 lines`: warning about NN #8 (Context Management).

### Phase 3: Inventory `.discipline/packets/`

List the files in `.discipline/packets/`. Classify them:
- Validated packets (`.md` extension without `.draft` in the name)
- Draft packets (`.draft.md`)
- Superseded packets (`.superseded.md`)

Detect anomalous pairs:
- If `X.draft.md` exists but not `X.md`, the draft has not been validated yet.
- If both `X.draft.md` and `X.md` exist, the draft was not cleaned up after validation.

### Phase 4: Inventory `.discipline/patches/pending/`

Count the files in `.discipline/patches/pending/`. If there are any:
- List the file names
- Mark as BLOCKER if count > 0 (you cannot move forward without applying them)

Suggest: `npm run discipline:patch` (or `npm run discipline:patch:dry-run` for a preview).

### Phase 5: Git status and log

Run (mentally or with Bash):
- `git status --short` to see uncommitted changes
- `git log --oneline -5` to see the last 5 commits
- `git branch --show-current` for the current branch

Detect drift between `progress.md` and the git log:
- Slices declared done in `progress.md` that have NO associated commit
- Relevant commits that do NOT appear in `progress.md`

### Phase 6: Scorecard YAML (only if PROFILE >= LAUNCH)

If `PROFILE` is LAUNCH or PROD:
- Verify that `.discipline/scorecard.yaml` exists
- If it exists, try running `npm run discipline:validate:launch` (or `:prod`) and capture the exit code + output
- If it does not exist, mark a BLOCKER: "PROFILE=LAUNCH+ requires scorecard.yaml. Create it from the launch-vs-PROD scorecard-as-code template in The App Discipline vault (sold separately)."

### Phase 7: Generate the report

Output in tabular format:

```markdown
# Discipline Loop · Project status

**Generated:** <current date>
**Branch:** <git branch>
**Lane:** <LANE>
**Profile:** <PROFILE>

## Summary

| Area | Status | Detail |
|---|---|---|
| Profile declared | OK / WARNING | <PROFILE or "not declared, default SHARED_SYNC"> |
| `progress.md` | OK / WARNING | <N lines; warning if >150> |
| Slices done | <N> | Last: <title of the last slice> |
| Validated packets | <N> | <short list of the main ones> |
| Draft packets | <N> | <list; 0 if none> |
| Pending patches | OK / BLOCKER | <N files in `.discipline/patches/pending/`> |
| Open errors | <N> | <from progress.md §Open Errors> |
| Uncommitted changes | <N> | <from git status --short> |
| Drift progress vs git | OK / WARNING | <description if there is drift> |
| Scorecard YAML | N/A or OK / BLOCKER | <only if PROFILE>=LAUNCH; "not applicable" if LITE/SHARED_SYNC> |

## Blockers

<if there are BLOCKERS, list them in order of impact. If none, say "No blockers detected.">

## Warnings

<if there are warnings, list them. If none, say "No warnings.">

## Suggested next action

<a single concrete step, based on the current state>
```

**Rules for "Suggested next action":**
- If there are pending patches, always suggest applying them first.
- If there are unvalidated draft packets, suggest the producer step that should validate them.
- If the scorecard YAML is missing and PROFILE>=LAUNCH, suggest creating it.
- If everything is OK and there is a next slice in `task_plan.md`, suggest opening the matching `paste-ready/step-X-input.md`.
- If everything is OK and there is no next slice, suggest running the next pipeline step or closing the batch with DEPLOY_READINESS_PACKET.

### Phase 8: Logging

Do not update `progress.md`. Do not run gates. Do not touch packets.

Just record the run in `.discipline/run-log.md` with a minimal entry:

```markdown
- <date> · /discipline-doctor · status: <profile>/<N blockers>/<N warnings>
```

If `discipline:log` is available:
```bash
npm run discipline:log -- --step doctor --tool "/discipline-doctor" --notes "blockers=N, warnings=M"
```

Otherwise, add the line to the end of `run-log.md` manually.

---

## Error handling

- If `discipline.md` does not parse: report the parse error and show the first 30 lines for human diagnosis.
- If `package.json` has no `discipline:*` scripts: the project may be pre-Wave 3 or not an official template. Report the detected version (read version from package.json).
- If `npm run discipline:validate:launch` fails with exit != 0 but produces output: include the first 20 lines of the output in the report as "Scorecard errors".
- If git is not initialized: mark git status as N/A and continue.

---

## Critical rules

- Do not modify files. Read-only.
- Do not run `npm run gate` or `gate:full` (they are heavy; the doctor is lightweight).
- Do not invoke other skills.
- The report must fit in ~30 readable lines. If you need more detail, offer to drill down on request ("Want the packet details?").
- The report must be interpretable by a non-programmer: use glossary terms (see the glossary in The App Discipline vault, sold separately), not internal tooling jargon.
- Always suggest ONE next action, not a list. If there are multiple blockers, prioritize the one that unblocks the rest.
- Total target time: 30 seconds of output to the user.
