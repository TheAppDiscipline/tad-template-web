import type { StepAssemblyConfig, StepId } from './types.js';

const STEP_4_CONTEXT_FILES = ['discipline.md', 'task_plan.md', 'findings.md', 'progress.md'];

export const STEP_ASSEMBLY_MAP: Record<StepId, StepAssemblyConfig> = {
  '1': {
    step: '1',
    requiredPackets: [],
    optionalPackets: ['IDEA_VALIDATION_PACKET.md'],
    outputFile: 'step-1-all-prompts.md',
  },
  '2': {
    step: '2',
    requiredPackets: ['STEP_2_ARCHITECTURE_PACKET.md'],
    optionalPackets: ['STEP_4_EXECUTION_PACKET.draft.md', 'STEP_2_5_AI_PACKET.md'],
    outputFile: 'step-2-input.md',
  },
  '2.5': {
    step: '2.5',
    requiredPackets: ['STEP_2_5_AI_PACKET.md', 'STEP_4_EXECUTION_PACKET.md'],
    optionalPackets: [],
    outputFile: 'step-2.5-input.md',
    toolUrl: 'https://aistudio.google.com',
  },
  '3': {
    step: '3',
    requiredPackets: ['STEP_3_STITCH_PACKET.md'],
    optionalPackets: [],
    outputFile: 'step-3-input.md',
    toolUrl: 'https://stitch.withgoogle.com',
  },
  '4': {
    step: '4',
    requiredPackets: ['STEP_4_EXECUTION_PACKET.md'],
    optionalPackets: ['UI_HANDOFF_PACKET.md', 'AI_IMPLEMENTATION_PACKET.md'],
    outputFile: 'step-4-input.md',
  },
  '4-reentry': {
    step: '4-reentry',
    requiredPackets: ['SLICE_COMPLETION_PACKET.md'],
    optionalPackets: ['POST_DEPLOY_FEEDBACK_PACKET.md'],
    outputFile: 'step-4-reentry.md',
    includeProjectFiles: STEP_4_CONTEXT_FILES,
  },
  '4-feedback': {
    step: '4-feedback',
    requiredPackets: ['POST_DEPLOY_FEEDBACK_PACKET.md'],
    optionalPackets: ['DEPLOY_READINESS_PACKET.md'],
    outputFile: 'step-4-feedback.md',
    includeProjectFiles: STEP_4_CONTEXT_FILES,
  },
  '4-hardening': {
    step: '4-hardening',
    requiredPackets: ['PROD_HARDENING_PACKET.md'],
    optionalPackets: ['POST_DEPLOY_FEEDBACK_PACKET.md'],
    outputFile: 'step-4-hardening.md',
    includeProjectFiles: STEP_4_CONTEXT_FILES,
  },
  '5': {
    step: '5',
    requiredPackets: ['STEP_5_SLICE_PACKET.md'],
    optionalPackets: ['UI_HANDOFF_PACKET.md', 'AI_IMPLEMENTATION_PACKET.md'],
    outputFile: 'step-5-input.md',
  },
  '6': {
    step: '6',
    requiredPackets: ['DEPLOY_READINESS_PACKET.md'],
    optionalPackets: [],
    outputFile: 'step-6-input.md',
  },
  '7': {
    step: '7',
    requiredPackets: ['POST_DEPLOY_FEEDBACK_PACKET.md'],
    optionalPackets: [],
    outputFile: 'step-7-input.md',
  },
  '0a': {
    step: '0a',
    requiredPackets: [],
    optionalPackets: [],
    outputFile: 'step-0a-input.md',
  },
};

export const VALID_STEPS = Object.keys(STEP_ASSEMBLY_MAP) as StepId[];

export const ALL_PACKET_NAMES = [
  'IDEA_VALIDATION_PACKET',
  'STEP_2_ARCHITECTURE_PACKET',
  'STEP_2_5_AI_PACKET',
  'STEP_3_STITCH_PACKET',
  'STEP_4_EXECUTION_PACKET',
  'DISCIPLINE_MD_READY_BLOCK',
  'TASK_PLAN_READY_BLOCK',
  'UI_HANDOFF_PACKET',
  'DESIGN_MD_READY_BLOCK',
  'AI_IMPLEMENTATION_PACKET',
  'READY_SLICES_BLOCK',
  'DISCIPLINE_MD_PATCH_BLOCK',
  'TASK_PLAN_PATCH_BLOCK',
  'FINDINGS_APPEND_BLOCK',
  'STEP_5_SLICE_PACKET',
  'SLICE_COMPLETION_PACKET',
  'DEPLOY_READINESS_PACKET',
  'POST_DEPLOY_FEEDBACK_PACKET',
  'PROD_HARDENING_PACKET',
] as const;
