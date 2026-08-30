/** SDK-free validation for the two Gain Stage Doctor modal phases. */

import { isExactPlainRecord } from './modal-validation.js';

const PHASE_ONLY_KEYS = ['phase'] as const;
const ANALYZE_KEYS = ['phase', 'targetDb', 'trackIds'] as const;

/** The exact configure choices rendered by the shipped Gain Stage modal. */
export const GAIN_STAGE_TARGET_OPTIONS = [-18, -20, -12] as const;

export interface GainStageAnalyzeRequest {
  readonly phase: 'analyze';
  readonly targetDb: number;
  readonly trackIds: readonly string[];
}

export interface GainStageApplyRequest {
  readonly phase: 'apply';
}

export interface GainStageCancelRequest {
  readonly phase: 'cancel';
}

export type GainStageModalRequest =
  | GainStageAnalyzeRequest
  | GainStageApplyRequest
  | GainStageCancelRequest;

/** Treat malformed webview output as cancel, never as approval to mutate a mixer. */
export function parseGainStageModalRequest(value: unknown): GainStageModalRequest | null {
  try {
    if (isExactPlainRecord(value, PHASE_ONLY_KEYS)) {
      if (value.phase === 'cancel') return { phase: 'cancel' };
      if (value.phase === 'apply') return { phase: 'apply' };
      return null;
    }
    if (!isExactPlainRecord(value, ANALYZE_KEYS)) return null;
    const { phase, targetDb, trackIds } = value;
    if (
      phase !== 'analyze' ||
      typeof targetDb !== 'number' ||
      !Number.isFinite(targetDb) ||
      !isShippedTarget(targetDb) ||
      !Array.isArray(trackIds) ||
      !trackIds.every((trackId) => typeof trackId === 'string')
    ) {
      return null;
    }
    return { phase, targetDb, trackIds: [...trackIds] };
  } catch {
    return null;
  }
}

/** Accept only the analyze phase when crossing into the expensive read-only planner. */
export function validateGainStageAnalyzeRequest(value: unknown): GainStageAnalyzeRequest | null {
  const request = parseGainStageModalRequest(value);
  return request?.phase === 'analyze' ? request : null;
}

function isShippedTarget(targetDb: number): boolean {
  return (
    targetDb === GAIN_STAGE_TARGET_OPTIONS[0] ||
    targetDb === GAIN_STAGE_TARGET_OPTIONS[1] ||
    targetDb === GAIN_STAGE_TARGET_OPTIONS[2]
  );
}
