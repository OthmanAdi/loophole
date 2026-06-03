/**
 * Pure arrangement planner for Session-to-Song Builder (W5, the flagship).
 *
 * `planArrangement` is the intelligence half of the extension: it takes a plain
 * {@link SessionDTO} (scenes + tracks + the Session clips, all handle-free), the
 * user's {@link Section} map (which scene becomes which song section and how many
 * bars long), and a fallback {@link TimeSig}, and produces a {@link PlanResult}: the
 * clips to write onto the Arrangement timeline ({@link Placement}[]) and the named
 * section-boundary cue points. It performs no I/O and imports no SDK; the handler
 * (`handlers/session-to-song.ts`) turns the plan into one transaction of bridge
 * mutations.
 *
 * It is the answer to "loopitis" (03_EXTENSIONS_SPEC §4): a Session full of loops
 * becomes a finished song skeleton. The function is deterministic and exhaustively
 * unit-testable (ring 1) because it is pure data in, pure data out.
 *
 * Grounded in 03_EXTENSIONS_SPEC §4(b):
 *  - bars are converted to beats via the section's effective time signature,
 *  - each section's start beat is the running sum of the prior sections' lengths,
 *  - for each section, for every track that has a clip in the mapped scene, one
 *    {@link Placement} is emitted (a track with no clip in that scene is skipped),
 *  - one cue point is emitted per section at its start beat, carrying its name.
 */

import type {
  PlanResult,
  Placement,
  Section,
  SessionClipDTO,
  SessionDTO,
  TimeSig,
} from '../dtos.js';

/**
 * Beats in one bar of `sig`. One quarter note is one beat (the house convention the
 * codebase already uses for {@link import('../dtos.js').GridInfo}'s `beatsPerCell`):
 * `beatsPerBar = num * (4 / den)`. So 4/4 = 4 beats, 3/4 = 3 beats, 6/8 = 3 beats,
 * 7/8 = 3.5 beats. The denominator scales a beat relative to a quarter note; the
 * numerator counts those beats per bar.
 */
export function beatsPerBar(sig: TimeSig): number {
  return sig.num * (4 / sig.den);
}

/**
 * The time signature in force for a section: the section's mapped scene overrides
 * the plan-level fallback when it reports one (the SDK has no Set-level time
 * signature; it lives on the {@link import('../dtos.js').SceneDTO}, per
 * 03_EXTENSIONS_SPEC §4(d)). Falls back to `fallback` (the `planArrangement`
 * `timeSig` argument, defaulted to 4/4 by callers) when the scene does not, or when
 * the section maps to a scene index outside the Session (a defensive fallback rather
 * than a throw, since a malformed map should still plan the rest of the song).
 */
function sectionTimeSig(section: Section, session: SessionDTO, fallback: TimeSig): TimeSig {
  const scene = session.scenes[section.sceneIndex];
  return scene?.timeSig ?? fallback;
}

/**
 * The Session clips that sit in `sceneIndex`, in track order. A clip belongs to the
 * scene when its `sceneIndex` matches; the planner emits one {@link Placement} per
 * such clip, so a track with no clip in the mapped scene (e.g. Drums in the Intro of
 * the {@link import('../fake-live-bridge.js').FakeLiveBridge.seededSession} fixture)
 * contributes nothing. Returned in ascending `trackIndex` order so placements are
 * deterministic regardless of the input clip order.
 */
function clipsInScene(session: SessionDTO, sceneIndex: number): readonly SessionClipDTO[] {
  return session.clips
    .filter((clip) => clip.sceneIndex === sceneIndex)
    .slice()
    .sort((a, b) => a.trackIndex - b.trackIndex);
}

/**
 * Plan the Arrangement build for a Session.
 *
 * Iterates `sectionMap` in order, accumulating each section's start beat from the
 * lengths of the sections before it (`bars × beatsPerBar(effectiveSig)`). For each
 * section it finds every track that has a clip in the mapped scene and emits one
 * {@link Placement} spanning the whole section (the source loop is placed once to
 * fill the section, copying its notes/file plus name and color); it also emits one
 * cue point at the section's start beat named after the section.
 *
 * Pure: it reads `session` and `sectionMap` and returns fresh arrays; it mutates
 * nothing. An empty scene (no clips mapped) yields no placements for that section but
 * still advances the timeline and still emits the section's cue point, so the song
 * structure (and its locators) is complete even where a section is silent.
 *
 * @param session the Session as plain data (scenes, tracks, and the per-scene clips).
 * @param sectionMap the user's ordered section list (name, scene, bars, optional color).
 * @param timeSig the fallback time signature, used for any section whose scene does
 *   not report one (callers default this to 4/4 per 03_EXTENSIONS_SPEC §4(d)).
 * @returns the {@link Placement}s to write and the section-boundary cue points.
 */
export function planArrangement(
  session: SessionDTO,
  sectionMap: readonly Section[],
  timeSig: TimeSig,
): PlanResult {
  const placements: Placement[] = [];
  const cuePoints: { beat: number; name: string }[] = [];

  let startBeat = 0;
  for (const section of sectionMap) {
    const sig = sectionTimeSig(section, session, timeSig);
    const sectionBeats = section.bars * beatsPerBar(sig);

    // One cue point per section, at its start boundary, named after the section.
    cuePoints.push({ beat: startBeat, name: section.name });

    // One placement per track that has a clip in the mapped scene. The clip spans the
    // whole section (durationBeats = sectionBeats), is named after its source clip,
    // and takes the section color override when present, else the source clip color.
    for (const clip of clipsInScene(session, section.sceneIndex)) {
      const placement: Placement = {
        trackIndex: clip.trackIndex,
        startBeat,
        durationBeats: sectionBeats,
        sourceClipRef: clip.clipRef,
        name: clip.name,
        // Omit `color` only if neither the section nor the clip carries one; here the
        // source clip always has a numeric color, so a color is always present. The
        // section override wins when set (exactOptionalPropertyTypes: no undefined key).
        color: section.color ?? clip.color,
      };
      placements.push(placement);
    }

    startBeat += sectionBeats;
  }

  return { placements, cuePoints };
}
