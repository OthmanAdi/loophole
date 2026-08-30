/** SDK-free validation for the two Gain Stage Doctor modal phases. */

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
  if (typeof value !== 'object' || value === null || !('phase' in value)) return null;
  const phase = value.phase;
  if (phase === 'cancel' || phase === 'apply') return { phase };
  if (
    phase !== 'analyze' ||
    !('targetDb' in value) ||
    typeof value.targetDb !== 'number' ||
    !Number.isFinite(value.targetDb) ||
    !('trackIds' in value) ||
    !Array.isArray(value.trackIds) ||
    !value.trackIds.every((trackId) => typeof trackId === 'string')
  ) {
    return null;
  }
  return { phase, targetDb: value.targetDb, trackIds: value.trackIds };
}
