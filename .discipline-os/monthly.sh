#!/usr/bin/env bash
# .discipline-os/monthly.sh — Discipline Loop monthly maintenance (NN 14, NN 17, NN 20)
set -e

echo "Discipline Loop monthly maintenance — $(date +%Y-%m-%d)"
echo ""

echo "=== 1/5 Backups verification ==="
echo "Manual: open your backend provider dashboard (Supabase/Firebase/etc.)"
echo "  -> Database -> Backups -> confirm last successful backup is <24h old."
echo "  -> If it is older, investigate why (quota? provider outage?) before moving on."
echo ""

echo "=== 2/5 Bundle audit ==="
if [ -f "package.json" ] && grep -q '"build"' package.json; then
  npm run build || echo "⚠ build failed — investigate."
  echo "Check bundle size vs NN 20 threshold."
  echo "  Web: entry <200 KB gzipped."
  echo "  Mobile (Hermes): bundle <2 MB."
  echo "  Desktop (Tauri): verify size of final .dmg/.msi."
  echo "  Extension: ZIP <2 MB for Chrome Web Store default."
else
  echo "⏭ No build script detected; skipping bundle audit."
fi
echo ""

echo "=== 3/5 Lighthouse re-run ==="
echo "Manual: run 'npx unlighthouse --site <PROD_URL>' (web/desktop/extension popup)."
echo "  Compare to last month's score (stored in findings.md §Lighthouse)."
echo "  NN 20 target: Performance >70 mobile, Accessibility >90, Best Practices >90."
echo "  Mobile lane (React Native): use 'npx react-native-performance-tools' or equivalent."
echo ""

echo "=== 4/5 Dependency budget ==="
if command -v depcheck >/dev/null 2>&1; then
  npx depcheck
else
  echo "Install once: npm install -g depcheck (or use npx depcheck)"
  echo "Purpose: find unused dependencies to prune."
fi
echo ""

echo "=== 5/5 Findings review ==="
echo "Manual: open findings.md §Incidents."
echo "  For each incident from the last 30 days:"
echo "    - Is it still open? If yes, is it scheduled or stale?"
echo "    - Did similar patterns recur? (cluster = systemic issue to address in quarterly)"
echo ""

echo "Report: journal the output + any decisions in findings.md §Maintenance/monthly."
