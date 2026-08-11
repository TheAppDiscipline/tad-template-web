# Discipline Loop - Project Instructions

This project follows the Discipline Loop methodology. `discipline.md` is the law. Read it before any implementation.

## Core Rules

- **Data-First:** contracts before code
- **One Writer Per Slice:** never have two agents editing the same slice
- **Gates before merge:** `npm run gate` must pass before any commit
- **No breaking schema changes** without migrations
- **Self-annealing:** 2 identical error signatures with no material change (evidence, context, hypothesis, strategy) -> stop; escalating the model grants a single third attempt only when you document why more reasoning capacity could change the diagnosis; hard stop at 3 failures of the same gate

## Recommended Pipeline Mode

Use `npm run discipline:watch` as the default operating mode.

That watcher is responsible for:
- reading new packets in `.discipline/packets/`
- extracting patch blocks
- applying patches
- updating `progress.md` after `SLICE_COMPLETION_PACKET`
- assembling the next `paste-ready` handoff

Use `discipline:patch` and `discipline:assemble` manually only as fallback.

## Key Files

| File | Purpose |
|---|---|
| `discipline.md` | Project constitution with switches, contracts and DoD |
| `task_plan.md` | Slice plan with statuses |
| `findings.md` | Decisions, risks and assumptions |
| `progress.md` | Current state, recent slices and open errors |
| `.discipline/packets/` | Handoff packets between pipeline steps |
| `.discipline/patches/pending/` | Patch blocks waiting to be applied |
| `.discipline/paste-ready/` | Assembled handoffs ready to paste into the next tool |
| `.mcp.json.example` | Minimal MCP baseline for this repo |

## Gate Command

```bash
npm run gate        # lint + typecheck + tests + visual token gate
npm run gate:full   # gate + bundle size check
npm run gate:visual # opt-in browser/UI verification (e2e/a11y), lane-specific; see package.json. NOT part of npm run gate
npm run check-db-types  # opt-in (BACKEND_PROVIDER=SUPABASE): DB schema vs committed database.types.ts. In gate:strict; NOT in npm run gate. Fix: npm run db:types:generate
```

## Discipline Automation Scripts

```bash
npm run discipline:patch      # apply pending patches to discipline.md/task_plan.md/findings.md/progress.md
npm run discipline:assemble   # assemble paste-ready file for the next step
npm run discipline:progress   # update progress.md from SLICE_COMPLETION_PACKET
npm run discipline:status     # show pipeline dashboard
npm run discipline:validate   # check pipeline integrity and packet completeness
npm run discipline:migrate-packets  # legacy Step 5 packets -> the v2 contract (dry run; --write applies it)
npm run discipline:gate:changed     # run only the gates the change needs (see Hybrid Gates); npm run gate is unchanged
npm run discipline:metrics -- --slice <id> --base <ref>  # append measured slice size by category
npm run discipline:state-view       # regenerate compact derived state
npm run --silent discipline -- state-view --json # JSON-only stdout (PowerShell: use npm.cmd)
npm run discipline:watch      # auto-run the plumbing on new packets
```

There is no batch-to-cloud script: the former `discipline:codex-batch` depended on a non-public Codex API endpoint and was removed. For parallel or unattended slice execution, use the GitHub lane instead: one branch/PR per slice driven by your cloud agent (Claude Code GitHub Action, Codex cloud, Copilot coding agent), with CI running `npm run gate` on every push (`.github/workflows/ci.yml`) as the merge check.

## Substrate: locks, ledger, and reports

Local, file-based coordination and observability for the pipeline. No daemon, no network, no new dependencies. Runtime state lives under `.discipline/` and is gitignored.

