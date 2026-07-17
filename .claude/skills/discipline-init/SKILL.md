---
name: discipline-init
description: "One-shot bootstrap for a new Discipline Loop project. Clones the lane template, runs npm install, verifies dependencies, initializes discipline.md with a chosen profile, and produces the first paste-ready output. Triggers on /discipline-init <lane>, 'init project', 'start template', 'bootstrap a new app'."
---

# /discipline-init - One-shot bootstrap of a Discipline Loop project

This skill is "Day 0": it clones the template repo for the chosen lane, installs dependencies, verifies everything boots, and leaves the user ready to run `/discipline-step0a` (validate the idea) or `/discipline-step1` (PRD) depending on where they are in the pipeline.

NOTE: the skill does not pick the lane for the user. If you are unsure which lane to use, first run `/discipline-step0a` (which produces IDEA_VALIDATION_PACKET) and/or consult the lane selection guide in The App Discipline vault (sold separately). Then invoke this skill with the confirmed lane.

## What the user sees

1. The skill confirms the lane (`web` / `mobile` / `desktop` / `extension`).
2. It asks for the project name and initial profile (default `SHARED_SYNC` per NN #6).
3. It clones the official template from GitHub into the chosen directory.
4. It runs `npm install` and verifies there are no install errors.
5. It checks Node >= 22, Git >= 2.40 (per the non-programmer setup guide in the vault, sold separately).
6. It initializes `discipline.md §0` with switches based on the chosen profile (via `discipline:hydrate` if the script exists).
7. It offers to run the lane's dev command (`npm run dev`; `npm run start` on Mobile/Expo) to verify the app boots.
8. It suggests the next command: `/discipline-step0a` (if the idea is not validated) or `/discipline-step1` (if it already is).

## Prerequisites

- Node.js >= 22 installed (verify with `node --version`).
- Git installed (verify with `git --version`).
- Internet connection (needed to clone the template).
- For the `mobile` lane: optionally `npm install -g eas-cli` for later deploys.
- For the `desktop` lane: optionally the Rust toolchain installed (Tauri needs `cargo` for native builds).

---

## Internal implementation

### Phase 0: Verify prerequisites

Run and capture:
```bash
node --version    # must be >= 22
git --version     # must be >= 2.40
npm --version     # should exist alongside node
```

If node < 22 or git is missing:
```
Missing prerequisites:
- <list>

Before continuing, install what is missing:
1. Node.js >= 22: https://nodejs.org/en/download
2. Git: https://git-scm.com/downloads

If you are a non-programmer, see the step-by-step non-programmer setup guide in the vault (sold separately).
```

Stop if anything is missing.

### Phase 1: Gather inputs

Ask the user for:
- **Lane** (web / mobile / desktop / extension). If it was not passed as an argument, ask.
- **Project name** (slug-friendly, e.g. `my-app`).
- **Target directory** (default: current directory + project name).
- **Initial profile** (default SHARED_SYNC; options: LITE, SHARED_SYNC, LAUNCH, PROD). If LITE, also offer `BACKEND_PROVIDER=LOCAL_ONLY`.

Validate:
- Lane is one of the 4 official lanes.
- Name is slug-friendly (regex `/^[a-z0-9-]+$/`).
- Target directory does not exist or is empty.

### Phase 2: Map lane to template URL

| Lane | Template URL | Note |
|---|---|---|
| `web` | `https://github.com/TheAppDiscipline/tad-template-web.git` | React + Vite + TS, default if unsure |
| `mobile` | `https://github.com/TheAppDiscipline/tad-template-mobile.git` | Expo + React Native + TS |
| `desktop` | `https://github.com/TheAppDiscipline/tad-template-desktop.git` | Tauri v2 + React + Vite |
| `extension` | `https://github.com/TheAppDiscipline/tad-template-extension.git` | WXT + React + TS, MV3 |

### Phase 3: Clone the template

```bash
git clone --depth 1 <template-url> <project-dir>
cd <project-dir>
rm -rf .git    # remove the template's history
git init
git add .
git commit -m "Initial commit from tad-template-<lane>"
```

If the clone fails (network, private repo):
- For private repos, suggest `gh auth login` or `git config --global credential.helper`.
- For network problems, suggest `git clone https://...` with `--config http.proxy=` if it applies.

### Phase 4: Install dependencies

```bash
cd <project-dir>
npm install
```

Capture warnings and errors. If npm install fails:
- Clean the cache: `npm cache clean --force` and retry.
- If it persists, show the error and point the user to the common gate errors guide (Windows / local environment section) in the vault (sold separately), or the equivalent for their OS.

Verify that `tools/discipline/` exists and that `package.json` has `discipline:*` scripts. If not, the clone failed or the template is corrupt.

### Phase 5: Initialize discipline.md with the profile

Run:
```bash
npm run discipline:hydrate
```

If the script exists (all official templates have it post-Wave 3.1), it generates `discipline.md` with the default switches. Then apply a patch to adjust the profile if it differs from the default:

```bash
# Only if profile != SHARED_SYNC (the template default)
echo "<patch block to set PROFILE=<profile>>" > .discipline/patches/pending/init-profile.md
npm run discipline:patch
```

If `discipline:hydrate` does not exist (old template), create a minimal `discipline.md` manually with switches:

```markdown
# discipline.md

## 0) Profile

LANE=<lane>
PROFILE=<profile>
BACKEND_PROVIDER=<supabase|firebase|local_only>
AUTH_MODE=<magic_link|none>
COLLAB_MODE=<collaborative|single_user>
SYNC_MODE=<fast_ui|server_authoritative|none>
AI_FEATURES=<enabled|none>
```

### Phase 6: Verify boot (optional)

Offer the user:
```
Do you want to verify that it boots? This runs the lane's dev command for 10 seconds to confirm the bundler builds the app without errors. (Y/N)
```

If Y, run the lane's dev command in the background (`npm run dev &`; on Mobile/Expo the script is `npm run start &` — there is no `dev`), wait 10s, and verify:
- Web/Desktop: HTTP 200 on localhost:5173 or equivalent.
- Mobile: Expo CLI prints the QR without errors.
- Extension: WXT prints "ready" without errors.

Stop the dev server. Report the result.

### Phase 7: Summary and next step

```
Discipline Loop project initialized in <directory>.

Lane: <lane>
Profile: <profile>
Switches: <BACKEND, AUTH, SYNC, AI>

Structure created:
- .discipline/ (packets, patches, paste-ready)
- .claude/ (bundled skills, settings)
- discipline.md, task_plan.md, findings.md, progress.md
- tools/, src/, tests/

Verification:
- ✓ Node <version>
- ✓ Git <version>
- ✓ npm install complete (<N> packages)
- ✓ tools/discipline/ present
<if the boot verification ran:>
- ✓ the lane's dev command boots without errors

Recommended next step:
<if IDEA_VALIDATION_PACKET does not exist:>
1. Validate the idea: `/discipline-step0a` (10-30 min, uses real WebSearch)
2. If GO, generate the PRD: `/discipline-step1` (30-60 min)

<if you already have a validated idea:>
1. Generate the PRD: `/discipline-step1` with your idea as input.

For project diagnostics at any time: `/discipline-doctor`.
Full skills catalog: see the Discipline Loop skills library in the vault (sold separately).

Welcome to Discipline Loop.
```

### Phase 8: Logging

Record in `findings.md §Audits`:
```markdown
- <date> · /discipline-init · lane=<lane> · profile=<profile> · template=<url> · node=<version>
```

---

## Error handling

- `git clone` fails: see Phase 3.
- `npm install` fails: see Phase 4.
- Target directory already exists and is not empty: ask whether to overwrite, abort, or change the name.
- No internet: detect via `ping github.com` or equivalent; warn the user.
- Invalid profile: reject and show the valid options.
- Invalid lane: reject and show the 4 official lanes with a short description.

---

## Critical rules

- Do not overwrite an existing repo without explicit confirmation.
- Do not commit automatically beyond the initial commit.
- Do not install optional deps (eas-cli, Rust) unless the user explicitly asks.
- Do not skip the Node/Git version check; skipping it produces mysterious errors in later steps.
- Do not assume the user wants to clone the latest main; offer `--ref` or `--tag` for reproducibility if the user needs it.
- Target time: 5-15 min total (3-5 clone + install + 30s hydrate + 10s verification).
- For non-programmers, this skill may be their FIRST invocation. Be extra explanatory in errors and next steps.
