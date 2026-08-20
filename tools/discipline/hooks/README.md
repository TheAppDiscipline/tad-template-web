# Discipline Loop policy hooks

Three Claude Code hooks that turn the Discipline Loop doctrine from prose into a
mechanism. They ship enabled in `.claude/settings.json`; the example file is a
portable copy of the baseline for settings merges. Disabling or weakening a hook
is a reviewed policy change.

Design principle: **policy is a mechanism, not a suggestion.** A green gate is
not authorization, and the never-auto-approve operations stay never-auto-approved
even when the model is wrong. Each script is a plain `.mjs` ESM module runnable
as `node tools/discipline/hooks/<name>.mjs`, with fast startup and no `tsx`.

## What each hook enforces

| Hook | Event | Enforces |
|---|---|---|
| `pre-tool-guard.mjs` | `PreToolUse` | **Denies** destructive history/filesystem commands, remote-code pipes, secret-file access, and environment dumps. **Asks** for dependency/lifecycle execution; sensitive-file edits; out-of-project mutations; lease overrides; and every commit, tag, push, deploy, upload, or publication boundary. Malformed payloads fail closed to ASK. |
| `stop-gate.mjs` | `Stop` | The session should not end with edited code and a non-green gate. If tracked files are modified and `.discipline/gate-report.json` is missing, older than the newest edit, or `passed: false`, it **blocks** the stop and tells the agent to run `npm run discipline -- gate --json` and fix failures (Repair Budget: stop after 2 identical error signatures). A single nudge only: if it already blocked once (`stop_hook_active`), it allows. It reads `discipline.gate_report.v1` and `v2` and treats any other schema as no report at all; when the report is a v2 one (from `gate --changed`), it also blocks if a modified file is not in the file list that report was scoped to, since a green about other files is not a green about this session. |
| `session-start-header.mjs` | `SessionStart` | Injects the FIXED HEADER of `progress.md` (top through the end of `## Deploy Notes`) as `additionalContext`, so every session starts with Current Status / Open Errors / Next Actions without a human pasting them. |

Command matching in `pre-tool-guard.mjs` is a simple regex over the Bash command
string, not a shell parser: it can over-match a dangerous pattern inside a quoted
string (a false **ask**), which is the safe direction. A false ask is acceptable;
a false deny is not, and a silent false allow is the only truly bad outcome, so
the few ambiguous cases bias toward **ask**, never toward allow.

Failure policy: `session-start-header.mjs` and `stop-gate.mjs` **fail open**
(allow) on any internal error, so a broken hook never traps the agent in a
session. `pre-tool-guard.mjs` **fails closed to ask** when payload parsing or
rule evaluation fails.

## Configuration

The baseline is already in `.claude/settings.json`. When reconciling it with an
existing project, merge the `hooks` object from
`.claude/settings.hooks.example.json`. `$CLAUDE_PROJECT_DIR` is expanded by
Claude Code to your project root. A minimal configuration is:

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

## Latency note

Each configured `PreToolUse` hook runs on every matching tool call, so it adds a
short Node startup per call. The scripts do no network I/O and only touch local
files (`git status`, `progress.md`, the gate report), so the overhead is small,
and bounded. If a prompt is noisy, tune the narrow matcher under review; do not
silently remove the authorization boundary.
