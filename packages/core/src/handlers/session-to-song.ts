/** Build a Session selection into physical Arrangement clips in SDK-safe phases. */

import type { SceneId, TrackId } from '../ids.js';
import { isPlayableClip } from '../dtos.js';
import { badInput, BridgeError, staleReference, unsupported } from '../errors.js';
import type {
  ClipInfo,
  CuePointInfo,
  NoteDTO,
  PopulatedClipInfo,
  Placement,
  PlanResult,
  ResolvedSection,
  SceneDTO,
  Section,
  SessionClipDTO,
  SessionDTO,
  TimeSig,
} from '../dtos.js';
import type { LiveBridge } from '../live-bridge.js';
import { cropMidiNotesForPlacement, planArrangement } from '../transforms/arrangement.js';

export interface SessionToSongResult {
  readonly placementCount: number;
  readonly cuePointCount: number;
  /** Exact undo entries committed by this run. */
  readonly undoStepCount: 0 | 2 | 3;
}

export interface SessionToSongArgs {
  readonly sectionMap: readonly Section[];
  readonly timeSig: TimeSig;
}

/**
 * A failed phase leaves prior committed phases intact. `undoStepsToRestore` is exact:
 * it restores the Set to its state before this command, rather than merely removing
 * visible newly-created clips.
 */
export class SessionToSongPartialBuildError extends BridgeError {
  readonly phase: 'create' | 'populate';
  readonly placementCount: number;
  readonly cuePointCount: number;
  readonly undoStepsToRestore: 1 | 2;

  constructor(
    phase: 'create' | 'populate',
    placementCount: number,
    cuePointCount: number,
    undoStepsToRestore: 1 | 2,
    cause: unknown,
  ) {
    const undoInstruction = undoStepsToRestore === 1 ? 'Undo once' : 'Undo twice';
    super(
      'SDK_REJECTED',
      phase === 'create'
        ? 'Session-to-Song cleared the target range but could not create its Arrangement structure.'
        : 'Session-to-Song created the Arrangement structure but could not populate all clip contents and cue names.',
      {
        hint: `${undoInstruction} to restore the Set to its pre-run state, then correct the issue and retry.`,
        cause,
      },
    );
    this.phase = phase;
    this.placementCount = placementCount;
    this.cuePointCount = cuePointCount;
    this.undoStepsToRestore = undoStepsToRestore;
  }
}

function resolveSections(
  bridge: LiveBridge,
  sectionMap: readonly Section[],
): readonly ResolvedSection[] {
  const currentIndexByRef = new Map<SceneId, number>(
    bridge.listScenes().map((scene, index) => [scene.id, index]),
  );
  return sectionMap.map((section) => {
    const sceneIndex = currentIndexByRef.get(section.sceneRef);
    if (sceneIndex === undefined) {
      throw staleReference(
        section.sceneRef,
        'A selected Session scene changed or was deleted while the dialog was open. Re-list scenes and retry.',
      );
    }
    const base = { name: section.name, sceneIndex, bars: section.bars };
    return section.color === undefined ? base : { ...base, color: section.color };
  });
}

function sceneTimeSig(numerator: number, denominator: number): TimeSig | undefined {
  return numerator === 4 && denominator === 4 ? undefined : { num: numerator, den: denominator };
}

function readSession(bridge: LiveBridge): SessionDTO {
  const tracks = bridge.listTracks();
  const scenes: SceneDTO[] = bridge.listScenes().map((scene, index) => {
    const timeSig = sceneTimeSig(scene.signatureNumerator, scene.signatureDenominator);
    return timeSig === undefined
      ? { index, name: scene.name }
      : { index, name: scene.name, timeSig };
  });
  const clips: SessionClipDTO[] = [];

  tracks.forEach((track, trackIndex) => {
    for (const entry of bridge.listClips(track.id)) {
      if (!isPlayableClip(entry) || entry.location !== 'session') continue;
      if (entry.slotId === undefined || entry.sceneIndex === undefined) {
        throw badInput(
          'Bridge returned a populated Session clip without its slot reference or scene index.',
          'Re-list Session clips with a bridge that supplies slotId and sceneIndex before building.',
        );
      }
      clips.push(sessionClipFromInfo(bridge, entry, trackIndex, entry.sceneIndex));
    }
  });
  return {
    tracks: tracks.map((track) => ({ id: track.id, name: track.name, type: track.kind })),
    scenes,
    clips,
  };
}

function sessionClipFromInfo(
  bridge: LiveBridge,
  entry: PopulatedClipInfo,
  trackIndex: number,
  sceneIndex: number,
): SessionClipDTO {
  const base = {
    clipRef: entry.id,
    trackIndex,
    sceneIndex,
    isMidi: entry.isMidi,
    name: entry.name,
    color: entry.color,
    durationBeats: entry.duration,
    looping: entry.looping,
    loopStart: entry.loopStart,
    loopEnd: entry.loopEnd,
  };
  return entry.isMidi
    ? { ...base, notes: bridge.getNotes(entry.id) }
    : entry.filePath === undefined
      ? base
      : { ...base, filePath: entry.filePath };
}