- **Writer lock** (`.discipline/locks/writer.lock`): `apply-patch` and `watch` hold it while mutating `discipline.md` / `task_plan.md` / `findings.md` / `progress.md`, so only one writer touches those files at a time. If a live owner holds it, the command fails with a clear message; a lock older than 3x its TTL is treated as stale and taken over.
- **Slice lease** (`.discipline/locks/slice-<id>.lock`): enforces One Writer Per Slice across processes. `npm run discipline:lease -- acquire|release|status <slice-id> [--force]`. Acquire is atomic; release only removes a lease this process owns (or with `--force`).
- **Kill switch** (`.discipline/STOP`): create this file to pause the watcher. It skips each queued packet with a warning (the packet stays in place) without killing the process. Delete the file to resume.
- **Machine-readable gate** (`npm run discipline:gate:report`, or `discipline gate --json`): re-runs the gate's own steps (parsed from the `gate` script) and writes `.discipline/gate-report.json` (`schema: discipline.gate_report.v1`) with per-step exit codes, durations, `failed_checks`, and an `error_signature`. Exit code is 0 iff every step passed. Plain `npm run gate` is unchanged. `discipline gate --changed` writes the same file under `schema: discipline.gate_report.v2`, adding the files and surfaces the run was scoped to; see Hybrid Gates below.
- **Ledger** (`.discipline/ledger/YYYY-MM.jsonl`): append-only JSONL of pipeline events (`patch_applied`, `gate_result`). `error_signature` normalizes away paths, line numbers, and timestamps, which makes the Repair Budget rule (two identical signatures with no material change -> stop) computable.
- **Diff review** (`npm run discipline:review [-- --staged] [--open]`): renders `git diff` to one self-contained, fully HTML-escaped file under `.discipline/review/<timestamp>.html` for slice review. An empty diff writes nothing.
- **Providers preflight** (`npm run discipline:doctor:providers`, or `discipline:doctor --providers`): advisory checks for Node/git, the agent CLIs (claude/codex/gemini/cursor-agent), OneDrive placement, long-path risk, and Windows helpers. Informational only; it never fails the exit code by itself. Add `--json` to dump the findings.
- **Packet frontmatter** (optional): a packet MAY start with a `---` YAML block (`schema`, `version`, `id`, `status`, optional `slice` / `produced_by`). `discipline:validate` reports invalid frontmatter as warnings only; packets without it are legacy and fine. The markdown body remains canonical.

## Policy hooks and checkpoints (opt-in)

Local mechanisms that make the doctrine self-enforcing. Both are **opt-in by decision (v1.2)**: hooks add per-tool-call latency and can be noisy, so they ship as an example to copy, never enabled by default. The manual flow keeps working unchanged.

- **Policy hooks** (`tools/discipline/hooks/`, wired via `.claude/settings.hooks.example.json`): three plain-Node Claude Code hooks. `pre-tool-guard.mjs` (`PreToolUse`) **denies** `rm -rf` / `rd /s`, `git push --force`/`-f`, `git reset --hard`, `git config` mutations, `curl|wget | sh`, and any read/edit/write of `.env` / `.env.*`; it **asks** (forces the human prompt even in accept-edits mode) for edits to `supabase/migrations/**`, `.github/workflows/**`, `vercel.json`, `package.json`, and `*.rules`, and for `npm install`/`i`/`add`. `stop-gate.mjs` (`Stop`) blocks ending a session that has edited code while `.discipline/gate-report.json` is missing, stale, or failing (single nudge; run `npm run discipline -- gate --json` and respect the Repair Budget). `session-start-header.mjs` (`SessionStart`) injects the FIXED HEADER of `progress.md` as context. To enable, merge the example into `.claude/settings.json`; to disable, remove the `hooks` key. See `tools/discipline/hooks/README.md`. Rationale: policy as mechanism, opt-in by decision.
- **Checkpoints** (`npm run discipline:checkpoint`, or `discipline checkpoint|approve|reject`): approval packets that make a human decision a git-auditable artifact. `checkpoint create --slice <id> --kind pre-commit|scope|deploy [--summary "..."]` writes `.discipline/packets/CHECKPOINT_<KIND>_<slice>_<ts>.md` (frontmatter `status: ready-for-human`) with Summary, Gate (from the latest gate report), Diff (`git diff --stat HEAD`), and a `PENDING` Decision. `approve <packet-file-or-id>` / `reject <..> [--reason "..."]` rewrite the status and fill the Decision; approve refuses unless the status is still `ready-for-human`. Both hold the writer lock and append a `checkpoint_created` / `checkpoint_decided` ledger event.

## Headless runs (autonomy L0-L3)

`discipline run` is a **stateless single-tick reconciler**: one command advances one slice by one tick, then stops. No daemon, no residual state (the files are the state). It reuses the whole substrate and control plane above (assemble, adapters, patch engine, gate report, checkpoints, diff review, locks, ledger). The manual flow keeps working unchanged; headless execution is opt-in.

The autonomy ladder (ceiling configured in discipline.md; invocation flags can only **lower** it, never raise it):

