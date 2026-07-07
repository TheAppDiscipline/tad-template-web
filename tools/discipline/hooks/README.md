# Discipline Loop policy hooks (opt-in)

Three Claude Code hooks that turn the Discipline Loop doctrine from prose into a
mechanism. They are **opt-in**: nothing here runs until you deliberately merge
`.claude/settings.hooks.example.json` into your own `.claude/settings.json`. This
is a project decision (v1.2 §6.3): hooks add per-tool-call latency and can be
noisy, so they are documented and copy-to-enable rather than on by default.

Design principle: **policy is a mechanism, not a suggestion.** A green gate is
not authorization, and the never-auto-approve operations stay never-auto-approved
even when the model is wrong. Each script is a plain `.mjs` ESM module runnable
as `node tools/discipline/hooks/<name>.mjs`, with fast startup and no `tsx`.

## What each hook enforces

| Hook | Event | Enforces |
|---|---|---|
| `pre-tool-guard.mjs` | `PreToolUse` | **Denies** `rm -rf` / `rd /s`, `git push --force`/`-f`, `git reset --hard`, `git config` mutations, `curl\|wget \| sh`, and any Read/Edit/Write of `.env` / `.env.*`. **Asks** (forces the human prompt even in accept-edits mode) for edits to `supabase/migrations/**`, `.github/workflows/**`, `vercel.json`, `package.json`, `*.rules` (Firebase/Firestore/Storage), and for `npm install` / `npm i` / `npm add`. Everything else is allowed silently. |
| `stop-gate.mjs` | `Stop` | The session should not end with edited code and a non-green gate. If tracked files are modified and `.discipline/gate-report.json` is missing, older than the newest edit, or `passed: false`, it **blocks** the stop and tells the agent to run `npm run discipline -- gate --json` and fix failures (Repair Budget: stop after 2 identical error signatures). A single nudge only: if it already blocked once (`stop_hook_active`), it allows. |
| `session-start-header.mjs` | `SessionStart` | Injects the FIXED HEADER of `progress.md` (top through the end of `## Deploy Notes`) as `additionalContext`, so every session starts with Current Status / Open Errors / Next Actions without a human pasting them. |

Command matching in `pre-tool-guard.mjs` is a simple regex over the Bash command
string, not a shell parser: it can over-match a dangerous pattern inside a quoted
string (a false **ask**), which is the safe direction. A false ask is acceptable;
a false deny is not, and a silent false allow is the only truly bad outcome, so
the few ambiguous cases bias toward **ask**, never toward allow.

Failure policy: `session-start-header.mjs` and `stop-gate.mjs` **fail open**
(allow) on any internal error, so a broken hook never traps the agent in a
session. `pre-tool-guard.mjs` **fails closed to ask** when the tool and inputs
parsed but rule evaluation threw (prompt the human), and only allows on a total
payload-parse failure (logging one stderr line).

## How to enable

Merge the `hooks` object from `.claude/settings.hooks.example.json` into your
`.claude/settings.json` (create the file if it does not exist). `$CLAUDE_PROJECT_DIR`
is expanded by Claude Code to your project root, so the paths work regardless of
the current working directory. A minimal `.claude/settings.json` after merging:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|Read|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/tools/discipline/hooks/pre-tool-guard.mjs\"" } ] }
    ],
    "Stop": [
      { "matcher": "*",
        "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/tools/discipline/hooks/stop-gate.mjs\"" } ] }
    ],
    "SessionStart": [
      { "matcher": "*",
        "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/tools/discipline/hooks/session-start-header.mjs\"" } ] }
    ]
  }
}
```

If you already have other keys in `settings.json`, keep them and add only the
`hooks` key (or merge into an existing `hooks` key). Restart the Claude Code
session (or run `/hooks`) so the new configuration is picked up.

## How to disable

Remove the `hooks` key (or the specific event you no longer want) from
`.claude/settings.json`. The example file and the scripts are inert on their own;
deleting the config is enough. Nothing else in the pipeline depends on the hooks
being active, and the manual flow keeps working unchanged.

## Latency note

Each configured `PreToolUse` hook runs on every matching tool call, so it adds a
short Node startup per call. The scripts do no network I/O and only touch local
files (`git status`, `progress.md`, the gate report), so the overhead is small,
but it is the reason hooks are opt-in rather than default. If you find the prompts
noisy for a given workflow, disable the relevant event and rely on the manual
gate discipline instead.
