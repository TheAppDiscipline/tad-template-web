#!/usr/bin/env bash
# .discipline-os/weekly.sh — Discipline Loop weekly maintenance (NN 20, NN 17.7)
set -e

echo "Discipline Loop weekly maintenance — $(date +%Y-%m-%d)"
echo ""

echo "=== 1/4 Outdated deps ==="
npm outdated || true  # non-zero exit if outdated exist; not a failure
echo ""

echo "=== 2/4 Security audit ==="
npm audit --production || {
  echo ""
  echo "⚠ audit found issues. Triage with the dependency and security audit checklist."
}
echo ""

echo "=== 3/4 Gates ==="
if npm run gate; then
  echo "✅ Gate green."
else
  echo "⚠ Gate failed — fix before merging more work."
fi
echo ""

echo "=== 4/4 Report ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
echo "Next: write findings to findings.md §Maintenance if any actionable issue emerged."
echo "Skip this step only if the weekly produced zero signals — rare."
