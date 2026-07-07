# Workflow examples (inert)

Files in this folder are **not** active workflows. GitHub only runs YAML files
placed directly under `.github/workflows/`. To activate an example, copy it
there and follow the checklist in its header comment.

- `agent-slice.yml`: unattended slice execution by a cloud agent from a
  `slice-ready` labeled issue (GitHub lane, autonomy L4). The pull request plus
  the CI `gate` job (as a required status check) are the merge control. See
  "GitHub lane" in `AGENTS.md`.
