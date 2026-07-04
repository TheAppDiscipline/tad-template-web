---
name: discipline-step6
description: "Automate Discipline Loop Step 6: deploy the build candidate, verify it with real usage, and produce POST_DEPLOY_FEEDBACK_PACKET. Triggers on /discipline-step6 or 'run step 6', 'deploy and verify', 'post-deploy feedback'."
---

# /discipline-step6 - Automate Step 6 of the Discipline Loop pipeline

This skill runs the full Step 6: it checks gates, runs the build and deploy for the lane, runs automated verification if the Playwright MCP is available, captures operator feedback, and produces the POST_DEPLOY_FEEDBACK_PACKET.

This skill is more interactive than the previous ones: it runs real commands and asks the operator to confirm at several points.

## What the user sees

1. The skill verifies that the Step 5 inputs exist
2. Runs gates and build
3. Proposes the deploy command based on lane and hosting
4. Runs post-deploy verification (Playwright if available, manual if not)
5. Asks the operator feedback questions
6. Generates POST_DEPLOY_FEEDBACK_PACKET and patch blocks
7. Assembles the paste-readies and reports the next step

## Prerequisites

- Step 5 completed (`DEPLOY_READINESS_PACKET` in `.discipline/packets/`)
- Build candidate ready (gates passing)
- Node.js + npm
- Deploy credentials configured for the lane (Vercel, EAS, Railway, etc.)

---

## Internal implementation

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

Save to: `.discipline/patches/pending/`

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

- If `DEPLOY_READINESS_PACKET` does not exist: stop with "Complete the slices in Step 5 first."
- If gates fail: stop. Do not deploy with broken gates.
- If the build fails: stop. Report the error output.
- If the deploy fails: report the error, do not generate POST_DEPLOY_FEEDBACK_PACKET (there was no real deploy).
- If Playwright is not available: skip automated verification, continue with manual feedback.
- If the operator does not answer all the feedback questions: generate the packet with what is available. Unanswered questions are marked "N/A - not evaluated".
- If `npm run discipline:patch` or `discipline:assemble` fail: report the error and continue. The files are already in `.discipline/packets/`.

---

## Critical rules

- Do not deploy without gates passing. Never. No exceptions.
- Do not deploy without the operator's explicit confirmation. The skill proposes, the operator approves.
- Do not invent feedback. The POST_DEPLOY_FEEDBACK_PACKET reflects what the operator said, not what Claude infers.
- Do not assume the "recommended branch". Ask the operator what they want to do next.
- The Playwright MCP is complementary, not a substitute for human verification.
- The deploy commands depend on the LANE and HOSTING. Read both from discipline.md, do not assume.
- If this is the project's first deploy, include verification of the platform skeleton (manifest, icons, etc.).
- Log EVERYTHING in the run-log, including deploy type, issues found, and the next branch.
