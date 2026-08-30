/**
 * Command handler for Session-to-Song Builder.
 *
 * This is the I/O half that wraps the pure {@link planArrangement}: it READS the
 * Session through the {@link LiveBridge} port (scenes, then each track's clips, then
 * the MIDI notes of every MIDI source clip) into a plain {@link SessionDTO}, PLANS
 * the build with the pure transform, then WRITES the whole arrangement back inside
 * ONE {@link LiveBridge.transaction} so the entire build is a single undo.
 *
 * It imports no SDK and speaks only the existing core port + DTOs, so it runs
 * unchanged against {@link import('../fake-live-bridge.js').FakeLiveBridge} and
 * against the real `AbletonLiveBridge`. The transaction callback returns `Promise.all([...])`
 * of the range clears, the per-placement create-then-populate helpers, and the
 * cue-point creates. Never `await` inside the callback; each placement helper does
 * its own awaiting and is collected into the one `Promise.all`.
 *
 * Ordering inside the `Promise.all` array is load-bearing: the clears come first.
 * The array's element order is the synchronous execution order of each mutation's
 * body, and a clear that ran after a create on the same track would discard the clip
 * just placed. Clearing the touched tracks first keeps the target range clean and
 * leaves the freshly created clips in place.
 */

import type { ClipId, SceneId, TrackId } from '../ids.js';
import { isPlayableClip } from '../dtos.js';
import { badInput, staleReference } from '../errors.js';
import type {
  ClipInfo,
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
import { planArrangement } from '../transforms/arrangement.js';

/** What {@link runSessionToSong} reports back: the count of clips placed and cue points made. */
export interface SessionToSongResult {
  /** Number of {@link Placement}s written to the Arrangement. */
  readonly placementCount: number;
  /** Number of cue points (section locators) created. */
  readonly cuePointCount: number;
}

/** The arguments {@link runSessionToSong} takes (the section map + the fallback time signature). */
export interface SessionToSongArgs {
  /** The user's ordered section list, bound to opaque scene references. */
  readonly sectionMap: readonly Section[];
  /** Fallback time signature for sections whose scene does not report one (callers pass 4/4). */
  readonly timeSig: TimeSig;
}

/**
 * Resolve the modal's open-time scene references against the current scene order.
 *
 * A scene may move while the modal is open, so its former numeric position is never
 * trusted. A missing reference is a typed stale-reference failure before the handler
 * reads clips or opens a transaction. The returned index is planning-only and cannot
 * be supplied by a caller alongside a conflicting reference.
 */
function resolveSections(
  bridge: LiveBridge,
  sectionMap: readonly Section[],
): readonly ResolvedSection[] {
  const currentScenes = bridge.listScenes();
  const currentIndexByRef = new Map<SceneId, number>(
    currentScenes.map((scene, index) => [scene.id, index]),
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

/**
 * Turn a scene's reported time signature into a {@link SceneDTO} `timeSig`, omitting
 * it when the scene reports the conventional 4/4 so the planner falls back to the
 * plan-level signature (the SDK has no Set-level time signature; the scene always
 * reports one, but a 4/4 scene should not force-override an explicit plan default).
 * A non-4/4 scene signature is carried through so mixed-meter sets plan correctly.
 */
function sceneTimeSig(numerator: number, denominator: number): TimeSig | undefined {
  if (numerator === 4 && denominator === 4) {
    return undefined;
  }
  return { num: numerator, den: denominator };
}

/**
 * Read the whole Session into a plain {@link SessionDTO}.
 *
 * Synchronous reads only (`listTracks`, `listScenes`, `listClips` per track,
 * `getNotes` for each MIDI source clip). For every non-empty Session clip it records
 * the owning track and scene index, the name/color/length, and either the MIDI notes
 * (MIDI clips) or the source file path (audio clips), so the pure planner has
 * everything it needs to recreate each clip without re-touching the bridge. Empty
 * Session slots and Arrangement clips are skipped (the planner sources from Session
 * clips only).
 */
function readSession(bridge: LiveBridge): SessionDTO {
  const tracks = bridge.listTracks();
  const scenes: SceneDTO[] = bridge.listScenes().map((scene, index) => {
    const timeSig = sceneTimeSig(scene.signatureNumerator, scene.signatureDenominator);
    const dto: SceneDTO =
      timeSig === undefined ? { index, name: scene.name } : { index, name: scene.name, timeSig };
    return dto;
  });

  const clips: SessionClipDTO[] = [];
  tracks.forEach((track, trackIndex) => {
    for (const entry of bridge.listClips(track.id)) {
      if (!isPlayableClip(entry) || entry.location !== 'session') {
        continue;
      }
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
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, type: t.kind })),
    scenes,
    clips,
  };
}

/** Build one {@link SessionClipDTO} from a listed Session {@link ClipInfo}. */
function sessionClipFromInfo(
  bridge: LiveBridge,
  entry: PopulatedClipInfo,
  trackIndex: number,
  sceneIndex: number,
): SessionClipDTO {
  const clipRef = entry.id;
  const base = {
    clipRef,
    trackIndex,
    sceneIndex,
    isMidi: entry.isMidi,
    name: entry.name,
    color: entry.color,
    durationBeats: entry.duration,
  };
  if (entry.isMidi) {
    // MIDI source: carry the notes so the placement can repopulate the recreated clip.
    return { ...base, notes: bridge.getNotes(clipRef) };
  }
  // Audio source: carry the file path so the placement can reference it by file.
  // Omit `filePath` if the bridge did not report one (exactOptionalPropertyTypes).
  return entry.filePath === undefined ? base : { ...base, filePath: entry.filePath };
}

/**
 * Build the Session-to-Song Arrangement in one undo.
 *
 * Reads the Session, plans the build with the pure {@link planArrangement}, then runs
 * a SINGLE {@link LiveBridge.transaction}: clear the touched tracks' target range,
 * create-and-populate each placement, and create each cue point, all collected into
 * one `Promise.all`. Resolves to the placement and cue-point counts.
 *
 * @param bridge the Live bridge port (fake in tests, real adapter in Live).
 * @param args the section map and fallback time signature.
 * @returns `{ placementCount, cuePointCount }`.
 */
export async function runSessionToSong(
  bridge: LiveBridge,
  args: SessionToSongArgs,
): Promise<SessionToSongResult> {
  // Resolve selected scene identity before every read that might lead to a write. This
  // both fails closed on deletion and follows a reordered scene to its current index.
  const resolvedSections = resolveSections(bridge, args.sectionMap);
  const session = readSession(bridge);
  const plan = planArrangement(session, resolvedSections, args.timeSig);

  // A no-op plan (an empty section map yields no placements and no cue points) commits
  // no transaction: a user action that builds nothing leaves no undo step, matching the
  // empty-input behavior of the gain-stage-doctor and set-janitor handlers.
  if (plan.placements.length === 0 && plan.cuePoints.length === 0) {
    return { placementCount: 0, cuePointCount: 0 };
  }

  // Index the source clips by their stable id so each placement can find its source
  // (notes for MIDI, filePath for audio) without another bridge read.
  const sourceByRef = new Map<string, SessionClipDTO>(
    session.clips.map((clip) => [clip.clipRef, clip]),
  );

  await writeBuild(bridge, session, plan, sourceByRef);

  return { placementCount: plan.placements.length, cuePointCount: plan.cuePoints.length };
}

/**
 * The one transaction. The callback is synchronous and returns `Promise.all([...])`
 * of: every touched track's range clear (FIRST, so a clear never discards a clip a
 * later create placed), then every placement's create-then-populate helper, then
 * every cue-point create. Each helper awaits internally; the callback itself never
 * awaits. One call = one undo (the fake asserts exactly one transaction).
 */
function writeBuild(
  bridge: LiveBridge,
  session: SessionDTO,
  plan: PlanResult,
  sourceByRef: ReadonlyMap<string, SessionClipDTO>,
): Promise<unknown> {
  // The beat span to clear on each touched track: 0 to the end of the last placement.
  const rangeEnd = plan.placements.reduce(
    (max, p) => Math.max(max, p.startBeat + p.durationBeats),
    0,
  );
  const touchedTrackIndices = [...new Set(plan.placements.map((p) => p.trackIndex))];

  return bridge.transaction(() =>
    Promise.all([
      // Clears FIRST: clean the target range on every track that will receive a clip.
      ...touchedTrackIndices.flatMap((trackIndex) => {
        const track = session.tracks[trackIndex];
        if (track === undefined || rangeEnd <= 0) {
          return [];
        }
        return [bridge.clearClipsInRange(track.id, 0, rangeEnd)];
      }),
      // Then create-and-populate each placement.
      ...plan.placements.map((placement) => {
        const track = session.tracks[placement.trackIndex];
        if (track === undefined) {
          return Promise.resolve();
        }
        return placeClip(bridge, track.id, placement, sourceByRef.get(placement.sourceClipRef));
      }),
      // Then create each section cue point.
      ...plan.cuePoints.map((cue) => bridge.createCuePoint(cue.beat, cue.name)),
    ]),
  );
}

/**
 * Create one Arrangement clip for a placement and populate it.
 *
 * MIDI: `createArrangementMidiClip` then `setNotes` (the source clip's notes) then
 * `setClipProps` (name + color). Audio: `createArrangementAudioClip` by file (the
 * source clip's `filePath`) then `setClipProps`. The create is async and the populate
 * calls await it; all of this runs inside the surrounding transaction (so it
 * collapses to that one undo). This is the "recreate, not move" path: it copies the
 * MIDI notes / references the audio by file rather than relocating the Session clip.
 */
async function placeClip(
  bridge: LiveBridge,
  trackId: TrackId,
  placement: Placement,
  source: SessionClipDTO | undefined,
): Promise<void> {
  const isMidi = source?.isMidi ?? true;
  if (isMidi) {
    const clip = await bridge.createArrangementMidiClip(
      trackId,
      placement.startBeat,
      placement.durationBeats,
    );
    const created = requirePlayableClip(clip);
    if (source?.notes !== undefined && source.notes.length > 0) {
      await bridge.setNotes(created.id, source.notes);
    }
    await applyClipProps(bridge, created.id, placement);
    return;
  }
  // Audio placement: reference the source file. A source with no filePath cannot be
  // recreated as audio, so skip it rather than create an empty clip.
  if (source?.filePath === undefined) {
    return;
  }
  const clip = await bridge.createArrangementAudioClip(trackId, {
    filePath: source.filePath,
    startTime: placement.startBeat,
    duration: placement.durationBeats,
  });
  await applyClipProps(bridge, requirePlayableClip(clip).id, placement);
}

function requirePlayableClip(clip: ClipInfo): PopulatedClipInfo {
  if (!isPlayableClip(clip)) {
    throw new Error('Bridge returned an empty slot for an Arrangement clip create');
  }
  return clip;
}

/**
 * Write a placement's name and color onto the recreated clip. `name` is always set;
 * `color` is set when the placement carries one (it always does in practice, since
 * the planner sources a color from the section override or the source clip).
 */
async function applyClipProps(
  bridge: LiveBridge,
  clipId: ClipId,
  placement: Placement,
): Promise<void> {
  const props: { name?: string; color?: number } = { name: placement.name };
  if (placement.color !== undefined) {
    props.color = placement.color;
  }
  await bridge.setClipProps(clipId, props);
}
