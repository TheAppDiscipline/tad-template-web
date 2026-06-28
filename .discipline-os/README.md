# .discipline-os/ — Maintenance Automation (Discipline Loop)

Scripts to keep solo-builder maintenance from becoming "intention without habit". See vault note `83 - Mantenimiento Solo` for doctrine.

## Setup

Add these entries to your `package.json` under `scripts`:

```json
{
  "scripts": {
    "discipline-os:weekly": "bash .discipline-os/weekly.sh",
    "discipline-os:monthly": "bash .discipline-os/monthly.sh",
    "discipline-os:quarterly": "bash .discipline-os/quarterly.sh"
  }
}
```

Not auto-added to keep this library non-invasive. You decide which scripts your project needs.

## Cadence

| Script | Cadence | Time | What it checks |
|---|---|---|---|
| `weekly` | Every Monday | <2 min | `npm outdated` · `npm audit` · `npm run gate` · short report |
| `monthly` | First Sunday of the month | <10 min | Backups verification · bundle audit · Lighthouse re-run · dependency budget · findings review |
| `quarterly` | Jan/Apr/Jul/Oct 1st | <1 h | Full security review (delegates to `discipline-security-reviewer` subagent) · compliance review · tech debt inventory · breach runbook drill |

## Integration options

- **Manual:** calendar reminder → run script → journal in `findings.md §Maintenance`.
- **GitHub Actions:** copy the `weekly` body into `.github/workflows/maintenance.yml` with `on: schedule: cron: '0 9 * * 1'` (Mondays 9am UTC).
- **Pre-commit hook (discouraged for monthly/quarterly):** adds friction to every commit; not recommended.

## Windows compatibility

Scripts require bash. On Windows: use Git Bash (installed with Git) or WSL. Most Discipline Loop users already have Git Bash available.

## Relation to `tad-skills` and `.claude/agents`

- The `discipline-security-reviewer` subagent (in `.claude/agents/`) covers part of the quarterly security review automatically.
- The `verify-launch-scorecard` skill (from `github.com/TheAppDiscipline/tad-skills`) runs the gates the monthly script cannot.
- These three layers (os scripts + subagents + skills) cover the maintenance discipline together.

## Customization

Feel free to edit the scripts for your project. The defaults target the web/mobile/desktop/extension templates; tweaks for your specific stack are expected (adjust bundle command, Lighthouse URL, backup destination, etc.).
