#!/usr/bin/env bash
# .discipline-os/quarterly.sh — Discipline Loop quarterly maintenance (NN 17, NN 24, Gate E readiness)
set -e

echo "Discipline Loop quarterly maintenance — $(date +%Y-%m-%d)"
echo ""
echo "Timebox: 1 hour total. Beyond that, defer to a dedicated sprint."
echo ""

echo "=== 1/4 Full security review ==="
echo "1a. Run 'Agent(discipline-security-reviewer)' on main branch. Save the JSON report to findings.md §Security."
echo "1b. Run 'npx gitleaks detect --source . --redact' (no staged flag — full history scan)."
echo "1c. Review dependencies with known vulnerabilities: 'npm audit --production --json | jq .vulnerabilities'."
echo ""

echo "=== 2/4 Compliance review ==="
echo "2a. Run the 'generate-privacy-policy' skill (from github.com/TheAppDiscipline/tad-skills)."
echo "    Diff the output against your current public/privacy-policy.md."
echo "    If drift: decide to update policy (preferable) or fix the code (if the drift is a bug)."
echo "2b. Review ROPA (compliance/ropa.md if it exists)."
echo "    For each vendor: DPA still valid? Transfer mechanism still current?"
echo "2c. Privacy Policy version: bump effective date if any material change happened."
echo ""

echo "=== 3/4 Tech debt inventory ==="
echo "3a. Grep TODO|FIXME|HACK:"
grep -rE 'TODO|FIXME|HACK' src/ 2>/dev/null | head -20 || echo "None detected (or src/ path differs)."
echo "3b. progress.md §Open Errors: any entries >30 days old?"
echo "    If yes, either fix now or move to 'accepted debt' with rationale."
echo "3c. Prioritize for next sprint: 1 item to address, not 5."
echo ""

echo "=== 4/4 Breach runbook drill ==="
echo "Manual: open runbooks/breach.md (or create if missing, per the Privacy Baseline material in The App Discipline vault, sold separately)."
echo "Simulate one incident end-to-end in 15 min:"
echo "  - Pick a scenario (stolen session token, leaked service key, unauthorized DB access)."
echo "  - Walk the 7 steps (Contain -> Assess -> Document -> Report -> Notify -> Remediate -> Postmortem)."
echo "  - Note gaps (missing contact, unclear comm template, stale IR plan)."
echo "  - Journal in findings.md §Security/drills."
echo ""
echo "If the drill surfaces gaps, fix them this week — the next real breach will not wait."
