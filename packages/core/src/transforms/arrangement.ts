/** Pure planning and note geometry for Session-to-Song. */

import type {
  NoteDTO,
  PlanResult,
  Placement,
  ResolvedSection,
  SessionClipDTO,
  SessionDTO,
  TimeSig,
} from '../dtos.js';

export function beatsPerBar(sig: TimeSig): number {
  return sig.num * (4 / sig.den);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validSectionBeats(section: ResolvedSection, sig: TimeSig, startBeat: number): number {
  if (!isFinitePositive(section.bars)) {
    throw new RangeError('A Session-to-Song section must have a finite positive bar count.');
  }
  if (!isFinitePositive(sig.num) || !isFinitePositive(sig.den)) {
    throw new RangeError(
      'A Session-to-Song time signature must have finite positive numerator and denominator.',
    );
  }
  const sectionBeats = section.bars * beatsPerBar(sig);
  if (!isFinitePositive(sectionBeats) || !Number.isFinite(startBeat) || startBeat < 0) {
    throw new RangeError('A Session-to-Song section must produce a finite positive beat range.');
  }
  return sectionBeats;
}

function sectionTimeSig(section: ResolvedSection, session: SessionDTO, fallback: TimeSig): TimeSig {
  return session.scenes[section.sceneIndex]?.timeSig ?? fallback;
}

function clipsInScene(session: SessionDTO, sceneIndex: number): readonly SessionClipDTO[] {
  return session.clips
    .filter((clip) => clip.sceneIndex === sceneIndex)
    .slice()
    .sort((left, right) => left.trackIndex - right.trackIndex);
}

/**
 * Expand a Session clip into physical Arrangement clips. A non-looping source is
 * never stretched; a looping source repeats its loop window and the final instance
 * is cropped to the section boundary.
 */
function placementsForClip(
  clip: SessionClipDTO,
  sectionStart: number,
  sectionBeats: number,
  color: number,
): readonly Placement[] {
  if (!clip.looping) {
    const durationBeats = Math.min(clip.durationBeats, sectionBeats);
    return durationBeats > 0
      ? [
          {
            trackIndex: clip.trackIndex,
            startBeat: sectionStart,
            durationBeats,
            sourceStartBeat: 0,
            sourceClipRef: clip.clipRef,
            name: clip.name,
            color,
          },
        ]
      : [];
  }

  const loopLength = clip.loopEnd - clip.loopStart;
  if (!(loopLength > 0) || !Number.isFinite(loopLength)) {
    throw new RangeError('A looping Session clip must have a positive finite loop window.');
  }

  const result: Placement[] = [];
  for (let offset = 0; offset < sectionBeats; offset += loopLength) {
    result.push({
      trackIndex: clip.trackIndex,
      startBeat: sectionStart + offset,
      durationBeats: Math.min(loopLength, sectionBeats - offset),
      sourceStartBeat: clip.loopStart,
      sourceClipRef: clip.clipRef,
      name: clip.name,
      color,
    });
  }
  return result;
}

/**
 * Crop source notes to a placement's source window and translate them to the new
 * clip's local zero. Notes crossing either boundary retain their audible portion.
 */
export function cropMidiNotesForPlacement(
  notes: readonly NoteDTO[],
  sourceStartBeat: number,
  durationBeats: number,
): readonly NoteDTO[] {
  const sourceEndBeat = sourceStartBeat + durationBeats;
  return notes.flatMap((note) => {
    const noteStart = Math.max(note.startTime, sourceStartBeat);
    const noteEnd = Math.min(note.startTime + note.duration, sourceEndBeat);
    if (!(noteEnd > noteStart)) return [];
    return [
      {
        ...note,
        startTime: noteStart - sourceStartBeat,
        duration: noteEnd - noteStart,
      },
    ];
  });
}

export function planArrangement(
  session: SessionDTO,
  sectionMap: readonly ResolvedSection[],
  timeSig: TimeSig,
): PlanResult {
  const placements: Placement[] = [];
  const cuePoints: { beat: number; name: string }[] = [];

  let startBeat = 0;
  for (const section of sectionMap) {
    const sectionBeats = validSectionBeats(
      section,
      sectionTimeSig(section, session, timeSig),
      startBeat,
    );
    cuePoints.push({ beat: startBeat, name: section.name });

    for (const clip of clipsInScene(session, section.sceneIndex)) {
      placements.push(
        ...placementsForClip(clip, startBeat, sectionBeats, section.color ?? clip.color),
      );
    }
    startBeat += sectionBeats;
    if (!Number.isFinite(startBeat)) {
      throw new RangeError('Session-to-Song section boundaries must remain finite.');
    }
  }

  return { placements, cuePoints };
}
