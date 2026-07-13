---
name: discipline-launch-readiness
description: "Validate Gate D (Launch) or Gate E (PROD) readiness from .discipline/scorecard.yaml. Wraps the discipline:validate:launch parser into a human-readable table for non-technical users. Triggers on /discipline-launch-readiness, 'check launch readiness', 'am I ready to ship', 'Gate D readiness'."
---

# /discipline-launch-readiness - Validate Gate D Launch or Gate E PROD readiness

This skill runs the scorecard-as-code parser (`discipline:validate:launch` or `:prod`), interprets the raw output as a readable table, and returns "ready to launch" or "these N items are missing" with a concrete action for each gap.

NOTE: the skill does NOT modify scorecard.yaml. It only reads and reports. If items are missing, the user marks them `done` with evidence after actually completing them.

## What the user sees

1. The skill checks that `.discipline/scorecard.yaml` exists. If not, it offers to generate the skeleton from the launch-vs-PROD scorecard-as-code template in The App Discipline vault (sold separately).
2. It detects the mode automatically by reading `meta.profile_target` from the YAML, or asks the user if it is ambiguous.
3. It runs the corresponding parser and captures output + exit code.
4. It formats the output into a readable table: id, name, status, evidence, action if failing.
5. It summarizes at the end: "X/Y criticals OK, ready" or "list of pending items by priority".
6. It logs the run to `findings.md §Audits` automatically.

## Prerequisites

- `.discipline/scorecard.yaml` exists (if not, it offers to create it).
- `tools/discipline/validate-scorecard.ts` and the `discipline:validate:launch|prod` scripts are available in package.json.
- `discipline.md §0` with PROFILE defined (LAUNCH or PROD so there is something applicable to validate).
- `js-yaml` installed (it is a devDep of the template; if missing, `npm install`).

---

## Internal implementation

### Phase 0: Check PROFILE and scorecard.yaml

Read `discipline.md`. Extract `PROFILE`. If it is `LITE` or `SHARED_SYNC`, warn:

```
Current PROFILE: <profile>. Gate D/E applies only to LAUNCH or PROD.

If you want to validate readiness to move up to LAUNCH:
1. Define the criteria in `.discipline/scorecard.yaml` (the template is the launch-vs-PROD scorecard-as-code material in The App Discipline vault (sold separately), §4.1).
2. Mark status `done` when you complete each item with its evidence.
3. Run this skill again when you are ready for Gate D.

Stop here, or continue with `--force` to see the parser dry-run.
```

If `PROFILE` is LAUNCH or PROD, check that `.discipline/scorecard.yaml` exists. If not:

```
.discipline/scorecard.yaml does not exist. PROFILE=<profile> requires a scorecard.

Options:
1. Generate the skeleton now (I create the file with the canonical template from 65a §4.1; you fill it in with evidence).
2. Stop so you can review the doctrine first.

Choice: <1|2>
```

If they choose 1, generate a minimal skeleton with the 8 Launch criticals + 7 recommended (per 65a §3) + meta.profile_target.

### Phase 1: Detect mode

Read `meta.profile_target` from scorecard.yaml. If:
- `LAUNCH` -> mode is `launch`.
- `PROD` -> mode is `prod` (includes launch + prod criticals).
- Absent or inconsistent with the PROFILE in discipline.md -> ask the user which mode they want.

### Phase 2: Run the parser

```bash
npm run discipline:validate:<mode>
```

Capture stdout, stderr, exit code.

If it fails because `js-yaml` is not installed: ask the user to run `npm install` before continuing.

If it fails because scorecard.yaml is malformed: show the parser error and point to the scorecard schema in the vault (sold separately, 65a §4.1).

### Phase 3: Post-process the output into a readable table

The parser returns:
- How many criticals are `done` / `not_done` / `deferred`.
- How many recommended items are `done` / `not_done`.
- Items with a past `expires_on`.
- Applicable conditionals (only in mode=prod).

