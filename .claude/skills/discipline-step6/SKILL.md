---
name: discipline-step6
description: "Automate Discipline Loop Step 6: deploy the build candidate, verify it with real usage, and produce POST_DEPLOY_FEEDBACK_PACKET. Triggers on /discipline-step6 or 'run step 6', 'deploy and verify'."
---

# /discipline-step6 - Automate Step 6 of the Discipline Loop pipeline

This skill runs the full Step 6: it checks gates, runs the build and deploy for the lane, runs automated verification if the Playwright MCP is available, captures operator feedback, and produces the POST_DEPLOY_FEEDBACK_PACKET.

This skill is more interactive than the previous ones: it runs real commands and asks the operator to confirm at several points.

## What the user sees

1. The skill checks that no unrelated patches are pending, and stops if there are (preflight)
2. It verifies that the Step 5 inputs exist
3. Runs gates and build
4. Proposes the deploy command based on lane and hosting
5. Runs post-deploy verification (Playwright if available, manual if not)
6. Asks the operator feedback questions
7. Generates POST_DEPLOY_FEEDBACK_PACKET and patch blocks
8. Assembles the paste-readies and reports the next step

## Prerequisites

- Step 5 completed (`DEPLOY_READINESS_PACKET` in `.discipline/packets/`)
- Build candidate ready (gates passing)
- Node.js + npm
- `.discipline/patches/pending/` empty (the skill verifies this and stops if not)
- Deploy credentials configured for the lane (Vercel, EAS, Railway, etc.)

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

### Phase 0: Verify inputs

Read these files. If the required one is missing, stop.

**Required (one of the two):**
1. `.discipline/paste-ready/step-6-input.md` (preferred)
2. `.discipline/packets/DEPLOY_READINESS_PACKET.md` (direct source)

If neither exists:
```
DEPLOY_READINESS_PACKET is missing. Complete the slices in Step 5 first.
```

**Project context (always read):**
3. `discipline.md` — extract: LANE, PROFILE, HOSTING, AUTH_MODE, BACKEND_PROVIDER, AI_FEATURES
4. `task_plan.md`
5. `findings.md`
6. `progress.md`

**Optional (read if they exist):**
7. `.discipline/packets/STEP_4_EXECUTION_PACKET.md` — to verify expected flows
8. `.discipline/packets/UI_HANDOFF_PACKET.md` — for visual verification

### Phase 1: Pre-deploy

**Sub-phase 1A: Gates**

```bash
npm run gate
```

If AI_FEATURES=enabled:
```bash
npm run ai:smoke
```

If any gate fails, stop:
```
Gate failed. Fix the errors before deploying.
<gate output>
```

Report: `✓ Pre-deploy: Gates OK`

**Sub-phase 1B: Build**

Run the build for the LANE:

| LANE | Build command | Expected output |
|---|---|---|
| WEB | `npm run build` | `dist/` with no errors |
| WEB_SSR | `npm run build` | `.next/` with no errors |
| MOBILE | No local build (EAS builds in the cloud) | N/A |
| DESKTOP | `npm run tauri build` | Native bundle |
| BACKEND | `npm run build` (if it exists) | Build with no errors |
| CLI | `npm run build` (if it exists) | Build with no errors |

If the build fails, stop and show the error output.

Report: `✓ Pre-deploy: Build OK`

**Sub-phase 1C: Pre-deploy checklist**

Present the checklist for the LANE. Ask the operator to confirm.

For WEB:
```
Pre-deploy checklist (Web):
- [ ] Build produces dist/ with no errors or critical warnings
- [ ] manifest.webmanifest has a real name and icons (not placeholders)
- [ ] Service worker registered in index.html or main.tsx
- [ ] Environment variables point to production
- [ ] .env is NOT in the repo (check .gitignore)

All set? (yes/no)
```

For MOBILE:
```
Pre-deploy checklist (Mobile):
- [ ] app.json has a real bundleIdentifier
- [ ] eas.json configured with preview and production profiles
- [ ] Production environment variables configured in EAS secrets
- [ ] Real icons and splash screen (not placeholders)

All set? (yes/no)
```

