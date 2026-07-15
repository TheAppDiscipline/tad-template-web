/**
 * migration:lint - Validates SQL migration files for Discipline Loop best practices.
 *
 * Checks:
 * 1. Every CREATE TABLE has ENABLE ROW LEVEL SECURITY
 * 2. CREATE TABLE uses IF NOT EXISTS
 * 3. Tables with space_id have an index on it
 * 4. Tables have updated_at trigger when they have updated_at column
 * 5. No dangerous operations without explicit marker
 * 6. No permissive RLS policies without explicit marker:
 *      - USING/WITH CHECK (true)
 *      - USING/WITH CHECK (auth.uid() IS NOT NULL)  ← authenticated but NOT ownership-scoped
 *      - CREATE POLICY with neither USING nor WITH CHECK (role-only scope)
 *    These let any logged-in user read/write every row (CVE-2025-48757 family).
 * 7. SECURITY DEFINER functions and CREATE VIEW without security_invoker=on
 *    (both run with definer rights and bypass the caller's RLS) without explicit marker.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migrationsDir = path.resolve(process.cwd(), 'supabase', 'migrations');
const templatesDir = path.resolve(process.cwd(), 'supabase', 'migrations_templates');

const dirs = [migrationsDir, templatesDir].filter(d => fs.existsSync(d));

if (dirs.length === 0) {
  console.log('[migration:lint] No supabase/migrations/ or migrations_templates/ found. Skipping.');
  process.exit(0);
}

const issues = [];

for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
  const records = files.map(file => {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      relPath: path.relative(process.cwd(), filePath),
      content,
    };
  });
  const ownershipFns = new Set();
  for (const record of records) {
    for (const fn of collectOwnershipFunctions(record.content)) {
      ownershipFns.add(fn);
    }
  }
  for (const record of records) {
    lintFile(record.relPath, record.content, ownershipFns);
  }
}

// Captures the balanced parenthesized expression following a keyword
// (USING (...) / WITH CHECK (...)). Returns the inner text, or null if absent.
function extractParenClause(block, keywordRe) {
  const m = keywordRe.exec(block);
  if (!m) return null;
  const open = block.indexOf('(', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '(') depth++;
    else if (block[i] === ')') {
      depth--;
      if (depth === 0) return block.slice(open + 1, i);
    }
  }
  return block.slice(open + 1);
}

// A predicate is ownership-scoped only if it compares auth.uid() to a REAL column
// (directly `user_id = auth.uid()`, or inside a membership subquery). The other
// side must be a column identifier — NOT auth.uid() again (`auth.uid() = auth.uid()`
// is a tautology: true for every authenticated user), a function, or a literal.
// Declared as a function (hoisted) because lintFile runs before this point.
function isOwnershipScoped(expr) {
  const colBefore = /(?<![\w.])([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)\s*=\s*auth\.uid\(\)/gi;
  const colAfter = /auth\.uid\(\)\s*=\s*([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)/gi;
  for (const m of expr.matchAll(colBefore)) {
    if (!/^auth(\.|$)/i.test(m[1])) return true;
  }
  for (const m of expr.matchAll(colAfter)) {
    if (!/^auth(\.|$)/i.test(m[1])) return true;
  }
  return false;
}

// Collect SQL helper functions whose BODY actually scopes to ownership
// (`<col> = auth.uid()`), e.g. a SECURITY DEFINER `is_space_member()` used to
// break RLS recursion. A policy that calls one of these is ownership-scoped.
// A trivial helper (`select true`) is NOT collected — it can't launder a policy.
function collectOwnershipFunctions(content) {
  const names = new Set();
  const fnRe = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\([\s\S]*?\bas\s+\$([a-z0-9_]*)\$([\s\S]*?)\$\2\$/gi;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    if (isOwnershipScoped(m[3])) names.add(m[1].toLowerCase());
  }
  return names;
}

// A policy clause is scoped if it compares a column to auth.uid() directly, or
// calls an ownership helper function (collected above).
function clauseScoped(expr, ownershipFns) {
  if (isOwnershipScoped(expr)) return true;
  for (const fn of ownershipFns) {
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(expr)) return true;
  }
  return false;
}

function permissiveReason(expr) {
  const e = expr.replace(/\s+/g, ' ').trim();
  if (/^\(*\s*true\s*\)*$/i.test(e)) return 'evaluates to true';
  if (/auth\.uid\(\)\s*=\s*auth\.uid\(\)/i.test(e)) return 'auth.uid() = auth.uid() is a tautology, not ownership';
  if (/auth\.uid\(\)\s+is\s+not\s+null/i.test(e)) return 'auth.uid() IS NOT NULL — authenticated, not ownership';
  if (/auth\.role\s*\(/i.test(e)) return 'auth.role()-based — any authenticated user, not ownership';
  if (/auth\.jwt\s*\(/i.test(e)) return 'auth.jwt()-based — not row ownership';
  return 'no "<col> = auth.uid()" comparison with a real ownership column';
}

function lintFile(filePath, content, directoryOwnershipFns = new Set()) {
  const upper = content.toUpperCase();
  const lines = content.split('\n');

  // Find all CREATE TABLE statements
  const tableMatches = [...content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi)];

  for (const match of tableMatches) {
    const tableName = match[1];
    const tableUpper = tableName.toUpperCase();

    // Check 1: RLS enabled
    const rlsPattern = new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${tableName}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i');
    if (!rlsPattern.test(content)) {
      issues.push({
        file: filePath,
        severity: 'error',
        message: `Table "${tableName}" missing ENABLE ROW LEVEL SECURITY`,
      });
    }

    // Check 2: IF NOT EXISTS
    const createPattern = new RegExp(`CREATE\\s+TABLE\\s+(?:public\\.)?${tableName}\\b`, 'i');
    const createMatch = content.match(createPattern);
    if (createMatch && !/IF\s+NOT\s+EXISTS/i.test(createMatch[0].replace(tableName, ''))) {
      // Check the full CREATE TABLE line more carefully
      const fullLine = content.substring(Math.max(0, content.indexOf(createMatch[0]) - 10), content.indexOf(createMatch[0]) + createMatch[0].length + 20);
      if (!/IF\s+NOT\s+EXISTS/i.test(fullLine)) {
        issues.push({
          file: filePath,
          severity: 'warning',
          message: `Table "${tableName}": consider using CREATE TABLE IF NOT EXISTS for idempotency`,
        });
      }
    }

    // Check 3: space_id index
    const hasSpaceId = new RegExp(`space_id`, 'i').test(content.substring(
      content.indexOf(createMatch?.[0] || ''),
      content.indexOf(';', content.indexOf(createMatch?.[0] || ''))
    ));
    if (hasSpaceId) {
      const indexPattern = new RegExp(`CREATE\\s+INDEX.*${tableName}.*space_id|CREATE\\s+INDEX.*space_id.*${tableName}`, 'i');
      if (!indexPattern.test(content)) {
        issues.push({
          file: filePath,
          severity: 'warning',
          message: `Table "${tableName}" has space_id but no index on it. Add: CREATE INDEX idx_${tableName}_space_id ON ${tableName}(space_id)`,
        });
      }
    }
  }

  // Check 4: updated_at column without trigger
  if (/updated_at/i.test(content) && !/set_updated_at|updated_at.*=.*now\(\)/i.test(content)) {
    issues.push({
      file: filePath,
      severity: 'warning',
      message: 'File has updated_at columns but no set_updated_at trigger function',
    });
  }

  // Check 5: Dangerous operations
  const dangerous = [
    { pattern: /DROP\s+TABLE(?!\s+IF\s+EXISTS)/gi, name: 'DROP TABLE without IF EXISTS' },
    { pattern: /DROP\s+COLUMN/gi, name: 'DROP COLUMN (breaking change)' },
    { pattern: /ALTER\s+TABLE.*RENAME/gi, name: 'RENAME (breaking change)' },
    { pattern: /TRUNCATE/gi, name: 'TRUNCATE' },
  ];

  for (const { pattern, name } of dangerous) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      // Check if there's a comment marker allowing it
      const lineIdx = content.substring(0, match.index).split('\n').length - 1;
      const line = lines[lineIdx] || '';
      if (!line.includes('-- Discipline Loop:ALLOW')) {
        issues.push({
          file: filePath,
          severity: 'error',
          message: `Dangerous operation: ${name}. Add "-- Discipline Loop:ALLOW" comment on the same line to suppress this check.`,
        });
      }
    }
  }

  // Check 6: RLS policies must scope rows to OWNERSHIP, not just authentication
  // (C1). We require a positive ownership binding — `<col> = auth.uid()` (directly
  // or inside a membership subquery) — in EACH present predicate clause, rather
  // than blacklisting specific literals. This catches the equivalent bypasses:
  // `USING (true)`, `((auth.uid() is not null))`, `auth.role() = 'authenticated'`,
  // `auth.jwt() ->> ...`, and role-only policies with no predicate at all.
  const ownershipFns = new Set([...directoryOwnershipFns, ...collectOwnershipFunctions(content)]);
  const policyBlocks = [...content.matchAll(/create\s+policy\s+[\s\S]*?;/gi)];
  for (const pol of policyBlocks) {
    const block = pol[0];
    // The marker may sit on the policy's line(s) after the closing ';' (outside the
    // matched block), so check the full line range the statement spans.
    const startLine = content.substring(0, pol.index).split('\n').length - 1;
    const endLine = content.substring(0, pol.index + block.length).split('\n').length - 1;
    const marked = lines.slice(startLine, endLine + 1).some((l) => l.includes('-- Discipline Loop:ALLOW_PERMISSIVE_RLS'));
    if (marked) continue;
    const nameMatch = block.match(/create\s+policy\s+"?([a-z0-9_]+)"?/i);
    const policyName = nameMatch?.[1] ?? '(unnamed)';

    const usingExpr = extractParenClause(block, /\busing\s*\(/i);
    const checkExpr = extractParenClause(block, /\bwith\s+check\s*\(/i);
    const clauses = [];
    if (usingExpr !== null) clauses.push({ kind: 'USING', expr: usingExpr });
    if (checkExpr !== null) clauses.push({ kind: 'WITH CHECK', expr: checkExpr });

    if (clauses.length === 0) {
      issues.push({
        file: filePath,
        severity: 'error',
        message: `RLS policy "${policyName}" has no USING/WITH CHECK predicate (role-only scope is not ownership). Add a clause scoped to ownership, e.g. USING (user_id = auth.uid()), or "-- Discipline Loop:ALLOW_PERMISSIVE_RLS" for an intentional public policy.`,
      });
      continue;
    }

    for (const clause of clauses) {
      if (!clauseScoped(clause.expr, ownershipFns)) {
        issues.push({
          file: filePath,
          severity: 'error',
          message: `RLS policy "${policyName}" ${clause.kind} is not scoped to row ownership (${permissiveReason(clause.expr)}). Bind auth.uid() to an ownership column, e.g. ${clause.kind} (user_id = auth.uid()). Add "-- Discipline Loop:ALLOW_PERMISSIVE_RLS" only for an intentional public policy.`,
        });
      }
    }
  }

  // Check 7: SECURITY DEFINER functions and views without security_invoker.
  // Both execute with the *owner's* rights, bypassing the caller's RLS. Allowed
  // only with an explicit marker and an empty search_path. An empty path forces
  // every relation in the function body to be schema-qualified, preventing an
  // attacker-controlled object from shadowing a trusted one.
  for (const match of content.matchAll(/security\s+definer/gi)) {
    const before = content.substring(0, match.index);
    const lineIdx = before.split('\n').length - 1;
    const line = lines[lineIdx] || '';
    const colInLine = match.index - (before.lastIndexOf('\n') + 1);
    const commentIdx = line.indexOf('--');
    if (commentIdx >= 0 && commentIdx < colInLine) continue; // match is inside a -- comment
    if (!line.includes('-- Discipline Loop:ALLOW_SECURITY_DEFINER')) {
      issues.push({
        file: filePath,
        severity: 'error',
        message: 'SECURITY DEFINER runs with the function owner rights and bypasses the caller RLS. Prefer SECURITY INVOKER; if intentional, pin `set search_path = ...` and add "-- Discipline Loop:ALLOW_SECURITY_DEFINER" on the same line.',
      });
      continue;
    }

    const functionStart = content.toLowerCase().lastIndexOf('create', match.index);
    const asMatch = /\bas\s+\$[a-z0-9_]*\$/i.exec(content.slice(match.index));
    const headerEnd = asMatch ? match.index + asMatch.index : -1;
    const functionHeader = functionStart >= 0 && headerEnd >= functionStart
      ? content.slice(functionStart, headerEnd)
      : '';
    if (!/set\s+search_path\s*=\s*''/i.test(functionHeader)) {
      issues.push({
        file: filePath,
        severity: 'error',
        message: 'SECURITY DEFINER function must use `set search_path = \'\'` and schema-qualified objects. Add it before AS $$ to prevent search-path hijacking.',
      });
    }
  }

  const viewBlocks = [...content.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+[\s\S]*?;/gi)];
  for (const view of viewBlocks) {
    const block = view[0];
    const lineIdx = content.substring(0, view.index).split('\n').length - 1;
    const line = lines[lineIdx] || '';
    const hasInvoker = /security_invoker\s*=\s*(?:on|true)/i.test(block);
    if (!hasInvoker && !line.includes('-- Discipline Loop:ALLOW_DEFINER_VIEW')) {
      const nameMatch = block.match(/view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/i);
      issues.push({
        file: filePath,
        severity: 'error',
        message: `View "${nameMatch?.[1] ?? '(unnamed)'}" created without "with (security_invoker = on)" runs with definer rights and bypasses RLS. Add the option, or "-- Discipline Loop:ALLOW_DEFINER_VIEW" on the same line if intentional.`,
      });
    }
  }
}

// Report
if (issues.length === 0) {
  console.log('[migration:lint] All migrations OK.');
  process.exit(0);
}

const errors = issues.filter(i => i.severity === 'error');
const warnings = issues.filter(i => i.severity === 'warning');

for (const w of warnings) {
  console.warn(`[WARN] ${w.file}: ${w.message}`);
}
for (const e of errors) {
  console.error(`[ERROR] ${e.file}: ${e.message}`);
}

console.log(`\n[migration:lint] ${errors.length} error(s), ${warnings.length} warning(s).`);

if (errors.length > 0) {
  process.exit(1);
}
