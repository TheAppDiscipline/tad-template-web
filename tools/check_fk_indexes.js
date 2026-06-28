/**
 * Discipline Loop Query Discipline Gate — FK Columns Must Have Indexes
 *
 * Scans supabase/migrations/**.sql and supabase/migrations_templates/**.sql for foreign key columns and verifies
 * that each has a corresponding index created in the same migration file
 * (or anywhere in the migrations corpus).
 *
 * Heuristic detection:
 *   - Inline FKs: `col_name uuid references target_table(id)`
 *   - Table-level constraints: `FOREIGN KEY (col_name) REFERENCES target_table(id)`
 *   - Index presence: `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table> (<col_name>[, ...])`
 *
 * A FK column is considered indexed if any index in the corpus starts with
 * that column on the same table. Composite indexes with the FK column first
 * satisfy the requirement.
 *
 * Enforces Discipline Loop NN #23.3 (Query Discipline: indices obligatorios en foreign keys).
 *
 * Exit 0 = pass, Exit 1 = FK columns missing indexes.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MIGRATION_DIRS = [
  path.join(ROOT, 'supabase', 'migrations'),
  path.join(ROOT, 'supabase', 'migrations_templates'),
];
const SUPABASE_ENV_VALUES = new Set(['SUPABASE']);

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

function readDisciplineProvider() {
  const file = path.join(ROOT, 'discipline.md');
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(/^\s*-\s*BACKEND_PROVIDER:\s*([A-Z_]+)/im)
    ?? content.match(/^\s*BACKEND_PROVIDER:\s*([A-Z_]+)/im);
  return match ? match[1].trim().toUpperCase() : null;
}

function isSupabaseSelected() {
  const values = [
    process.env.BACKEND_PROVIDER,
    process.env.VITE_BACKEND_PROVIDER,
    process.env.EXPO_PUBLIC_BACKEND_PROVIDER,
    readDisciplineProvider(),
  ];

  return values.some((value) => SUPABASE_ENV_VALUES.has(String(value ?? '').trim().toUpperCase()));
}

// Returns an array of { table, column, file } for every FK declaration found.
function collectForeignKeys(files) {
  const fks = [];

  const inlineRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  const colFkRe = /\b([a-z_][a-z0-9_]*)\s+[a-z0-9_ ()]*\breferences\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  const tableFkRe = /foreign\s+key\s*\(\s*([a-z_][a-z0-9_]*)\s*\)\s+references\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  const alterFkRe = /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/gi;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    // Inline FKs within CREATE TABLE blocks.
    let match;
    const inline = new RegExp(inlineRe.source, 'gi');
    while ((match = inline.exec(content)) !== null) {
      const table = match[1].toLowerCase();
      const body = match[2];
      const colRe = new RegExp(colFkRe.source, 'gi');
      let colMatch;
      while ((colMatch = colRe.exec(body)) !== null) {
        fks.push({ table, column: colMatch[1].toLowerCase(), file: rel });
      }
      const tableRe = new RegExp(tableFkRe.source, 'gi');
      let tableMatch;
      while ((tableMatch = tableRe.exec(body)) !== null) {
        fks.push({ table, column: tableMatch[1].toLowerCase(), file: rel });
      }
    }

    // ALTER TABLE ... ADD FOREIGN KEY (col)
    const alter = new RegExp(alterFkRe.source, 'gi');
    while ((match = alter.exec(content)) !== null) {
      fks.push({
        table: match[1].toLowerCase(),
        column: match[2].toLowerCase(),
        file: rel,
      });
    }
  }

  return fks;
}

// Returns a set of "table.column" keys that are covered by an index
// (table.column is the first column in at least one index on that table).
function collectIndexes(files) {
  const indexed = new Set();
  const indexRe = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[^\s]+\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)/gi;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    const re = new RegExp(indexRe.source, 'gi');
    while ((match = re.exec(content)) !== null) {
      indexed.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    }
  }
  return indexed;
}

console.log('--- Query Discipline Gate: FK Columns Must Have Indexes ---');

const existingDirs = MIGRATION_DIRS.filter((dir) => fs.existsSync(dir));
if (existingDirs.length === 0) {
  if (isSupabaseSelected()) {
    console.log('\x1b[31m[FAIL]\x1b[0m Supabase selected but no supabase migrations directory exists.');
    console.log('Fix: add real migrations with FK indexes, or switch BACKEND_PROVIDER to LOCAL_ONLY/FIREBASE before launch.');
    process.exit(1);
  }
  console.log('\x1b[33m[SKIP]\x1b[0m No supabase/migrations/ directory (non-Supabase project).');
  process.exit(0);
}

const files = MIGRATION_DIRS.flatMap(walkSql);
if (files.length === 0) {
  if (isSupabaseSelected()) {
    console.log('\x1b[31m[FAIL]\x1b[0m Supabase selected but no .sql migrations found.');
    console.log('Fix: add real migrations with FK indexes, or switch BACKEND_PROVIDER to LOCAL_ONLY/FIREBASE before launch.');
    process.exit(1);
  }
  console.log('\x1b[33m[SKIP]\x1b[0m No .sql migrations found.');
  process.exit(0);
}

const fks = collectForeignKeys(files);
const indexed = collectIndexes(files);

const missing = [];
const seen = new Set();
for (const fk of fks) {
  const key = `${fk.table}.${fk.column}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (indexed.has(key)) continue;
  missing.push(fk);
}

if (missing.length === 0) {
  console.log(`\x1b[32m[PASS]\x1b[0m ${seen.size} FK(s) found; all have covering indexes.`);
  process.exit(0);
}

console.log(`\x1b[31m[FAIL]\x1b[0m ${missing.length} FK column(s) without covering index:\n`);
for (const m of missing) {
  console.log(`  ${m.file}`);
  console.log(`    Table:  ${m.table}`);
  console.log(`    Column: ${m.column}`);
  console.log(`    Fix:    CREATE INDEX idx_${m.table}_${m.column} ON public.${m.table} (${m.column});`);
  console.log('');
}
console.log('Reference: Discipline Loop NN #23.3 Query Discipline (indices obligatorios en foreign keys).');
process.exit(1);