| Level | Name | What runs |
|---|---|---|
| L0 | Manual | Human pastes; tooling only assembles/transports. `discipline run` prints where the paste-ready lives and exits. |
| L1 | Plumbing | `discipline run` assembles the slice paste-ready and exits (patch/progress/assemble automation). No LLM. |
| L2 | Step-confirmed | One headless builder step per tick, with a y/N confirmation before the spawn and a diff review after. |
| L3 | Slice run | Full slice: build -> plumb -> gate -> repair (within budget) -> advisory cross-validation -> **stop before commit** for human review. |
| L4 | GitHub lane only | Unattended, on a remote machine, PR as the review artifact, §7 protected by branch protection. **Never local** (see the GitHub lane section below). |

The ceiling and providers are read from an OPTIONAL `## Autonomy` section in `discipline.md` (not shipped by default; add it only if you want headless runs). Keys are a simple `- key: value` list:

```
## Autonomy
- level: 3
- builder: claude
- validator: gemini
- repair_max: 2
- per_run_usd: 0.50
```

Defaults when the section (or a key) is absent: `level 1`, `builder claude`, `validator gemini`, `repair_max 2`, no cost cap. Malformed values fall back to defaults with a warning. The **validator family must differ from the builder family**; if they collide, a family-different validator is chosen deterministically (gemini -> codex -> claude).

Usage and exit codes:

```
discipline run --slice <id> [--autonomy 0..3] [--dry-run] [--yes] [--allow-dirty] [--no-open] [--timeout-min N]
discipline run --with-llm --provider claude|codex|gemini|cursor --slice <id>   # --provider overrides the builder
discipline cross-validate --with-llm [--provider X]                            # advisory review of the current diff only
```

- **0** green (gate passed, stopped before commit) - **2** config/precondition error (STOP switch, dirty tree without `--allow-dirty`, unknown/not-ready slice, missing `STEP_5_SLICE_PACKET`, bad provider) - **3** parked (rate limit / auth / CLI not found; **never** consumes the repair budget) - **4** stopped by the repair budget (two identical error signatures, or attempts exhausted) - **5** incomplete: the gate may even be green, but the run cannot close its slice (the builder wrote no `SLICE_COMPLETION_PACKET` for the leased slice, wrote one that closes another slice or contradicts itself, wrote two, or the closure could not be recorded). A run that cannot close its slice is never exit 0.

Preconditions for level >=2: a clean working tree (else `--allow-dirty`), the slice present and `ready` in `task_plan.md` §Ready Slices, and a `STEP_5_SLICE_PACKET` for the slice under `.discipline/packets/`. The run takes the slice lease, writes a pre-run tag `disc/run-<id>-pre` (rollback: `git reset --hard <tag>`), logs `run_started` before any spawn, and releases the lease on exit.

**RUN CONTRACT** (appended to the builder prompt): implement ONLY this slice; obey discipline.md contracts; write code + tests; emit patch blocks and a `SLICE_COMPLETION_PACKET` under `.discipline/packets/`; do **not** `git commit`; do **not** touch `.env*`, workflows, or migrations without saying so in the packet; keep the diff under ~500 lines. A terminal run ALWAYS stops before commit: it writes a `pre-commit` checkpoint + a self-contained diff HTML for review, then prints NEXT STEPS (review diff, `discipline approve <checkpoint>`, commit, rollback).

**Crash recovery = re-run.** There is no recovery state to repair: the files are the checkpoint and the ledger records intent before each action. If a prior run crashed (a `run_started` with no `run_finished`) and its lease is stale, `discipline run` warns and continues fresh.

## GitHub lane (L4: unattended slice runs)

The ONLY home for unattended autonomy is a remote runner with a pull request as the review artifact. One blessed path ships with this template:

1. **Gate as the arbiter:** `.github/workflows/ci.yml` already runs `npm run gate` on every push and PR. In your repo settings, make the CI `gate` job a **required status check** on `main` (branch protection or a ruleset).
2. **Protect the never-auto-approve paths:** require review (CODEOWNERS or a ruleset) for `.env*`, `supabase/migrations/**`, and `.github/workflows/**`. That way GitHub enforces the list, not a prompt.
3. **The example workflow:** copy `.github/workflow-examples/agent-slice.yml` into `.github/workflows/`, add the `ANTHROPIC_API_KEY` secret, then label an issue `slice-ready` naming ONE ready slice. The agent implements it on branch `disc/slice-<id>` and opens a PR. You review the PR; the merge is yours.
4. **One writer per slice, cross-machine:** mark the slice `in-progress-cloud` in `task_plan.md` when you hand it to the lane. `discipline run` refuses slices that are not `ready`, so local and cloud never collide; the workflow's `concurrency` group also serializes runs per issue.