For BACKEND:
```
Pre-deploy checklist (Backend / Services):
- [ ] Valid Dockerfile (if applicable)
- [ ] GET /health returns 200
- [ ] Production environment variables configured in the hosting
- [ ] CORS configured with explicit origins (not *)

All set? (yes/no)
```

For WEB_SSR:
```
Pre-deploy checklist (Web SSR):
- [ ] Build produces .next/ with no errors
- [ ] Metadata (title, description) updated
- [ ] Environment variables configured in Vercel/hosting
- [ ] API routes respond correctly

All set? (yes/no)
```

For DESKTOP and CLI: adapt to their deploy target.

Do not continue if the operator says "no". Ask what is missing.

### Phase 2: Deploy

**Determine the deploy command.** Based on LANE and HOSTING from discipline.md:

| LANE | HOSTING | Command |
|---|---|---|
| WEB | Vercel | `npx vercel --prod` |
| WEB | Cloudflare | `npx wrangler pages deploy dist` |
| WEB | Netlify | `npx netlify deploy --prod --dir=dist` |
| WEB_SSR | Vercel | `npx vercel --prod` |
| WEB_SSR | Cloudflare | `npx wrangler pages deploy .next` |
| MOBILE | EAS | `eas build --profile production --platform all` |
| DESKTOP | GitHub Releases | `npm run tauri build` + upload binaries (see recipe 36e) |
| EXTENSION | Chrome Web Store + Firefox AMO | `npm run zip` -> upload `.output/*-chrome.zip` to CWS ($5 one-time) + `.output/*-firefox.zip` to AMO (free). Review takes 1-5 days the first time. See recipe 36 for Extension. |
| BACKEND | Railway | `railway up` (default MVP; $5/mo hobby plan) |
| BACKEND | Fly.io | `fly deploy` (only for edge multi-region with a budget; no free tier since 2024) |
| CLI | npm | `npm publish` |
| CLI | PyPI | `python -m twine upload dist/*` |

**Ask for confirmation before running:**

```
I'm about to run the deploy:
> <command>

Proceed? (yes/no)
```

Run only if the operator confirms. If they say "no", ask what they would prefer to do.

Report the deploy result (success, or error with output).

**Sub-phase 2B: Post-deploy verification**

If the Playwright MCP is available and the LANE has a UI (WEB, MOBILE with a webview, WEB_SSR, DESKTOP):

Run automated verification. The prompt for Playwright depends on the LANE:

For WEB:
```
Use the Playwright MCP to navigate to [production URL].
Verify in order:
1. The page loads with no console errors
2. Login works end-to-end (if AUTH_MODE != NONE)
3. The core MVP action completes
4. Navigating to a direct route does not 404 (SPA routing)
5. The empty state displays correctly
```

For WEB_SSR:
```
Use the Playwright MCP to navigate to [URL].
Verify in order:
1. The initial page loads with SSR content visible
2. No hydration errors in the console
3. Login works end-to-end (if applicable)
4. The core MVP action completes
5. /api/health returns 200
```

If Playwright is not available, report:
```
Playwright MCP not available. Manual verification recommended.
```

Report the verification results.

### Phase 3: Capture feedback

Ask the operator these questions:

```
Post-deploy feedback:

1. Did the main flow work end-to-end? (login -> core action -> result)
2. Did you hit any problems? (bugs, errors, broken flows)
3. Was there any UX friction? (confusing, slow, ugly)
4. Did real usage surface any new feature ideas?
5. Any architecture concerns? (performance, security, data)
6. What should happen next? (more slices / fix bugs / go to product)
```

Wait for the operator's answers.

### Phase 4: Generate outputs

**POST_DEPLOY_FEEDBACK_PACKET:**

