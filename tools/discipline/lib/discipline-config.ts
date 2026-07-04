import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DisciplineConfig, Lane, Profile, Backend, AuthMode, CollabMode, SyncMode } from './types.js';
import { disciplineError } from './types.js';
import { findSectionBounds } from './anchors.js';

export function readDisciplineConfig(projectRoot: string): DisciplineConfig {
  const disciplinePath = path.join(projectRoot, 'discipline.md');
  if (!fs.existsSync(disciplinePath)) disciplineError(`discipline.md not found in: ${projectRoot}. Did you run discipline:hydrate?`);

  const content = fs.readFileSync(disciplinePath, 'utf-8');
  const lines = content.split('\n');
  const bounds = findSectionBounds(lines, '## 0) Profile');
  if (!bounds) disciplineError(`Section "## 0) Profile" not found in discipline.md`);

  const sectionLines = lines.slice(bounds.start, bounds.end);
  const switches: Record<string, string> = {};
  for (const line of sectionLines) {
    const match = line.match(/^-\s+(\w[\w_]*):\s*(.+)/);
    if (match) { switches[match[1].toUpperCase()] = match[2].replace(/#.*$/, '').trim(); }
  }

  return {
    projectName: switches['PROJECT_NAME'] || 'unnamed',
    primaryGoal: switches['PRIMARY_GOAL'] || '',
    profile: (switches['PROFILE'] || 'SHARED_SYNC') as Profile,
    backendProvider: (switches['BACKEND_PROVIDER'] || 'SUPABASE') as Backend,
    authMode: (switches['AUTH_MODE'] || 'MAGIC_LINK') as AuthMode,
    collabMode: (switches['COLLAB_MODE'] || 'VIEW_ONLY') as CollabMode,
    syncMode: (switches['SYNC_MODE'] || 'FAST_UI') as SyncMode,
    aiFeatures: switches['AI_FEATURES'] === 'enabled' ? 'enabled' : 'none',
    pushPlugin: switches['PUSH_PLUGIN'] === 'true',
    lane: (switches['LANE'] || 'WEB') as Lane,
    hosting: switches['HOSTING'] || '',
  };
}

export function resolveProjectRoot(flagValue?: string): string {
  if (flagValue) {
    const resolved = path.resolve(flagValue);
    if (!fs.existsSync(resolved)) disciplineError(`Directorio no encontrado: ${resolved}`);
    return resolved;
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'discipline.md')) || fs.existsSync(path.join(dir, '.discipline'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
