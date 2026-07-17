/**
 * Discipline Loop Security Gate — RLS Enabled on Business Tables
 *
 * Scans supabase/migrations/**.sql and supabase/migrations_templates/**.sql for tables that are created without
 * enabling Row Level Security. RLS is mandatory for PROFILE=SHARED_SYNC/LAUNCH/PROD.
 *
 * Heuristic:
 *   1. For every `CREATE TABLE <name>` found, look for either:
 *        - `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` in the same repo
 *        - or `CREATE TABLE <name> ... ENABLE ROW LEVEL SECURITY` inline (Postgres 16+ syntax)
 *   2. Skip tables in the EXEMPT set (system/meta tables).
 *
 * Enforces Discipline Loop NN #17.2 (Security Baseline: RLS enabled on business tables).
 *
 * Exit 0 = pass, Exit 1 = business tables missing RLS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readProviderConfig } from './provider-config.js';

const ROOT = process.cwd();
const MIGRATION_DIRS = [
  path.join(ROOT, 'supabase', 'migrations'),
  path.join(ROOT, 'supabase', 'migrations_templates'),
];

// Tables that do not require RLS (system tables, migrations metadata, etc.).
const EXEMPT_TABLES = new Set([
  'schema_migrations',
  'migrations',
  'spatial_ref_sys',
]);

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
const ENABLE_RLS_RE = /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gi;
const INLINE_RLS_RE = /enable\s+row\s+level\s+security/i;
const CREATE_POLICY_RE = /create\s+policy\s+(?:if\s+not\s+exists\s+)?"?[a-z_][a-z0-9_]*"?\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;

function walkSql(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSql(full));
    } else if (entry.name.endsWith('.sql')) {
      out.push(full);
    }
  }
  return out;
}

function collectTables() {
  const createdTables = new Map(); // name -> { file, hasInlineRls }
  const enabledRls = new Set();
  const tablesWithPolicy = new Set();

  const files = MIGRATION_DIRS.flatMap(walkSql);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');

    // Split loosely by CREATE TABLE blocks so inline RLS detection stays scoped.
    const createMatches = [...content.matchAll(CREATE_TABLE_RE)];
    for (const match of createMatches) {
      const name = match[1].toLowerCase();
      if (EXEMPT_TABLES.has(name)) continue;
      if (createdTables.has(name)) continue;

      // Get the block of SQL belonging to this CREATE TABLE (until the next ;).
      const startIdx = match.index ?? 0;
      const terminator = content.indexOf(';', startIdx);
      const blockEnd = terminator === -1 ? content.length : terminator;
      const block = content.slice(startIdx, blockEnd);

      createdTables.set(name, {
        file: path.relative(ROOT, file),
        hasInlineRls: INLINE_RLS_RE.test(block),
      });
    }

    for (const match of content.matchAll(ENABLE_RLS_RE)) {
      enabledRls.add(match[1].toLowerCase());
    }

    for (const match of content.matchAll(CREATE_POLICY_RE)) {
      tablesWithPolicy.add(match[1].toLowerCase());
    }
  }

  return { createdTables, enabledRls, tablesWithPolicy, files };
}

function isSupabaseSelected() {
  return readProviderConfig(ROOT).backendProvider === 'SUPABASE';
}

console.log('--- Security Gate: RLS Enabled on Business Tables ---');

const existingDirs = MIGRATION_DIRS.filter((dir) => fs.existsSync(dir));
if (existingDirs.length === 0) {
  if (isSupabaseSelected()) {
    console.log('\x1b[31m[FAIL]\x1b[0m Supabase selected but no supabase migrations directory exists.');
    console.log('Fix: add real migrations with RLS policies, or switch BACKEND_PROVIDER to LOCAL_ONLY/FIREBASE before launch.');
    process.exit(1);
  }
  console.log('\x1b[33m[SKIP]\x1b[0m No supabase/migrations/ directory (non-Supabase project).');
  process.exit(0);
}

const { createdTables, enabledRls, tablesWithPolicy, files } = collectTables();

const missing = [];
const noPolicy = [];
for (const [name, meta] of createdTables) {
  const rlsOn = meta.hasInlineRls || enabledRls.has(name);
  if (!rlsOn) {
    missing.push({ name, file: meta.file });
    continue;
  }
  // RLS is ON but no CREATE POLICY targets this table -> effectively deny-all,
  // almost always a forgotten policy. A table with RLS and zero policies is the
  // false-green M6 closes: the gate must require >= 1 policy per RLS table.
  if (!tablesWithPolicy.has(name)) {
    noPolicy.push({ name, file: meta.file });
  }
}

if (createdTables.size === 0) {
  if (isSupabaseSelected()) {
    console.log('\x1b[31m[FAIL]\x1b[0m Supabase selected but no business tables were found in supabase/migrations or supabase/migrations_templates.');
    console.log('Fix: add real migrations with RLS policies, or switch BACKEND_PROVIDER to LOCAL_ONLY/FIREBASE before launch.');
    process.exit(1);
  }

  const detail = files.length === 0 ? 'no SQL migration files' : `${files.length} SQL migration file(s), no business tables`;
  console.log(`\x1b[33m[SKIP]\x1b[0m ${detail}. RLS cannot be verified until Supabase migrations exist.`);
  process.exit(0);
}

if (missing.length === 0 && noPolicy.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m ${createdTables.size} table(s) verified with RLS enabled and at least one policy each.`);
  process.exit(0);
}

if (missing.length > 0) {
  console.log(`\x1b[31m[FAIL]\x1b[0m ${missing.length} business table(s) without RLS:\n`);
  for (const item of missing) {
    console.log(`  ${item.file}  —  table: ${item.name}`);
  }
  console.log(`\nFix: add 'ALTER TABLE ${missing[0].name} ENABLE ROW LEVEL SECURITY;' in the migration that creates each table.`);
}

if (noPolicy.length > 0) {
  console.log(`\x1b[31m[FAIL]\x1b[0m ${noPolicy.length} table(s) with RLS enabled but NO policy (deny-all / forgotten policy):\n`);
  for (const item of noPolicy) {
    console.log(`  ${item.file}  —  table: ${item.name}`);
  }
  console.log(`\nFix: add at least one 'CREATE POLICY ... ON ${noPolicy[0].name} ... USING (<owner_col> = auth.uid());' scoped to ownership.`);
}

console.log('Reference: Discipline Loop NN #17.2 Security Baseline + 51 - SOP RLS y Supabase.');
process.exit(1);