Equivalent patterns (same shape, not shipped): Codex cloud / `@codex` review on the PR, or the GitHub Copilot coding agent assigned to the issue. Cloud runs write the four state files through the same patch engine (packets and patch blocks inside the PR), never directly.

## Validation Rule

Run `npm run discipline:validate` before closing a pipeline branch or opening a PR that touches Discipline Loop artifacts.

`discipline:validate` now checks:
- pending patches
- canonical anchors in `discipline.md`, `task_plan.md`, `findings.md` and `progress.md`
- required directories under `.discipline/`
- semantic completeness of key packets such as `STEP_5_SLICE_PACKET`, `DEPLOY_READINESS_PACKET`, `POST_DEPLOY_FEEDBACK_PACKET` and `PROD_HARDENING_PACKET`
- ready `STEP_5_SLICE_PACKET`s also need `Provider Impact`, `AI Impact`, `Files to touch`, `Manual Verification`, and `Estimate` before implementation; missing sections warn so legacy packets remain compatible
- slice identity: a slice described or listed twice, a status the §4 table and the slice's own section disagree about, and a packet that claims two different slices are errors; the legacy generic packet name is a warning

## Backend Adapter Pattern

Backend is a plugin: `src/lib/backend/index.ts` is the factory. Never import Supabase or Firebase directly. Use the adapter interface.

SDKs are installed on demand:
- `npm i @supabase/supabase-js`
- `npm i firebase`

## Slice Identity

Which slice a file is about is decided in one place, `tools/discipline/lib/slice-identity.ts`, and every
command reads it from there: the runner, the assembler, the validator and the watcher.

- **Ids compare normalized.** `Slice S13`, `S13` and `13` are the same slice. `S13.2` and `S13-a` are
  not: composite ids stay distinct. A request for `1` never resolves to `S13`.
- **One packet per file.** The canonical name is `.discipline/packets/STEP_5_SLICE_PACKET_<slice>.md`,
  and the paste-ready it produces is `.discipline/paste-ready/step-5-<slice>-input.md`. Nothing moves in
  and out of a shared slot, so two slices can be ready at once without overwriting each other.
- **A packet must say which slice it is for.** Any of these count as a declaration: the suffixed
  filename, frontmatter `slice:`, the root `SLICE:` field, a `## Slice S13` heading, or the first entry
  of a `## Slice` section. **Two declarations that disagree fail closed**, naming every source. No field
  outranks another, because a winner is how a contradiction survives.
- **The legacy generic `STEP_5_SLICE_PACKET.md` still works**, but only when it identifies the slice you
  asked for and no other: it is accepted with a warning, and refused when it names a different slice.
  A packet with no declaration at all is accepted only when the plan has exactly one slice it could be.
- **`task_plan.md` must not contradict itself.** A slice described twice, listed twice in the §4 Ready
  Slices table, or carrying one status in the table and another in its own section stops the command.
  Only a table with a slice column AND a status column is read as statuses; prose tables in that section
  are left alone.
- **Consumed means closed, not superseded.** The whole closing transition has to hold: the packet is
  `ready`, the completion packet names exactly this slice, its `Outcome` is terminal (`done` or
  `shipped`), `progress.md` accepted the record, and `GATE_STATE: passed` is explicit. A green gate on
  its own closes nothing: Step 5 tells you to write `Outcome: partial` or `blocked` and leave the slice
  open, and consuming that would close work you said is unfinished. Several completion packets for the
  same slice are all read: if they disagree on the outcome or the gate, the slice is not consumed and
  each one is named.

**Existing projects, one policy:** nothing has to be renamed to keep working, and no step renames
anything on its own. `npm run discipline:validate` warns once per generic packet and names the
suffixed file it belongs in; moving it is a deliberate decision the operator takes between slices,
with the pipeline idle. Inside a slice nothing is renamed, moved or hand-marked: consumption is
recorded in place by the watcher when the completion packet carries a green gate.