Reformat into a Markdown table:

```markdown
## Gate <D|E> Launch Readiness Report

**Profile target:** <LAUNCH|PROD>
**Generated:** <date>
**Scorecard:** .discipline/scorecard.yaml (last_updated: <date from meta>)

### Criticals (block if not done)

| ID | Name | Status | Evidence | Action if failing |
|---|---|---|---|---|
| L01 | Privacy Policy published at /privacy | DONE | URL: https://app.com/privacy | OK |
| L02 | ToS published at /terms | NOT_DONE | (empty) | Create with `/discipline-legal-init` or copy the template at `Legal Templates/terms-of-service.md.template` |
| ... | ... | ... | ... | ... |

### Recommended (warning, non-blocking)

| ID | Name | Status | Evidence | Notes |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

### Summary

- Criticals: <N done> / <total> · <blockers: how many pending>
- Recommended: <N done> / <total>
- Deferred with a past expires_on: <N> (escalate to fail hard)
- Applicable conditionals: <N> (PROD only)

### Verdict

<READY | NOT READY>

<If NOT READY:>
Blockers in order of impact:
1. <item ID> · <name> · <concrete action>
2. ...

Estimated time to close: <sum of effort per item>.

<If READY:>
Gate <D|E> is green. You can set PROFILE=<LAUNCH|PROD> in discipline.md and proceed with the release.

Remember:
- Re-run this skill before every subsequent release.
- Items with expires_on need a retrospective before that date.
```

### Phase 4: Log to findings.md

Add an entry to `findings.md §Audits`:

```markdown
- <date> · /discipline-launch-readiness · mode=<launch|prod> · verdict=<READY|NOT_READY> · criticals=<N done>/<total> · blockers=<short list>
```

If `findings.md §Audits` does not exist, create it.

### Phase 5: Summary to the user

If READY:
```
Gate <D|E> Launch Readiness: READY

<N>/<total> criticals done. You can proceed with the release.

Next:
- Set PROFILE in discipline.md (if it is not <LAUNCH|PROD> yet).
- Run `npm run gate:strict` before the release.
- Smoke test on a real device with a clean account post-deploy.
```

If NOT READY:
```
Gate <D|E> Launch Readiness: NOT READY

<N> critical blockers:
1. <id> · <name> · <action>
2. ...

Suggestion: close the first blocker, then run this skill again. The move is not to knock down blockers in bulk without verifying.

If a blocker needs tools or knowledge beyond your reach, consider:
- /discipline-legal-init for Privacy Policy + ToS + breach runbook.
- /discipline-audit prompt-7 for test coverage.
- /discipline-audit prompt-12 for a11y WCAG AA.
- the quick-troubleshooting guide in the vault (sold separately) if you get stuck on something undocumented.
```

---

## Error handling

- `validate-scorecard.ts` does not exist: the template is not post-Wave 3.1. Suggest updating to the current version or installing the script manually per the implementation-status guide in the vault (sold separately).
- Parser exit code != 0 but empty output: probably an exception. Show stderr and point the user to `npm run discipline:validate:launch -- --verbose` for diagnosis.
- `expires_on` past on many recommended items: warning, not a fail. Suggest a scope retrospective.
- meta.profile_target absent: ask the user which profile target they chose (LAUNCH or PROD).

---

## Critical rules

- Do not mark items as `done` from the skill. Only the user decides when an item is met (with evidence).
- Do not skip critical items. `deferred` on a critical = fail hard, no exceptions.
- Recommended items can be `deferred` with `deferred_reason` + a future `expires_on`.
- If `expires_on` passes, they escalate to `fail hard` automatically (no need to re-mark).
- Do not disable NN rules to pass the gate. If a rule does not apply, mark it `not_applicable` with justification in `notes`.
- Target time: 30 seconds to validate and report. If it takes longer, the scorecard YAML is probably too large or the parser has a bug.