```markdown
# POST_DEPLOY_FEEDBACK_PACKET

STATUS: ready
SOURCE_STEP: Step 6
GENERATED: <date>
DEPLOY_TYPE: <preview | production>
DEPLOY_TARGET: <URL or destination>

## Deploy summary
- Lane: <LANE>
- Hosting: <HOSTING>
- Gates: passed
- Build: clean
- Playwright verification: <passed / skipped / issues found>

## Main flow status
<answer to question 1>

## Issues found
<answer to question 2, structured by severity>

## UX frictions
<answer to question 3>

## Feature ideas
<answer to question 4>

## Architecture concerns
<answer to question 5>

## Recommended branch
<based on answer 6:>
- If "more slices" or "fix bugs": Step 4 feedback loop
- If "go to product": Step 7 productization
```

Save to: `.discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md`

**Patch blocks (only if the feedback changes the backlog or findings):**

If there are issues, new features, or new risks:
- `TASK_PLAN_PATCH_BLOCK`: add new items to the backlog
- `FINDINGS_APPEND_BLOCK`: document frictions, risks, decisions

Save to: `.discipline/patches/pending/`, one file per block, named `<BLOCK_NAME>_step6_<YYYY-MM-DD-HHMMSS>.md` with this run's timestamp. The stamp is what makes the name unique: without it, a second run (or a retry after a failure) silently overwrites the pending patch of an earlier one.

### Phase 5: Post-processing

Apply the patches if any were generated:
```bash
npm run discipline:patch
```

Determine the next step based on the "Recommended branch" in the packet:

If it is "Step 4 feedback loop":
```bash
npm run discipline:assemble -- --step 4-feedback
```

If it is "Step 7 productization":
```bash
npm run discipline:assemble -- --step 7
```

Log it in the run-log:
```bash
npm run discipline:log -- --step 6 --tool "Claude" --notes "Automated via /discipline-step6. Deploy: <type>. Issues: <N>."
```

### Phase 6: Summary

Show the user:

```
Step 6 complete.

Deploy: <type> to <destination>
Gates: passed
Build: clean
Verification: <Playwright passed / manual>

Feedback captured:
- Issues: <N>
- New features: <N>
- Frictions: <N>

Files generated:
- .discipline/packets/POST_DEPLOY_FEEDBACK_PACKET.md
<if applicable:>
- Patch blocks applied: <N>

Next step:
<based on the recommended branch>
- /discipline-step4 (feedback loop) -> .discipline/paste-ready/step-4-feedback.md
- /discipline-step7 (productization) -> .discipline/paste-ready/step-7-input.md
```

---

## Error handling

- If the preflight finds pending patches: stop before reading inputs. Never apply work this run did not produce as a side effect of running this step.
- If `DEPLOY_READINESS_PACKET` does not exist: stop with "Complete the slices in Step 5 first."
- If gates fail: stop. Do not deploy with broken gates.
- If the build fails: stop. Report the error output.
- If the deploy fails: report the error, do not generate POST_DEPLOY_FEEDBACK_PACKET (there was no real deploy).
- If Playwright is not available: skip automated verification, continue with manual feedback.
- If the operator does not answer all the feedback questions: generate the packet with what is available. Unanswered questions are marked "N/A - not evaluated".
- If `npm run discipline:patch` or `discipline:assemble` fail: report the error and continue. The files are already in `.discipline/packets/`.

---

## Critical rules

- Never run `discipline:patch` if `pending/` contained files before this run. The command applies everything in the directory with no per-file selection; the preflight is the only guard.
- Do not deploy without gates passing. Never. No exceptions.
- Do not deploy without the operator's explicit confirmation. The skill proposes, the operator approves.
- Do not invent feedback. The POST_DEPLOY_FEEDBACK_PACKET reflects what the operator said, not what Claude infers.
- Do not assume the "recommended branch". Ask the operator what they want to do next.
- The Playwright MCP is complementary, not a substitute for human verification.
- The deploy commands depend on the LANE and HOSTING. Read both from discipline.md, do not assume.
- If this is the project's first deploy, include verification of the platform skeleton (manifest, icons, etc.).
- Log EVERYTHING in the run-log, including deploy type, issues found, and the next branch.
