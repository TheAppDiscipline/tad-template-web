// Enums

export type PatchMode = 'append' | 'replace_section' | 'replace_block' | 'insert_after';
export type PacketStatus = 'draft' | 'validated' | 'ready';
export type StepId = '0a' | '1' | '2' | '2.5' | '3' | '4' | '4-reentry' | '4-feedback' | '4-hardening' | '5' | '6' | '7';
export type Lane = 'WEB' | 'MOBILE' | 'DESKTOP' | 'EXTENSION' | 'BACKEND' | 'WEB_SSR' | 'CLI';
export type Profile = 'LITE' | 'SHARED_SYNC' | 'LAUNCH' | 'PROD';
export type Backend = 'SUPABASE' | 'FIREBASE' | 'LOCAL_ONLY';
export type AuthMode = 'MAGIC_LINK' | 'EMAIL_PASSWORD' | 'BOTH' | 'NONE';
export type CollabMode = 'VIEW_ONLY' | 'COLLABORATIVE';
export type SyncMode = 'FAST_UI' | 'OFFLINE_FIRST';

// Parsed structures

export interface ParsedPatch {
  name: string;
  targetFile: string;
  patchMode: PatchMode;
  anchor: string;
  content: string;
  sourcePath: string;
}

export interface ParsedPacket {
  name: string;
  status: PacketStatus;
  generatedBy: string;
  date: string;
  slice?: number;
  body: string;
  sourcePath: string;
}

export interface DisciplineConfig {
  projectName: string;
  primaryGoal: string;
  profile: Profile;
  backendProvider: Backend;
  authMode: AuthMode;
  collabMode: CollabMode;
  syncMode: SyncMode;
  aiFeatures: 'none' | 'enabled';
  pushPlugin: boolean;
  lane: Lane;
  hosting: string;
}

// Validation

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  detail?: string;
}

// Run log

export interface RunLogEntry {
  date: string;
  step: string;
  tool: string;
  inputPacket: string;
  outputPacket: string;
  notes: string;
}

// Assembly config

export interface StepAssemblyConfig {
  step: string;
  requiredPackets: string[];
  optionalPackets: string[];
  outputFile: string;
  toolUrl?: string;
  includeProjectFiles?: string[];
}

// Helpers

export const VALID_PATCH_MODES: PatchMode[] = ['append', 'replace_section', 'replace_block', 'insert_after'];

export function disciplineError(message: string): never {
  console.error(`[Discipline Loop ERROR] ${message}`);
  process.exit(1);
}

export function disciplineWarn(message: string): void {
  console.warn(`[Discipline Loop WARN] ${message}`);
}

export function disciplineInfo(message: string): void {
  console.log(`[Discipline Loop] ${message}`);
}