## Step 5 Packet Contract (v2)

The `STEP_5_SLICE_PACKET` is the document an implementer builds from, so it carries a versioned
contract of its own, defined once in `tools/discipline/lib/step5-schema.ts`.

**Three outcomes, not two.** No frontmatter, or frontmatter that does not declare the Step 5 schema,
or declares it at version 1: **legacy**, advisory. Thousands of those exist and none of them lied
about anything. Version 2: the **current contract**. Anything else is **refused**, never quietly
demoted to legacy: a missing version, a malformed one (`2.`, `2.bad`), one from a future this
tooling does not know, or frontmatter that opened and could not be parsed at all. Falling back would
take a packet that explicitly opted into a versioned contract and validate it against none, which is
the shape of the false green the version field exists to prevent. **The version is a string**, which
is what the schema says: `2.0.0` needs no quotes, but `2` and `2.0` do, because YAML turns those
into numbers.

**v2 fails closed once it says `ready`.** A ready packet is about to be handed to a builder, so an
unmet requirement is an error and `npm run discipline:assemble` refuses it. The same packet as
`status: draft` reports the same problems as warnings, because a draft is what Step 4 is still
filling in. A draft still does not become a handoff: a paste-ready IS the implementation input, so
assembling one for a packet that is not `ready` needs `--allow-draft`, and says loudly that the
result is for inspection.

Frontmatter (all required in v2):

```yaml
---
schema: discipline.packet.step5
version: 2.0.0
id: step5:<slice>:<timestamp>
status: draft | ready | consumed | superseded
slice: <slice>
affected_surfaces:      # at least one, from the list below
  - ui
required_gates:         # at least one
  - gate
---
```

Surfaces: `ui`, `authenticated-ui`, `backend`, `schema`, `permissions`, `deployment-artifact`,
`ai`, `docs-only`. They are what routes the gates a slice has to pass, so an omitted surface is a
gate the slice never runs; declaring one extra is harmless.

Required sections: `Goal`, `Scope`, `Contracts`, `Provider Impact`, `AI Impact`,
`Reachable States`, `Acceptance Criteria`, `Falsifiability`, `Files to touch`,
`Deployment Compatibility`, `Manual Verification`, `Estimate`.

- **Reachable States** is a table with `State | Trigger | Committed effects | Returned result | Recovery`.
  A state with committed effects and no recovery is the partial-state bug this table exists to surface.
- **Acceptance Criteria** is a table with `ID | Setup | Action | Observable result | Negative control`.
  IDs are unique (an ID is how a failure is referred to later) and the negative control may not be
  `none`: a check that passes proves nothing until you can say what would have made it fail.
- **Falsifiability** declares `METHOD: red-evidence | mutation | rationale` plus the evidence itself.
  It is a declaration, not a tone of voice: a state read from prose is language-dependent and inverts
  on the first negation.
- **`APPLIES: no`** is how a section says it does not apply, and it needs a `RATIONALE:` somebody can
  check. Without that rule, declaring a section irrelevant is the fastest way to satisfy it.
- An unfilled cell (`TBD`, `<placeholder>`, empty) is refused. `Committed effects: none` is a fine
  answer: `none` is an answer, it just has to be true.
- **A heading is not an answer.** Every required section has to say something: a blank section, one
  holding only sub-headings, or one holding `TBD`, `none`, `n/a` or `not applicable` is refused.
  Otherwise the contract is satisfied by typing its own table of contents. `- APPLIES: no` with a
  `RATIONALE:` is the one way a required section may hold no prose.
- **`Goal`, `Scope` and `Contracts` cannot declare `APPLIES: no`, with or without a rationale.**
  They are what a slice IS. A slice with none of them is not a slice with an exemption.
- **`--allow-draft` covers exactly `draft`.** `consumed` and `superseded` do not mean "being
  written", they mean that slice is over, and the flag does not reopen them.