interface PreparedPlacement {
  readonly placement: Placement;
  readonly source: SessionClipDTO;
  readonly trackId: TrackId;
  readonly notes: readonly NoteDTO[] | undefined;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validatePlanningGeometry(
  session: SessionDTO,
  sections: readonly ResolvedSection[],
  fallbackTimeSig: TimeSig,
): void {
  if (!finitePositive(fallbackTimeSig.num) || !finitePositive(fallbackTimeSig.den)) {
    throw badInput('Session-to-Song requires a finite positive fallback time signature.');
  }
  let startBeat = 0;
  for (const section of sections) {
    const sig = session.scenes[section.sceneIndex]?.timeSig ?? fallbackTimeSig;
    if (!finitePositive(section.bars) || !finitePositive(sig.num) || !finitePositive(sig.den)) {
      throw badInput('Session-to-Song sections require finite positive bars and time signatures.');
    }
    const sectionBeats = section.bars * sig.num * (4 / sig.den);
    if (!finitePositive(sectionBeats) || !Number.isFinite(startBeat) || startBeat < 0) {
      throw badInput('Session-to-Song sections must produce finite positive beat ranges.');
    }
    startBeat += sectionBeats;
    if (!Number.isFinite(startBeat)) {
      throw badInput('Session-to-Song cue points must remain at finite non-negative beats.');
    }
  }
}

/** Validate all source and target requirements before opening either write phase. */
function preflight(
  session: SessionDTO,
  plan: PlanResult,
  sourceByRef: ReadonlyMap<string, SessionClipDTO>,
): readonly PreparedPlacement[] {
  return plan.placements.map((placement) => {
    const source = sourceByRef.get(placement.sourceClipRef);
    const track = session.tracks[placement.trackIndex];
    if (source === undefined || track === undefined) {
      throw badInput(
        'The Session-to-Song plan references a source clip or target track that no longer exists.',
      );
    }
    if (
      !finitePositive(placement.durationBeats) ||
      !Number.isFinite(placement.startBeat) ||
      placement.startBeat < 0 ||
      !Number.isFinite(placement.sourceStartBeat) ||
      placement.sourceStartBeat < 0
    ) {
      throw badInput(
        'Session-to-Song produced an invalid Arrangement placement duration or start time.',
      );
    }
    if (!finitePositive(source.durationBeats)) {
      throw badInput(`Session clip "${source.name}" has an invalid source duration.`);
    }
    if (source.isMidi !== (track.type === 'midi')) {
      throw badInput(`Session clip "${source.name}" does not match its target track type.`);
    }
    if (
      source.looping &&
      (!Number.isFinite(source.loopStart) ||
        source.loopStart < 0 ||
        !finitePositive(source.loopEnd - source.loopStart))
    ) {
      throw badInput(`Looping Session clip "${source.name}" has an invalid loop window.`);
    }
    if (!source.isMidi) {
      if (source.filePath === undefined || source.filePath.length === 0) {
        throw badInput(`Audio Session clip "${source.name}" has no source file path.`);
      }
      if (source.loopStart !== 0 || source.loopEnd !== source.durationBeats) {
        throw unsupported(
          `Audio Session clip "${source.name}" has a custom loop or source offset that cannot be recreated safely.`,
          'Use an audio clip whose source starts at beat 0 and whose loop window matches its source duration.',
        );
      }
    }
    return {
      placement,
      source,
      trackId: track.id,
      notes: source.isMidi
        ? cropMidiNotesForPlacement(
            source.notes ?? [],
            placement.sourceStartBeat,
            placement.durationBeats,
          )
        : undefined,
    };
  });
}

function requirePlayableClip(clip: ClipInfo): PopulatedClipInfo {
  if (!isPlayableClip(clip)) {
    throw new Error('Bridge returned an empty slot for an Arrangement clip create.');
  }
  return clip;
}

/** Phase 1 creator only. It must not populate the returned clip. */
async function createPlacement(
  bridge: LiveBridge,
  prepared: PreparedPlacement,
): Promise<PopulatedClipInfo> {
  const { placement, source, trackId } = prepared;
  const created = source.isMidi
    ? await bridge.createArrangementMidiClip(trackId, placement.startBeat, placement.durationBeats)
    : await bridge.createArrangementAudioClip(trackId, {
        filePath: source.filePath!,
        startTime: placement.startBeat,
        duration: placement.durationBeats,
      });
  return requirePlayableClip(created);
}

function clipProps(placement: Placement): { name: string; color?: number } {
  return placement.color === undefined
    ? { name: placement.name }
    : { name: placement.name, color: placement.color };
}

function clearRangeEnd(plan: PlanResult): number {
  return plan.placements.reduce(
    (maximum, placement) => Math.max(maximum, placement.startBeat + placement.durationBeats),
    0,
  );
}

/** Clear first in its own transaction so a delayed SDK clear cannot erase new clips. */
async function writeClearPhase(
  bridge: LiveBridge,
  plan: PlanResult,
  prepared: readonly PreparedPlacement[],
): Promise<boolean> {
  const rangeEnd = clearRangeEnd(plan);
  const touchedTrackIds = [...new Set(prepared.map((placement) => placement.trackId))];
  if (rangeEnd <= 0 || touchedTrackIds.length === 0) return false;
  await bridge.transaction(() =>
    Promise.all(touchedTrackIds.map((trackId) => bridge.clearClipsInRange(trackId, 0, rangeEnd))),
  );
  return true;
}

/** Create phase: all creators start synchronously, but no dependent mutation runs here. */
async function writeCreatePhase(
  bridge: LiveBridge,
  plan: PlanResult,
  prepared: readonly PreparedPlacement[],
): Promise<{ placements: readonly PopulatedClipInfo[]; cuePoints: readonly CuePointInfo[] }> {
  let placementPromises: readonly Promise<PopulatedClipInfo>[] = [];
  let cuePointPromises: readonly Promise<CuePointInfo>[] = [];

  await bridge.transaction(() => {
    placementPromises = prepared.map((placement) => createPlacement(bridge, placement));
    cuePointPromises = plan.cuePoints.map((cuePoint) => bridge.createCuePoint(cuePoint.beat));
    return Promise.all([...placementPromises, ...cuePointPromises]);
  });

  return {
    placements: await Promise.all(placementPromises),
    cuePoints: await Promise.all(cuePointPromises),
  };
}

function writePhaseTwo(
  bridge: LiveBridge,
  prepared: readonly PreparedPlacement[],
  createdPlacements: readonly PopulatedClipInfo[],
  cuePoints: readonly CuePointInfo[],
  plan: PlanResult,
): Promise<unknown> {
  return bridge.transaction(() =>
    Promise.all([
      ...prepared.flatMap((preparedPlacement, index) => {
        const created = createdPlacements[index];
        if (created === undefined)
          throw new Error('Phase 1 did not return every created Arrangement clip.');
        const writes: Promise<unknown>[] = [];
        if (preparedPlacement.notes !== undefined) {
          writes.push(bridge.setNotes(created.id, preparedPlacement.notes));
        }
        writes.push(bridge.setClipProps(created.id, clipProps(preparedPlacement.placement)));
        return writes;
      }),
      ...cuePoints.map((cuePoint, index) => {
        const cue = plan.cuePoints[index];
        if (cue === undefined) throw new Error('Phase 1 did not return every created cue point.');
        return bridge.setCuePointName(cuePoint.id, cue.name);
      }),
    ]),
  );
}

export async function runSessionToSong(
  bridge: LiveBridge,
  args: SessionToSongArgs,
): Promise<SessionToSongResult> {
  // This stale-reference check is before all source reads and all writes.
  const resolvedSections = resolveSections(bridge, args.sectionMap);
  const session = readSession(bridge);
  validatePlanningGeometry(session, resolvedSections, args.timeSig);
  const plan = planArrangement(session, resolvedSections, args.timeSig);
  if (plan.placements.length === 0 && plan.cuePoints.length === 0) {
    return { placementCount: 0, cuePointCount: 0, undoStepCount: 0 };
  }

  const sourceByRef = new Map<string, SessionClipDTO>(
    session.clips.map((clip) => [clip.clipRef, clip]),
  );
  // No write transaction opens until all sources, geometry, types, and audio limits
  // have been checked and MIDI note crops computed.
  const prepared = preflight(session, plan, sourceByRef);
  const didClear = await writeClearPhase(bridge, plan, prepared);
  let phaseOne: { placements: readonly PopulatedClipInfo[]; cuePoints: readonly CuePointInfo[] };
  try {
    phaseOne = await writeCreatePhase(bridge, plan, prepared);
  } catch (error) {
    if (didClear) {
      throw new SessionToSongPartialBuildError(
        'create',
        plan.placements.length,
        plan.cuePoints.length,
        1,
        error,
      );
    }
    throw error;
  }
  try {
    await writePhaseTwo(bridge, prepared, phaseOne.placements, phaseOne.cuePoints, plan);
  } catch (error) {
    throw new SessionToSongPartialBuildError(
      'populate',
      plan.placements.length,
      plan.cuePoints.length,
      didClear ? 2 : 1,
      error,
    );
  }
  return {
    placementCount: plan.placements.length,
    cuePointCount: plan.cuePoints.length,
    undoStepCount: didClear ? 3 : 2,
  };
}
