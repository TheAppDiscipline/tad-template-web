#!/usr/bin/env node
/**
 * Discipline Loop AI Cost Dashboard
 *
 * Reads a Claude Code usage log, when available, and prints a daily cost summary.
 *
 * Usage:
 *   node tools/ai-cost-dashboard.js
 *   DISCIPLINE_AI_BUDGET=200 node tools/ai-cost-dashboard.js
 *
 * Requires: Node 18+. No runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const USAGE_FILE = process.env.DISCIPLINE_CLAUDE_USAGE_FILE || path.join(os.homedir(), '.claude', 'usage.json');
const BUDGET_DEFAULT = 150; // USD/month; override via env DISCIPLINE_AI_BUDGET

function loadUsage() {
  if (!fs.existsSync(USAGE_FILE)) {
    console.log(`${USAGE_FILE} not found.`);
    console.log('This dashboard only works when Claude Code writes a local usage JSON file.');
    console.log('If you already used Claude Code, check billing/export in Claude Code or Anthropic instead.');
    console.log('If you have a JSON export, rerun with DISCIPLINE_CLAUDE_USAGE_FILE=<path-to-json>.');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse usage.json:', err.message);
    console.error('This script expects JSON; if Claude Code changed the format, update this tool.');
    process.exit(1);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thisMonth() {
  return new Date().toISOString().slice(0, 7);
}

function main() {
  const raw = loadUsage();
  const budget = Number(process.env.DISCIPLINE_AI_BUDGET || BUDGET_DEFAULT);

  const todayIso = today();
  const thisMonthIso = thisMonth();

  // Claude Code usage.json schema may evolve. Common shapes:
  //   { entries: [{ date: '2026-04-20', cost_usd: 0.42, model: '...' }, ...] }
  //   [{ timestamp: '...', cost: 0.42, ... }, ...]
  // We normalize to iterate over entries with a (date, cost) pair.
  const entries = Array.isArray(raw) ? raw : (raw.entries || raw.runs || []);

  let costToday = 0;
  let costMonth = 0;
  const dailyCosts = {};

  for (const entry of entries) {
    const date = entry.date || (entry.timestamp ? entry.timestamp.slice(0, 10) : null);
    const cost = Number(entry.cost_usd || entry.cost || entry.total_cost || 0);
    if (!date || !cost) continue;

    if (date.startsWith(thisMonthIso)) {
      costMonth += cost;
      dailyCosts[date] = (dailyCosts[date] || 0) + cost;
    }
    if (date === todayIso) {
      costToday += cost;
    }
  }

  const activeDaysThisMonth = Object.keys(dailyCosts).length;
  const avgDaily = activeDaysThisMonth > 0 ? costMonth / activeDaysThisMonth : 0;

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  // Linear projection from active-day average.
  const projected = avgDaily * daysInMonth;
  const budgetPct = budget > 0 ? (projected / budget) * 100 : 0;
  const status =
    projected > budget ? 'OVER BUDGET'
    : projected > budget * 0.8 ? 'near limit (>80%)'
    : 'within budget';

  console.log('Discipline Loop AI Cost Dashboard');
  console.log('------------------------');
  console.log(`Today (${todayIso}):          $${costToday.toFixed(2)}`);
  console.log(`Month-to-date (${thisMonthIso}): $${costMonth.toFixed(2)} across ${activeDaysThisMonth} active days`);
  console.log(`Average/active-day:         $${avgDaily.toFixed(2)}`);
  console.log(`Projected month end:        $${projected.toFixed(2)}`);
  console.log(`Budget:                     $${budget.toFixed(2)}`);
  console.log(`Budget usage:               ${budgetPct.toFixed(0)}% — ${status}`);
  console.log('');
  console.log(`(Day ${dayOfMonth}/${daysInMonth} of month. Override budget with DISCIPLINE_AI_BUDGET=<USD> env.)`);

  if (projected > budget) {
    console.log('');
    console.log('Action: projected spend exceeds budget.');
    console.log('  - Audit your recent sessions for expensive patterns (discipline-step7 with opus; long contexts without cache).');
    console.log('  - Consider routing more work to sonnet or haiku (see vault 13 - Fast Decisions / Models).');
    console.log('  - Raise the budget with DISCIPLINE_AI_BUDGET if the spend is genuinely value-producing.');
  }
}

main();