- **The markdown costume does not matter.** `- **none**`, ``- `none``, `+ APPLIES: no` and
  `* METHOD: mutation` are read exactly like their plain forms: the list marker (`-`, `*`, `+`),
  the emphasis and the code ticks come off before any rule looks at the value. A contract you can
  satisfy by changing a bullet character is not a contract.

**Estimate feeds measured scope.** Step 4 declares `MAX_CHANGED_LINES: <positive integer>` for all
four categories and a `BASIS:` from prior slices with overlapping affected surfaces (or an explicit
file/risk rationale when no comparable history exists). Both values are structured into the signed
metric record. Step 4 assembly verifies every JSONL signature before including history and writes no
handoff when the log is invalid; `discipline metrics` likewise refuses an invalid v2 packet rather
than signing missing surfaces.
After implementation, `discipline metrics --slice <id> --base <ref>` compares that maximum with
`git diff --numstat`, separates production, tests, fixtures/config and documentation, and appends
a signed record to `.discipline/metrics/slices.jsonl`. Above the maximum, the packet must declare
`SPLIT_DECISION: split|exception-approved`. A second record for the same slice is refused unless
the reviewed Estimate explicitly says `DUPLICATE_METRICS: allowed`.

**Migrating existing packets** is a decision the operator takes between slices, with the pipeline idle:

```bash
npm run discipline:migrate-packets            # dry run: says exactly what it would do
npm run discipline:migrate-packets -- --write # applies it
```

It infers the slice from the same declarations everything else reads and **refuses ambiguity rather
than guessing**. With `--write` the original is kept verbatim under `.discipline/packets/legacy/`
next to a `.sha256` of its bytes, the suffixed packet is created, and nothing is ever overwritten,
so running it twice does what running it once did. **Each packet migrates as a transaction**: every
output path is checked before any of them is created, each is created exclusively, a failure removes
what that attempt made, and the original is deleted last. So a collision leaves nothing behind to
block the retry. The removal of the original is itself undone when it fails after the effect: the
bytes are in memory the whole time, and when even the restore fails the command says `ROLLBACK
INCOMPLETE` and names what it could not put back, because a false "nothing was left behind" is worse
than the loss, it is what stops anybody from going to look. The migrated packet keeps `status: ready` only
when it already meets v2; otherwise it lands as `draft`, which is honest about the sections Step 4
still has to write. No surface is invented for you: a guessed surface is a gate the slice skips.

## Hybrid Gates (`gate --changed`)

`npm run gate` is unchanged, and it is still the answer that is always right: everything, every time.
`gate --changed` runs a **subset** of it, chosen from what the change actually touched, and it is the
only thing in the pipeline allowed to run less than the whole gate.

```bash
npm run discipline -- gate --changed                      # what the working tree touched
npm run discipline -- gate --changed -- --base main       # ...plus everything committed since main
npm run discipline -- gate --changed -- --slice S13       # ...checked against that slice's packet
```

**The change is read from git, from all four places it hides:** committed against `--base`, staged,
unstaged, and untracked. Any git failure is fatal, because "we could not tell what changed" and
"nothing changed" produce the same empty list, and one of them is a green that verified nothing.

**`.discipline/gates.json` is the map** from paths to surfaces to gates. It is project config, meant
to be edited: when your project grows a directory the map does not know, that directory's files are
`unmapped`, and unmapped means **the full gate runs**. An out-of-date map costs time, never coverage.
The map is refused outright (nothing runs) when it is unreadable, when it names a script package.json
does not define, or when it says nothing about one of the surfaces, because a surface nobody mentions
is a gate nobody runs.

**A surface may demand a gate `npm run gate` does not run**, and the shipped map does. That is the
whole point of a surface: `npm run gate` cannot demand browser or device verification of every
project, and this map demands it only of the change that needs it.

| Surface | Beyond the usual lint/types/tests | Why |
|---|---|---|
| `ui` | `gate:visual` | A screen that renders wrong passes every static check. Needs the browsers (`npm run e2e:install`) or the device tooling. |
| `authenticated-ui` | `e2e:auth`, plus the RLS/storage privacy tests | A screen behind a login renders somebody else's data, or nothing at all. `e2e:auth` **runs the authenticated suite**, and refuses before that when `AUTH_MODE: NONE` (the surface contradicts the project), when `tests/e2e/authenticated/` (`.maestro/authenticated/` on mobile) is empty, or when the runner finds no test in it: an empty file, one holding only a comment and one that does not compile all look the same on disk, so the count comes from the runner (`playwright test --list`), never from reading the source. |
| `deployment-artifact` | the lane's artifact check (`check-bundle`, `check-mobile-release`, `check-desktop-release`, `check-bundle-extension`) | `app.json`, `tauri.conf.json` and the manifest are not code: lint and tests pass while the artifact is unbuildable or still carries the template's identifiers. **Each of these builds or resolves something and inspects the result**: the Web and Mobile checks bundle and look at the output, the Desktop one runs `cargo metadata --locked` against the resolved `Cargo.lock` this template ships, so a lockfile that is missing, hand-written or stale against `Cargo.toml` cannot pass for a resolved tree, and `check-native` compiles the Rust side (clippy, denying warnings) because the artifact of a Tauri app IS native code. An `api/` route is both `backend` AND `deployment-artifact`. |

**A project that does not verify UI that way takes `gate:visual` out of this file**, deliberately and
in a diff somebody can read, instead of finding out later that nothing ever ran it.

**The packet is checked against the change.** With `--slice`, the surfaces the change implies are
compared to the `affected_surfaces` the Step 5 packet declares:

- A surface the change touches and the packet does **not** declare **refuses the run before any gate
  starts**, naming the surface and the files that imply it. That is not a red test, it is a
  disagreement about what the slice is: fix the packet or take those files out of the slice.
- A surface the packet declares and the change does **not** touch is fine, and its gates run anyway.
  Over-declaring costs time; under-declaring costs coverage.
- `required_gates` is added on top, so a packet asking for `gate` gets the whole gate.
- A legacy packet declares no surfaces, so there is nothing to check against; the gates then come
  from the changed files alone, and the command says so.

**The report is `discipline.gate_report.v2`**, written to the same `.discipline/gate-report.json` v1
uses, with the files, the surfaces, the commands, their durations, the failures and an error
signature. Every reader (the Stop hook, checkpoints, the runner) reads v1 and v2 and **refuses any
other schema**: an unknown report is not read as green. Two consequences worth knowing:

- A checkpoint built from a v2 report says `scope: CHANGED FILES ONLY`, because a human approving
  from it would otherwise read "PASSED" as the whole gate.
- The Stop hook blocks a session whose edited files the report never saw, not just a stale one.
  Untracked files count as edited: a source file created after the gate is exactly what a scoped
  report is missing. What it leaves out is only git-ignored paths and the state the pipeline
  GENERATES (`gate-report.json`, locks, ledger, rendered diffs, `STOP`). `gates.json` and the
  packets are NOT exempt: one decides which gates run and the others are what `discipline:validate`
  reads, so editing either after the gate is a change the gate never saw.

**Headless runs (L2/L3) use it**, with the pre-run tag as `--base` and the slice as `--slice`. The
point there is not speed: the shipped Step 4 template asks for `required_gates: gate`, so the run is
a superset of the old behavior. The point is that a builder which touched a surface its packet never
declared stops the run instead of closing the slice.

**There is no fallback to the full gate.** A missing map, an unreadable one or a git that cannot
answer ends the run at **exit 5 (incomplete)**, with the patches applied and the slice NOT closed.
Running everything instead would look safer and is not: the comparison between what the packet
declared and what the diff touched is the guarantee the run closes its slice on, and a full gate
cannot make it. Restore the map or the repository, then re-run.

## Metrics, document growth, and compact state

`task_plan.md` keeps summary, order, dependencies and status; detailed slice specification lives
in its suffixed Step 5 packet. Validation warns when `task_plan.md` or `findings.md` exceeds 250 KB
or 2,000 lines, with a high warning above 500 KB. `task_plan_archive.md` and
`findings_archive.md` hold reviewed history. The tooling never moves human prose automatically:
archive changes arrive as ordinary reviewable patch blocks.

`discipline state-view` derives `.discipline/views/current-state.md` from packets, the plan,
metrics, the gate report and consumption state. It shows ready, in-progress and consumed slices,
blockers, required gates, latest measurements and document sizes. The view is gitignored,
contains no decisions, and identical inputs produce identical bytes. `--json` returns the same
state as structured data. Use `npm run --silent discipline -- state-view --json` when stdout must be
pure JSON (`npm.cmd` in PowerShell); the direct `discipline:state-view` npm script prints npm's own
banner. `discipline status` regenerates and links the view and prints sizes.

Step 4 handoffs include `.discipline/metrics/slices.jsonl`. Compare a proposed slice with prior
records that share affected surfaces; do not copy an estimate from an unrelated surface.

## Anchor Rules

Never rename or delete headings in `discipline.md`, `task_plan.md`, `findings.md`, or `progress.md`. The `discipline:*` scripts depend on exact heading text to apply patches and validate state.

## Model Routing (Step 5)

Choose the right **model role** based on slice complexity. Concrete model IDs, prices, lifecycle and free tiers live in each provider's official documentation, not in this template; the model-selection guide in the separately-sold The App Discipline vault maps each role to what to look for. Do not hardcode versions here.

- **Simple slices** (CRUD, UI layout, static pages): Use `Premium Reliable - Mechanical Work`, `Premium Reliable - Async Agent`, or `Frontier-Budget - Implementation` when gates and review are strong.
- **Complex slices** (business logic, multi-table operations, state management): Use `Premium Reliable - Implementation`.
- **Slices touching RLS, auth, sync, or permissions**: Use `Premium Reliable - Implementation` plus cross-review. Do not use a cheap/async-only path.
- **If the gate fails 2 times with the same error**: Escalate to `Premium Reliable - Critical Decisions` before the 3rd attempt.
- **Architecture decisions or persistent bugs**: Escalate to `Premium Reliable - Critical Decisions` with the strongest available reasoning mode.
- **Visual UI / design system / brand-aware mockups (Step 3)**: Use `Premium Reliable - Visual Design` (Claude Design) when there is brand, design system, realistic prototypes or handoff to Claude Code; `Frontier-Budget - UI/Frontend` (Stitch, v0.dev) for budget exploration without established brand. Both produce `UI_HANDOFF_PACKET` for Step 5.

## Slice Loop (Step 5)

For each slice follow the 8-step loop: Plan -> Implement -> Self-Review -> Gate -> Repair -> Log -> Commit -> Deploy/Verify.

1. **Plan:** Read `STEP_5_SLICE_PACKET` from `.discipline/packets/` and review `discipline.md` contracts. Acquire the slice lease (`npm run discipline -- lease acquire <id>`) here and release it after the completion packet (`npm run discipline -- lease release <id>`).
2. **Implement:** Write the code for the slice. One writer per slice.
3. **Self-Review:** Read your own diff. Look for debug logs, hardcoded secrets, empty catches, unused imports, `any` without justification.
4. **Gate:** Run `npm run gate` until it passes. If `AI_FEATURES=enabled`, also run `npm run ai:smoke && npm run ai:eval`.
5. **Repair:** If the gate fails, analyze the error, apply a fix with new information, and return to Gate. After 2 attempts with the same signature and no material change (evidence, context, hypothesis, strategy), stop; escalating the model grants a single third attempt only when you document (in `progress.md` Open Errors or `run-log.md`) why more reasoning capacity could change the diagnosis. Hard stop at 3 failures of the same gate. If the signature points to spec, architecture, data, or environment, return to the producing step.
6. **Log:** Update `progress.md` with what changed, what was tested, what failed, and what comes next.
7. **Commit:** With a green gate, commit with a descriptive message (e.g., `feat(S03): item list with pull-to-refresh`). Never end a session with working code uncommitted.
8. **Deploy/Verify:** Run the minimal smoke test for the lane.

After closing the slice, generate `SLICE_COMPLETION_PACKET` in `.discipline/packets/` and let `discipline:watch` update progress and assemble the next handoff.

## TypeScript Rules

- `strict: true`
- No `any` in business logic
- No `@ts-ignore` without a comment explaining why

## Testing

For UI lanes, you can also run the minimal browser smoke:

```bash
npm run e2e:install
npm run e2e
```

That check is intentionally separate from `npm run gate` so the project can adopt browser verification progressively.

- Minimum: 1 happy path + 1 error path per slice
- Test boundaries, not internals
- No mocking your own code unless justified
- Tooling tests under `tests/tooling.discipline.test.js` protect pipeline handoffs and semantic validation
- `tests/tooling.test.js` includes EXAMPLE backend-contract tests (the CoreStore: personal space, notifications). They are scaffolding: a slice that changes or removes that contract updates or deletes them in the same slice. Grep the repo for any contract symbol you change so the slice's "Files to touch" includes them (they live at the repo root, not under `src/lib/backend/`).

## Security

- Never commit `.env` or API keys
- `ANON_KEY` only in frontend
- `SERVICE_ROLE_KEY` never in frontend
- All queries with `limit`
- RLS on all Supabase tables before production
- Use `.github/workflows/security-review.yml` only after configuring `ANTHROPIC_API_KEY` in repository secrets
