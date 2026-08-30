/**
 * In-memory {@link LiveBridge} that reproduces the documented SDK contract without
 * Ableton Live. It is the seam that lets the whole tool layer (and the playground)
 * run on CI with no Live install.
 *
 * Faithful to API_REFERENCE.md:
 *  - most getters are synchronous and return cloned snapshots; `listDeviceParams` and
 *    `getTrackMixer` are async reads (the real value comes from the one async getter,
 *    `DeviceParameter.getValue()`) yet still bypass the transaction counter / undo,
 *  - mutators are async (return resolved Promises),
 *  - MIDI notes use read-map-assign: a read clones, a write replaces wholesale,
 *  - pitch and velocity are clamped to 0..127 on write (Live rejects out-of-range),
 *  - referencing a deleted or unknown id throws `STALE_REFERENCE` (or `WRONG_TYPE`
 *    when the id resolves to the wrong object kind),
 *  - `insertDevice` rejects an unknown built-in device name (`SDK_REJECTED`),
 *  - `renderTrack` renders an audio track only and returns a deterministic temp path,
 *  - `transaction` groups mutations into one undo step: the callback must be
 *    synchronous (it may return `Promise.all([...])`), and any rejection rolls the
 *    whole group back so one call stays one undo.
 *
 * Beyond fidelity, the fake records how many undoable steps it has committed so the
 * integration suite can assert the headline correctness claim: one tool call = one
 * transaction = one undo. See {@link FakeLiveBridge.transactionCount}.
 *
 * The internal model is a plain mutable object graph. The fake never exposes those
 * objects; every read returns a fresh DTO so callers cannot mutate state behind the
 * fake's back (matching the SDK, where you must assign an array back to change it).
 */

import type {
  ArrangementClipInfo,
  ClipInfo,
  ClipLocation,
  CreateAudioClipArgs,
  CuePointInfo,
  DeviceInfo,
  DeviceParamInfo,
  MixerInfo,
  NoteDTO,
  RenderResult,
  SceneInfo,
  SetNotesResult,
  SessionClipInfo,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackMatch,
  TrackMixerInfo,
  TrackPropsPatch,
} from './dtos.js';
import { badInput, sdkRejected, staleReference, wrongType } from './errors.js';
import type { ClipId, ClipSlotId, ParamId, TrackId } from './ids.js';
import type { LiveBridge } from './live-bridge.js';
import {
  SessionReferenceRegistry,
  type SessionReference,
  type SessionReferenceKind,
} from './references.js';
import { clampPitch, clampVelocity } from './transforms/notes.js';

// --- internal mutable model (never leaks out of this file) ---

interface NoteModel {
  pitch: number;
  startTime: number;
  duration: number;
  velocity?: number;
  muted?: boolean;
  probability?: number;
  velocityDeviation?: number;
  releaseVelocity?: number;
  selected?: boolean;
}

interface IdentityModel {
  /** Private monotonic identity, preserved through fake transaction snapshots. */
  identity?: number;
}

interface ClipModel extends IdentityModel {
  isMidi: boolean;
  name: string;
  startTime: number;
  duration: number;
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  /**
   * Clip content end marker (beats). Defaults to the clip length; the Set Janitor
   * loop-overrun rule compares it against `loopEnd`. The SDK exposes `endMarker` as a
   * read-only getter, so the fake only reads it.
   */
  endMarker: number;
  color: number;
  muted: boolean;
  /** Present only for MIDI clips. */
  notes: NoteModel[];
  /** Absolute source file path; present only for audio clips. */
  filePath?: string;
}

interface ClipSlotModel extends IdentityModel {
  clip: ClipModel | null;
}

interface ParamModel extends IdentityModel {
  name: string;
  min: number;
  max: number;
  isQuantized: boolean;
  defaultValue: number;
  value: number;
}

interface DeviceModel extends IdentityModel {
  name: string;
  parameters: ParamModel[];
}

/**
 * A track's mixer. `volume` is a full {@link ParamModel} (mirroring
 * `TrackMixer.volume`, a `DeviceParameter`) so it can be resolved by reference and
 * written through {@link FakeLiveBridge.setParam}: a write through the parameter's
 * opaque reference
 * persists because it mutates this stored object, not a throwaway. `panning` /
 * `sendCount` stay minimal scalars (no method addresses them yet).
 */
interface MixerModel {
  volume: ParamModel;
  panning: number;
  sendCount: number;
}

interface TrackModel extends IdentityModel {
  kind: TrackKind;
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  clipSlots: ClipSlotModel[];
  arrangementClips: ClipModel[];
  devices: DeviceModel[];
  mixer: MixerModel;
}

interface SceneModel extends IdentityModel {
  name: string;
  /** Scene tempo, or null when the scene does not override the Set tempo. */
  tempo: number | null;
  signatureNumerator: number;
  signatureDenominator: number;
}

interface CuePointModel extends IdentityModel {
  /** Position in beats. */
  time: number;
  name: string;
}

interface SongModel {
  tempo: number;
  rootNote: number;
  scaleName: string;
  scaleMode: boolean;
  scaleIntervals: number[];
  gridQuantization: string;
  gridIsTriplet: boolean;
  tracks: TrackModel[];
  returnTrackCount: number;
  /** Real scene objects; `sceneCount` is derived from this array's length. */
  scenes: SceneModel[];
  /** Real cue-point objects; `cuePointCount` is derived from this array's length. */
  cuePoints: CuePointModel[];
}

type LocatedClip =
  | {
      readonly location: 'session';
      readonly trackIndex: number;
      readonly track: TrackModel;
      readonly slotIndex: number;
      readonly slot: ClipSlotModel;
      readonly clip: ClipModel;
    }
  | {
      readonly location: 'arrangement';
      readonly trackIndex: number;
      readonly track: TrackModel;
      readonly clipIndex: number;
      readonly clip: ClipModel;
    };

/**
 * The built-in Live device names the fake accepts for {@link FakeLiveBridge.insertDevice}.
 * A small but representative slice; an unknown name is rejected as `SDK_REJECTED`,
 * the way the host rejects a name it does not recognise. Each accepted device is
 * modeled with one stand-in parameter so `setParam` has something to address.
 */
const KNOWN_BUILTIN_DEVICES: ReadonlyMap<string, () => ParamModel[]> = new Map([
  ['Reverb', () => [makeParam('Dry/Wet', 0, 1, 0.5)]],
  ['EQ Eight', () => [makeParam('1 Frequency A', 20, 20000, 1000)]],
  ['Auto Filter', () => [makeParam('Frequency', 20, 20000, 1200)]],
  ['Compressor', () => [makeParam('Threshold', -60, 0, -12)]],
  ['Delay', () => [makeParam('Dry/Wet', 0, 1, 0.35)]],
  ['Utility', () => [makeParam('Gain', -35, 35, 0)]],
]);

function makeParam(
  name: string,
  min: number,
  max: number,
  value: number,
  isQuantized = false,
): ParamModel {
  return { name, min, max, isQuantized, defaultValue: value, value };
}

/**
 * Build a {@link MixerModel} with the volume modeled as a `DeviceParameter`-style
 * {@link ParamModel}. Its internal range is `0..1` with unity (`defaultValue`) at
 * `0.85`, matching the unity value the seeds already used when `volume` was a bare
 * number, so existing levels stay coherent. `value` defaults to that unity point.
 */
function makeMixer(volume = 0.85, panning = 0.5, sendCount = 0): MixerModel {
  return {
    volume: {
      name: 'Volume',
      min: 0,
      max: 1,
      isQuantized: false,
      defaultValue: 0.85,
      value: volume,
    },
    panning,
    sendCount,
  };
}

/** Build a looping MIDI {@link ClipModel} for a Session slot (loopEnd = endMarker = length). */
function midiLoop(
  name: string,
  lengthBeats: number,
  color: number,
  notes: readonly NoteModel[],
): ClipModel {
  return {
    isMidi: true,
    name,
    startTime: 0,
    duration: lengthBeats,
    looping: true,
    loopStart: 0,
    loopEnd: lengthBeats,
    endMarker: lengthBeats,
    color,
    muted: false,
    notes: notes.map((n) => ({ ...n })),
  };
}

/** Build a looping audio {@link ClipModel} for a Session slot, referenced by file. */
function audioLoop(name: string, lengthBeats: number, color: number, filePath: string): ClipModel {
  return {
    isMidi: false,
    name,
    startTime: 0,
    duration: lengthBeats,
    looping: true,
    loopStart: 0,
    loopEnd: lengthBeats,
    endMarker: lengthBeats,
    color,
    muted: false,
    notes: [],
    filePath,
  };
}

/** Deep clone of the whole song, used for transaction snapshots / rollback. */
function cloneSong(song: SongModel): SongModel {
  return structuredClone(song);
}

/** Build a NoteModel from an incoming DTO, clamping pitch/velocity and dropping absent keys. */
function noteFromDTO(dto: NoteDTO): NoteModel {
  const model: NoteModel = {
    pitch: clampPitch(dto.pitch),
    startTime: dto.startTime,
    duration: dto.duration,
  };
  if (dto.velocity !== undefined) model.velocity = clampVelocity(dto.velocity);
  if (dto.muted !== undefined) model.muted = dto.muted;
  if (dto.probability !== undefined) model.probability = dto.probability;
  if (dto.velocityDeviation !== undefined) model.velocityDeviation = dto.velocityDeviation;
  if (dto.releaseVelocity !== undefined) model.releaseVelocity = clampVelocity(dto.releaseVelocity);
  if (dto.selected !== undefined) model.selected = dto.selected;
  return model;
}

/**
 * Build a NoteDTO from the model, dropping absent optional keys so the result
 * matches `exactOptionalPropertyTypes` (a missing key, never `key: undefined`).
 */
function noteToDTO(note: NoteModel): NoteDTO {
  const out: {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
    muted?: boolean;
    probability?: number;
    velocityDeviation?: number;
    releaseVelocity?: number;
    selected?: boolean;
  } = { pitch: note.pitch, startTime: note.startTime, duration: note.duration };
  if (note.velocity !== undefined) out.velocity = note.velocity;
  if (note.muted !== undefined) out.muted = note.muted;
  if (note.probability !== undefined) out.probability = note.probability;
  if (note.velocityDeviation !== undefined) out.velocityDeviation = note.velocityDeviation;
  if (note.releaseVelocity !== undefined) out.releaseVelocity = note.releaseVelocity;
  if (note.selected !== undefined) out.selected = note.selected;
  return out;
}

export class FakeLiveBridge implements LiveBridge {
  #song: SongModel;
  /** Private monotonic identities prevent an opaque ref from silently retargeting. */
  #nextIdentity = 1;
  readonly #references: SessionReferenceRegistry<{ readonly identity: number }>;
  readonly #referenceByIdentity = new Map<string, SessionReference>();
  /** Non-null while a transaction is in flight; holds the pre-transaction snapshot. */
  #transactionSnapshot: SongModel | null = null;
  /**
   * Nesting depth of {@link FakeLiveBridge.transaction}. While > 0, a single mutation
   * does NOT open its own undo step (it collapses into the surrounding transaction),
   * mirroring the SDK's "nested transactions collapse into the outermost one".
   */
  #txDepth = 0;
  /** Count of committed undoable steps (one per standalone mutation or per transaction). */
  #undoSteps = 0;

  constructor(song?: SongModel, options?: { readonly referenceCapacity?: number }) {
    this.#song = song ?? FakeLiveBridge.#seedModel();
    this.#references = new SessionReferenceRegistry<{ readonly identity: number }>({
      maxEntries: options?.referenceCapacity ?? 4096,
    });
    this.#hydrateIdentities();
  }

  /**
   * A small, realistic Set for tests and demos: two MIDI tracks and one audio
   * track, a couple of Session clips, one Arrangement clip, and a C-minor scale.
   */
  static seeded(): FakeLiveBridge {
    return new FakeLiveBridge(FakeLiveBridge.#seedModel());
  }

  /**
   * A Set with a single MIDI track holding one Session MIDI clip whose notes are
   * `notes`. The clip is exposed through {@link FakeLiveBridge.firstClipId}.
   * Tempo 120, C-major scale. The headline integration fixture.
   */
  static withOneMidiClip(notes: readonly NoteDTO[]): FakeLiveBridge {
    const clip: ClipModel = {
      isMidi: true,
      name: 'Clip',
      startTime: 0,
      duration: 4,
      looping: true,
      loopStart: 0,
      loopEnd: 4,
      endMarker: 4,
      color: 0,
      muted: false,
      notes: notes.map(noteFromDTO),
    };
    const song: SongModel = {
      tempo: 120,
      rootNote: 0,
      scaleName: 'Major',
      scaleMode: true,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      gridQuantization: '1/16',
      gridIsTriplet: false,
      tracks: [
        {
          kind: 'midi',
          name: 'MIDI',
          mute: false,
          solo: false,
          arm: false,
          clipSlots: [{ clip }, { clip: null }],
          arrangementClips: [],
          devices: [],
          mixer: makeMixer(0.85, 0.5, 0),
        },
      ],
      returnTrackCount: 0,
      scenes: [{ name: 'Scene 1', tempo: null, signatureNumerator: 4, signatureDenominator: 4 }],
      cuePoints: [],
    };
    return new FakeLiveBridge(song);
  }

  /**
   * A Session-to-Song fixture: three scenes (`Intro` / `Verse` / `Chorus`) and
   * two tracks (one MIDI, one audio) whose clip slots are populated per scene, so a
   * scene index maps to a clip-slot index. The MIDI clips carry notes; the audio
   * clips carry a `filePath`. No Arrangement clips yet (the build writes them). Use
   * this to drive `planArrangement` + the recreate-into-Arrangement handler:
   *  - track 0 `Keys` (midi): clips in scenes 0 + 1 + 2,
   *  - track 1 `Drums` (audio): clips in scenes 1 + 2 (scene 0 slot is empty, so the
   *    planner emits no placement for `Drums` in the Intro).
   */
  static seededSession(): FakeLiveBridge {
    return new FakeLiveBridge(FakeLiveBridge.#seedSessionModel());
  }

  /**
   * A Set Janitor fixture: a deliberately messy Set so `detectIssues` has every
   * issue kind to find and the handler has rename / recolor / delete fixes to apply.
   *  - track 0 `Bass` (midi): a real clip, off-palette color, plus a clip whose
   *    `endMarker` overruns its `loopEnd` (loop-overrun issue),
   *  - track 1 `1-MIDI` (midi): a placeholder track name and an unnamed clip
   *    `"Audio 3"` (placeholder-name issues),
   *  - track 2 `Empty` (audio): no clips, no devices (empty-track issue).
   *
   * The palette the off-palette rule checks is the stage-2 transform's business; the
   * fixture just plants a clearly non-standard color (`12345`) and standard ones so a
   * rule can tell them apart.
   */
  static seededMessySet(): FakeLiveBridge {
    return new FakeLiveBridge(FakeLiveBridge.#seedMessyModel());
  }

  /**
   * A focused Gain Stage Doctor fixture: a single audio track `Gtr` with a known
   * mixer volume (`0.6`, below the `0.85` unity) and one audio Arrangement clip, so a
   * test can read {@link FakeLiveBridge.getTrackMixer}, compute a trim, and write it
   * back through {@link FakeLiveBridge.setParam} using its opaque parameter ref. (The
   * broader {@link FakeLiveBridge.seeded} Set also has an audio track with a mixer;
   * this one isolates the mixer round-trip.)
   */
  static seededAudioTrack(): FakeLiveBridge {
    const clip: ClipModel = {
      isMidi: false,
      name: 'Gtr Take',
      startTime: 0,
      duration: 8,
      looping: false,
      loopStart: 0,
      loopEnd: 8,
      endMarker: 8,
      color: 8421504,
      muted: false,
      notes: [],
      filePath: '/audio/gtr.wav',
    };
    const song: SongModel = {
      tempo: 120,
      rootNote: 0,
      scaleName: 'Major',
      scaleMode: false,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      gridQuantization: '1/16',
      gridIsTriplet: false,
      tracks: [
        {
          kind: 'audio',
          name: 'Gtr',
          mute: false,
          solo: false,
          arm: false,
          clipSlots: [{ clip: null }],
          arrangementClips: [clip],
          devices: [],
          mixer: makeMixer(0.6, 0.5, 2),
        },
      ],
      returnTrackCount: 2,
      scenes: [{ name: 'Scene 1', tempo: null, signatureNumerator: 4, signatureDenominator: 4 }],
      cuePoints: [],
    };
    return new FakeLiveBridge(song);
  }

  /** Opaque reference of the first fixture track's mixer-volume parameter. */
  get firstMixerVolumeId(): ParamId {
    const track = this.#song.tracks[0];
    if (track === undefined) throw staleReference('fixture:firstMixerVolume');
    return this.#referenceFor('parameter', track.mixer.volume);
  }

  /**
   * The id of the first Session clip in the {@link FakeLiveBridge.withOneMidiClip}
   * fixture. An instance accessor so the integration suite can
   * write `live.firstClipId` (as the 02_BRIDGE_SPEC §8 sketch does), without
   * rebuilding the id.
   */
  get firstClipId(): ClipId {
    const slot = this.#song.tracks[0]?.clipSlots[0];
    if (slot?.clip === null || slot?.clip === undefined) throw staleReference('fixture:firstClip');
    return this.#referenceFor('clip', slot.clip);
  }

  /**
   * The id of the first Session clip slot in the {@link FakeLiveBridge.withOneMidiClip}
   * fixture. The second slot is empty.
   * An instance accessor, paired with {@link FakeLiveBridge.firstClipId}.
   */
  get firstSlotId(): ClipSlotId {
    const slot = this.#song.tracks[0]?.clipSlots[0];
    if (slot === undefined) throw staleReference('fixture:firstSlot');
    return this.#referenceFor('clip-slot', slot);
  }

  /**
   * Read the notes of {@link FakeLiveBridge.firstClipId} as DTOs. A convenience for
   * tests that assert on the first clip's state after a write.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` if the first clip is not a
   *   resolvable MIDI clip (i.e. this fake was not built with `withOneMidiClip`).
   */
  firstClip(): { readonly id: ClipId; readonly notes: readonly NoteDTO[] } {
    return { id: this.firstClipId, notes: this.getNotes(this.firstClipId) };
  }

  /**
   * The number of undoable steps committed so far: one per standalone mutation and
   * one per {@link FakeLiveBridge.transaction} call (its grouped mutations collapse
   * into that single step). This lets integration tests assert "one tool
   * call = one transaction = one undo": snapshot it before a tool call and expect it
   * to grow by exactly one after.
   */
  get transactionCount(): number {
    return this.#undoSteps;
  }

  static #seedModel(): SongModel {
    const drums: TrackModel = {
      kind: 'midi',
      name: 'Drums',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [
        {
          clip: {
            isMidi: true,
            name: 'Beat',
            startTime: 0,
            duration: 4,
            looping: true,
            loopStart: 0,
            loopEnd: 4,
            endMarker: 4,
            color: 16711680,
            muted: false,
            notes: [
              { pitch: 36, startTime: 0, duration: 0.25, velocity: 100 },
              { pitch: 38, startTime: 1, duration: 0.25, velocity: 90 },
              { pitch: 36, startTime: 2, duration: 0.25, velocity: 100 },
              { pitch: 38, startTime: 3, duration: 0.25, velocity: 90 },
            ],
          },
        },
        { clip: null },
      ],
      arrangementClips: [],
      devices: [{ name: 'Drum Rack', parameters: [makeParam('Macro 1', 0, 127, 0)] }],
      mixer: makeMixer(0.85, 0.5, 2),
    };
    const bass: TrackModel = {
      kind: 'midi',
      name: 'Bass',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [
        {
          clip: {
            isMidi: true,
            name: 'Bassline',
            startTime: 0,
            duration: 4,
            looping: true,
            loopStart: 0,
            loopEnd: 4,
            endMarker: 4,
            color: 255,
            muted: false,
            notes: [
              { pitch: 36, startTime: 0, duration: 1, velocity: 110 },
              { pitch: 43, startTime: 2, duration: 1, velocity: 105 },
            ],
          },
        },
      ],
      arrangementClips: [
        {
          isMidi: true,
          name: 'Bass (arr)',
          startTime: 0,
          duration: 8,
          looping: false,
          loopStart: 0,
          loopEnd: 8,
          endMarker: 8,
          color: 255,
          muted: false,
          notes: [{ pitch: 36, startTime: 0, duration: 4, velocity: 100 }],
        },
      ],
      devices: [],
      mixer: makeMixer(0.8, 0.5, 2),
    };
    const vocals: TrackModel = {
      kind: 'audio',
      name: 'Vocals',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [{ clip: null }],
      // One AUDIO arrangement clip so the WRONG_TYPE branch of
      // getNotes / setNotes (a non-MIDI clip) is exercisable.
      arrangementClips: [
        {
          isMidi: false,
          name: 'Vox Take',
          startTime: 0,
          duration: 8,
          looping: false,
          loopStart: 0,
          loopEnd: 8,
          endMarker: 8,
          color: 16777215,
          muted: false,
          notes: [],
          filePath: '/audio/vox_take.wav',
        },
      ],
      devices: [
        { name: 'EQ Eight', parameters: [makeParam('1 Frequency A', 20, 20000, 1000)] },
        { name: 'Compressor', parameters: [makeParam('Threshold', -60, 0, -12)] },
      ],
      mixer: makeMixer(0.9, 0.5, 2),
    };
    return {
      tempo: 124,
      rootNote: 0,
      scaleName: 'Minor',
      scaleMode: true,
      scaleIntervals: [0, 2, 3, 5, 7, 8, 10],
      gridQuantization: '1/16',
      gridIsTriplet: false,
      tracks: [drums, bass, vocals],
      returnTrackCount: 2,
      scenes: [
        { name: 'Verse', tempo: null, signatureNumerator: 4, signatureDenominator: 4 },
        { name: 'Chorus', tempo: null, signatureNumerator: 4, signatureDenominator: 4 },
      ],
      cuePoints: [],
    };
  }

  /** Backs {@link FakeLiveBridge.seededSession}; see that method's doc for the layout. */
  static #seedSessionModel(): SongModel {
    const keys: TrackModel = {
      kind: 'midi',
      name: 'Keys',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [
        { clip: midiLoop('Intro Keys', 4, 8421504, [{ pitch: 60, startTime: 0, duration: 4 }]) },
        { clip: midiLoop('Verse Keys', 4, 8421504, [{ pitch: 62, startTime: 0, duration: 2 }]) },
        { clip: midiLoop('Chorus Keys', 4, 8421504, [{ pitch: 64, startTime: 0, duration: 1 }]) },
      ],
      arrangementClips: [],
      devices: [],
      mixer: makeMixer(0.85, 0.5, 0),
    };
    const drums: TrackModel = {
      kind: 'audio',
      name: 'Drums',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [
        // Scene 0 (Intro) is empty for Drums: the planner emits no Drums placement there.
        { clip: null },
        { clip: audioLoop('Verse Beat', 4, 255, '/audio/verse_beat.wav') },
        { clip: audioLoop('Chorus Beat', 4, 255, '/audio/chorus_beat.wav') },
      ],
      arrangementClips: [],
      devices: [],
      mixer: makeMixer(0.85, 0.5, 0),
    };
    return {
      tempo: 120,
      rootNote: 0,
      scaleName: 'Major',
      scaleMode: true,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      gridQuantization: '1/16',
      gridIsTriplet: false,
      tracks: [keys, drums],
      returnTrackCount: 0,
      scenes: [
        { name: 'Intro', tempo: null, signatureNumerator: 4, signatureDenominator: 4 },
        { name: 'Verse', tempo: null, signatureNumerator: 4, signatureDenominator: 4 },
        { name: 'Chorus', tempo: null, signatureNumerator: 4, signatureDenominator: 4 },
      ],
      cuePoints: [],
    };
  }

  /** Backs {@link FakeLiveBridge.seededMessySet}; see that method's doc for the layout. */
  static #seedMessyModel(): SongModel {
    // A clip whose content end marker overruns its loop end (loop-overrun issue).
    const overrun: ClipModel = {
      isMidi: true,
      name: 'Loop',
      startTime: 0,
      duration: 4,
      looping: true,
      loopStart: 0,
      loopEnd: 4,
      endMarker: 6,
      color: 255,
      muted: false,
      notes: [{ pitch: 36, startTime: 0, duration: 1, velocity: 100 }],
    };
    const bass: TrackModel = {
      kind: 'midi',
      name: 'Bass',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [
        // Off-palette color (12345 is not a standard Live clip color).
        { clip: midiLoop('Bassline', 4, 12345, [{ pitch: 36, startTime: 0, duration: 1 }]) },
        { clip: overrun },
      ],
      arrangementClips: [],
      devices: [{ name: 'Operator', parameters: [makeParam('Volume', 0, 1, 0.7)] }],
      mixer: makeMixer(0.85, 0.5, 0),
    };
    const placeholder: TrackModel = {
      kind: 'midi',
      // Placeholder track name (Live's default-style "<n>-MIDI").
      name: '1-MIDI',
      mute: false,
      solo: false,
      arm: false,
      // Placeholder clip name ("Audio 3"-style default).
      clipSlots: [{ clip: midiLoop('Audio 3', 4, 16711680, []) }],
      arrangementClips: [],
      devices: [],
      mixer: makeMixer(0.85, 0.5, 0),
    };
    const empty: TrackModel = {
      kind: 'audio',
      // Empty track: no clips, no devices.
      name: 'Empty',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [{ clip: null }],
      arrangementClips: [],
      devices: [],
      mixer: makeMixer(0.85, 0.5, 0),
    };
    return {
      tempo: 128,
      rootNote: 0,
      scaleName: 'Minor',
      scaleMode: true,
      scaleIntervals: [0, 2, 3, 5, 7, 8, 10],
      gridQuantization: '1/16',
      gridIsTriplet: false,
      tracks: [bass, placeholder, empty],
      returnTrackCount: 0,
      scenes: [{ name: 'Scene 1', tempo: null, signatureNumerator: 4, signatureDenominator: 4 }],
      cuePoints: [],
    };
  }

  // --- resolution helpers (throw STALE_REFERENCE / WRONG_TYPE like the SDK) ---

  #resolveTrack(id: TrackId): { index: number; track: TrackModel } {
    return this.#resolveReference(id, 'track', (identity) => this.#findTrack(identity), 'track');
  }

  /** Resolve any clip id (session or arrangement) to its mutable model. */
  #resolveClip(id: ClipId): ClipModel {
    return this.#resolveClipLocation(id).clip;
  }

  /**
   * Resolve any clip id to its model PLUS its `location` and (for Session clips) its
   * `slotId`, so {@link FakeLiveBridge.setClipProps} can rebuild the post-write
   * {@link ClipInfo} with the same shape {@link FakeLiveBridge.listClips} produces.
   */
  #resolveClipWithLocation(id: ClipId): {
    clip: ClipModel;
    location: ClipLocation;
    slotId?: ClipSlotId;
    sceneIndex?: number;
  } {
    const located = this.#resolveClipLocation(id);
    if (located.location === 'session') {
      return {
        clip: located.clip,
        location: located.location,
        slotId: this.#referenceFor('clip-slot', located.slot),
        sceneIndex: located.slotIndex,
      };
    }
    return { clip: located.clip, location: located.location };
  }

  /**
   * Resolve a clip id to its CONTAINER for deletion. A Session clip
   * resolves to its slot (deletion nulls the slot, which
   * remains and then reports empty, mirroring `ClipSlot.deleteClip()`); an
   * Arrangement clip resolves to the track's `arrangementClips`
   * array + index (deletion splices it, mirroring `Track.deleteClip(clip)`). Unlike
   * {@link FakeLiveBridge.#resolveClip}, this hands back the container so the delete
   * can detach the clip rather than just read it.
   */
  #resolveClipForDelete(
    id: ClipId,
  ):
    | { readonly kind: 'session'; readonly slot: ClipSlotModel }
    | { readonly kind: 'arrangement'; readonly clips: ClipModel[]; readonly index: number } {
    const located = this.#resolveClipLocation(id);
    if (located.location === 'session') return { kind: 'session', slot: located.slot };
    return { kind: 'arrangement', clips: located.track.arrangementClips, index: located.clipIndex };
  }

  /** Resolve a clip-slot reference to its mutable model + indices. */
  #resolveSlot(id: ClipSlotId): { trackIndex: number; slotIndex: number; slot: ClipSlotModel } {
    return this.#resolveReference(
      id,
      'clip-slot',
      (identity) => this.#findSlot(identity),
      'clip slot',
    );
  }

  /**
   * Resolve a parameter reference to its mutable {@link ParamModel}. It can address
   * a device-chain parameter or a mixer volume. The model is returned BY REFERENCE so a follow-up
   * {@link FakeLiveBridge.setParam} that assigns `param.value` persists.
   */
  #resolveParam(id: ParamId): { param: ParamModel } {
    return this.#resolveReference(
      id,
      'parameter',
      (identity) => this.#findParam(identity),
      'device parameter',
    );
  }

  #resolveClipLocation(id: ClipId): LocatedClip {
    return this.#resolveReference(id, 'clip', (identity) => this.#findClip(identity), 'clip');
  }

  #resolveReference<T, K extends SessionReferenceKind>(
    reference: string,
    kind: K,
    find: (identity: number) => T | null,
    expected: string,
  ): T {
    const lookup = this.#references.resolve(reference, kind);
    if (lookup.status === 'wrong-kind') throw wrongType(reference, expected);
    if (lookup.status !== 'found') throw staleReference(reference);
    this.#rememberReference(kind, lookup.value.identity, lookup.reference);
    const located = find(lookup.value.identity);
    if (located === null) throw staleReference(reference);
    return located;
  }

  #referenceFor<K extends SessionReferenceKind>(
    kind: K,
    model: IdentityModel,
  ): SessionReference<K> {
    const identity = this.#identity(model);
    const key = `${kind}:${String(identity)}`;
    const existing = this.#referenceByIdentity.get(key);
    if (existing !== undefined && this.#references.resolve(existing, kind).status === 'found') {
      this.#rememberReference(kind, identity, existing as SessionReference<K>);
      return existing as SessionReference<K>;
    }
    this.#referenceByIdentity.delete(key);
    const reference = this.#references.issue(kind, { identity });
    this.#rememberReference(kind, identity, reference);
    return reference;
  }

  /** Keep this dedupe LRU in lockstep with every registry issue and successful resolve. */
  #rememberReference<K extends SessionReferenceKind>(
    kind: K,
    identity: number,
    reference: SessionReference<K>,
  ): void {
    const key = `${kind}:${String(identity)}`;
    this.#referenceByIdentity.delete(key);
    this.#referenceByIdentity.set(key, reference);
    while (this.#referenceByIdentity.size > this.#references.maxEntries) {
      const oldest = this.#referenceByIdentity.keys().next().value;
      if (oldest === undefined) break;
      this.#referenceByIdentity.delete(oldest);
    }
  }

  #identity(model: IdentityModel): number {
    if (model.identity === undefined) {
      model.identity = this.#nextIdentity++;
    } else if (model.identity >= this.#nextIdentity) {
      this.#nextIdentity = model.identity + 1;
    }
    return model.identity;
  }

  #hydrateIdentities(): void {
    for (const track of this.#song.tracks) {
      this.#identity(track);
      this.#identity(track.mixer.volume);
      for (const slot of track.clipSlots) {
        this.#identity(slot);
        if (slot.clip !== null) this.#identity(slot.clip);
      }
      for (const clip of track.arrangementClips) this.#identity(clip);
      for (const device of track.devices) {
        this.#identity(device);
        for (const parameter of device.parameters) this.#identity(parameter);
      }
    }
    for (const scene of this.#song.scenes) this.#identity(scene);
    for (const cuePoint of this.#song.cuePoints) this.#identity(cuePoint);
  }

  #findTrack(identity: number): { index: number; track: TrackModel } | null {
    const index = this.#song.tracks.findIndex((track) => track.identity === identity);
    const track = index < 0 ? undefined : this.#song.tracks[index];
    return track === undefined ? null : { index, track };
  }

  #findSlot(
    identity: number,
  ): { trackIndex: number; slotIndex: number; slot: ClipSlotModel } | null {
    for (const [trackIndex, track] of this.#song.tracks.entries()) {
      const slotIndex = track.clipSlots.findIndex((slot) => slot.identity === identity);
      const slot = slotIndex < 0 ? undefined : track.clipSlots[slotIndex];
      if (slot !== undefined) return { trackIndex, slotIndex, slot };
    }
    return null;
  }

  #findClip(identity: number): LocatedClip | null {
    for (const [trackIndex, track] of this.#song.tracks.entries()) {
      for (const [slotIndex, slot] of track.clipSlots.entries()) {
        if (slot.clip?.identity === identity) {
          return { location: 'session', trackIndex, track, slotIndex, slot, clip: slot.clip };
        }
      }
      const clipIndex = track.arrangementClips.findIndex((clip) => clip.identity === identity);
      const clip = clipIndex < 0 ? undefined : track.arrangementClips[clipIndex];
      if (clip !== undefined)
        return { location: 'arrangement', trackIndex, track, clipIndex, clip };
    }
    return null;
  }

  #findParam(identity: number): { param: ParamModel } | null {
    for (const track of this.#song.tracks) {
      if (track.mixer.volume.identity === identity) return { param: track.mixer.volume };
      for (const device of track.devices) {
        const param = device.parameters.find((candidate) => candidate.identity === identity);
        if (param !== undefined) return { param };
      }
    }
    return null;
  }

  // --- reads (synchronous) ---

  getSongOverview(): SongOverview {
    const s = this.#song;
    return {
      tempo: s.tempo,
      rootNote: s.rootNote,
      scaleName: s.scaleName,
      scaleMode: s.scaleMode,
      scaleIntervals: [...s.scaleIntervals],
      gridQuantization: s.gridQuantization,
      gridIsTriplet: s.gridIsTriplet,
      trackCount: s.tracks.length,
      returnTrackCount: s.returnTrackCount,
      sceneCount: s.scenes.length,
      cuePointCount: s.cuePoints.length,
      tracks: s.tracks.map((track) => ({
        id: this.#referenceFor('track', track),
        name: track.name,
        type: track.kind,
      })),
    };
  }

  listTracks(): readonly TrackInfo[] {
    return this.#song.tracks.map((track) => this.#trackInfo(track));
  }

  findTrack(query: string): readonly TrackMatch[] {
    const needle = query.toLowerCase();
    const matches: TrackMatch[] = [];
    this.#song.tracks.forEach((track) => {
      if (track.name.toLowerCase().includes(needle)) {
        matches.push({
          id: this.#referenceFor('track', track),
          name: track.name,
          type: track.kind,
        });
      }
    });
    return matches;
  }

  listClips(id: TrackId): readonly ClipInfo[] {
    const { track } = this.#resolveTrack(id);
    const out: ClipInfo[] = [];
    track.clipSlots.forEach((slot, slotIndex) => {
      if (slot.clip !== null) {
        out.push(this.#clipInfo('session', slot.clip, slot, slotIndex));
      } else {
        out.push(this.#emptySlotInfo(slot, slotIndex));
      }
    });
    track.arrangementClips.forEach((clip) => {
      out.push(this.#clipInfo('arrangement', clip));
    });
    return out;
  }

  getNotes(id: ClipId): readonly NoteDTO[] {
    const clip = this.#resolveClip(id);
    if (!clip.isMidi) {
      throw wrongType(id, 'MIDI clip');
    }
    // Clone on read: the SDK contract is read-array, map, assign-back. noteToDTO
    // builds fresh objects, so a caller cannot mutate fake state without a write.
    return clip.notes.map(noteToDTO);
  }

  // listDeviceParams / getTrackMixer are ASYNC: in the real SDK a parameter's value is
  // read with DeviceParameter.getValue() (the one async getter, 01_SDK_MAP §2). The fake
  // holds the value in memory and could return it synchronously, but it returns a
  // resolved Promise to MATCH the port + the real adapter: an `async` method also turns a
  // #resolveTrack throw into a rejection, exactly as the adapter does. These are pure
  // reads: they do NOT go through #mutate, so they touch neither the transaction counter
  // nor the undo steps.

  async listDeviceParams(id: TrackId): Promise<readonly DeviceParamInfo[]> {
    const { track } = this.#resolveTrack(id);
    const out: DeviceParamInfo[] = [];
    track.devices.forEach((device) => {
      device.parameters.forEach((param) => {
        out.push(this.#paramInfo(param));
      });
    });
    return out;
  }

  listScenes(): readonly SceneInfo[] {
    return this.#song.scenes.map((scene) => this.#sceneInfo(scene));
  }

  async getTrackMixer(id: TrackId): Promise<TrackMixerInfo> {
    const { track } = this.#resolveTrack(id);
    return { volume: this.#paramInfo(track.mixer.volume) };
  }

  // --- mutations (async; each is one undo step unless inside a transaction) ---

  async setTempo(bpm: number): Promise<SongOverview> {
    return this.#mutate(() => {
      if (!Number.isFinite(bpm) || bpm <= 0) {
        throw badInput(`Tempo ${String(bpm)} is not a positive number.`);
      }
      this.#song.tempo = bpm;
      return this.getSongOverview();
    });
  }

  async setTrackProps(id: TrackId, props: TrackPropsPatch): Promise<TrackInfo> {
    return this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (props.name !== undefined) track.name = props.name;
      if (props.mute !== undefined) track.mute = props.mute;
      if (props.solo !== undefined) track.solo = props.solo;
      if (props.arm !== undefined) track.arm = props.arm;
      return this.#trackInfo(track);
    });
  }

  async setNotes(id: ClipId, notes: readonly NoteDTO[]): Promise<SetNotesResult> {
    return this.#mutate(() => {
      const clip = this.#resolveClip(id);
      if (!clip.isMidi) {
        throw wrongType(id, 'MIDI clip');
      }
      // Replace wholesale (assign-back), clamping pitch/velocity like Live does.
      clip.notes = notes.map(noteFromDTO);
      return { id, name: clip.name, count: clip.notes.length };
    });
  }

  async createTrack(kind: TrackKind): Promise<TrackInfo> {
    return this.#mutate(() => {
      const name = kind === 'midi' ? 'MIDI' : 'Audio';
      this.#song.tracks.push(FakeLiveBridge.#emptyTrack(kind, name));
      const track = this.#song.tracks.at(-1);
      if (track === undefined) {
        // Unreachable: we just pushed it. Guards noUncheckedIndexedAccess.
        throw sdkRejected('Track creation did not yield a track.');
      }
      return this.#trackInfo(track);
    });
  }

  async createMidiClip(id: ClipSlotId, lengthBeats: number): Promise<ClipInfo> {
    return this.#mutate(() => {
      const { trackIndex, slotIndex, slot } = this.#resolveSlot(id);
      const track = this.#song.tracks[trackIndex];
      if (track === undefined) {
        throw staleReference(id);
      }
      if (track.kind !== 'midi') {
        throw wrongType(id, 'MIDI track clip slot');
      }
      if (!(lengthBeats > 0)) {
        throw badInput(`Clip length ${String(lengthBeats)} must be > 0.`);
      }
      if (slot.clip !== null) {
        throw sdkRejected(
          `Clip slot "${id}" is already occupied.`,
          'Pick an empty slot or clear it first.',
        );
      }
      const clip: ClipModel = {
        isMidi: true,
        name: 'MIDI Clip',
        startTime: 0,
        duration: lengthBeats,
        looping: true,
        loopStart: 0,
        loopEnd: lengthBeats,
        endMarker: lengthBeats,
        color: 0,
        muted: false,
        notes: [],
      };
      slot.clip = clip;
      return this.#clipInfo('session', clip, slot, slotIndex);
    });
  }

  async setClipProps(id: ClipId, props: { name?: string; color?: number }): Promise<ClipInfo> {
    return this.#mutate(() => {
      const { clip, location, slotId, sceneIndex } = this.#resolveClipWithLocation(id);
      if (props.name !== undefined) clip.name = props.name;
      if (props.color !== undefined) clip.color = props.color;
      if (location === 'session') {
        if (slotId === undefined || sceneIndex === undefined) {
          throw badInput('A resolved Session clip is missing its slot or scene metadata.');
        }
        return this.#clipInfo('session', clip, this.#resolveSlot(slotId).slot, sceneIndex);
      }
      return this.#clipInfo('arrangement', clip);
    });
  }

  async deleteTrack(id: TrackId): Promise<void> {
    return this.#mutate(() => {
      const { index } = this.#resolveTrack(id);
      this.#song.tracks.splice(index, 1);
    });
  }

  async deleteClip(id: ClipId): Promise<void> {
    return this.#mutate(() => {
      const target = this.#resolveClipForDelete(id);
      if (target.kind === 'session') {
        // Empties the slot (the slot remains and then reports empty).
        target.slot.clip = null;
      } else {
        target.clips.splice(target.index, 1);
      }
    });
  }

  async createArrangementMidiClip(
    id: TrackId,
    startBeat: number,
    lengthBeats: number,
  ): Promise<ClipInfo> {
    return this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (track.kind !== 'midi') {
        throw wrongType(id, 'MIDI track');
      }
      if (!(startBeat >= 0) || !Number.isFinite(startBeat)) {
        throw badInput(`startBeat ${String(startBeat)} must be a non-negative number.`);
      }
      if (!(lengthBeats > 0)) {
        throw badInput(`Clip length ${String(lengthBeats)} must be > 0.`);
      }
      const clip: ClipModel = {
        isMidi: true,
        name: 'MIDI Clip',
        startTime: startBeat,
        duration: lengthBeats,
        looping: false,
        loopStart: startBeat,
        loopEnd: startBeat + lengthBeats,
        endMarker: startBeat + lengthBeats,
        color: 0,
        muted: false,
        notes: [],
      };
      track.arrangementClips.push(clip);
      return this.#clipInfo('arrangement', clip);
    });
  }

  async createArrangementAudioClip(id: TrackId, args: CreateAudioClipArgs): Promise<ClipInfo> {
    return this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (track.kind !== 'audio') {
        throw wrongType(id, 'audio track');
      }
      if (args.filePath.length === 0) {
        throw badInput('filePath must be a non-empty absolute path.');
      }
      if (!(args.startTime >= 0) || !Number.isFinite(args.startTime)) {
        throw badInput(`startTime ${String(args.startTime)} must be a non-negative number.`);
      }
      if (!(args.duration > 0)) {
        throw badInput(`duration ${String(args.duration)} must be > 0.`);
      }
      const clip: ClipModel = {
        isMidi: false,
        name: 'Audio Clip',
        startTime: args.startTime,
        duration: args.duration,
        looping: false,
        loopStart: args.startTime,
        loopEnd: args.startTime + args.duration,
        endMarker: args.startTime + args.duration,
        color: 0,
        muted: false,
        notes: [],
        filePath: args.filePath,
      };
      track.arrangementClips.push(clip);
      return this.#clipInfo('arrangement', clip);
    });
  }

  async clearClipsInRange(id: TrackId, startBeat: number, endBeat: number): Promise<void> {
    return this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (!(startBeat >= 0) || !Number.isFinite(startBeat)) {
        throw badInput(`startBeat ${String(startBeat)} must be a non-negative number.`);
      }
      if (!(endBeat > startBeat)) {
        throw badInput(
          `endBeat ${String(endBeat)} must be greater than startBeat ${String(startBeat)}.`,
        );
      }
      // Clips fully inside [startBeat, endBeat) are removed; clips overlapping a
      // boundary are TRUNCATED to the part outside the range (mirroring the SDK's
      // clearClipsInRange, which truncates rather than deletes boundary clips).
      track.arrangementClips = clearRange(track.arrangementClips, startBeat, endBeat);
    });
  }

  async createCuePoint(beat: number, name: string): Promise<CuePointInfo> {
    return this.#mutate(() => {
      if (!Number.isFinite(beat) || beat < 0) {
        throw badInput(`Cue point beat ${String(beat)} must be a non-negative number.`);
      }
      this.#song.cuePoints.push({ time: beat, name });
      // Keep cue points ordered by time, the way Live presents locators; the returned
      // id reflects the post-insert index.
      this.#song.cuePoints.sort((a, b) => a.time - b.time);
      const cuePoint = this.#song.cuePoints.find(
        (candidate) => candidate.time === beat && candidate.name === name,
      );
      if (cuePoint === undefined)
        throw sdkRejected('Cue point creation did not yield a cue point.');
      return this.#cuePointInfo(cuePoint);
    });
  }

  async setParam(id: ParamId, value: number): Promise<DeviceParamInfo> {
    return this.#mutate(() => {
      const { param } = this.#resolveParam(id);
      if (!Number.isFinite(value) || value < param.min || value > param.max) {
        throw badInput(
          `Value ${String(value)} is outside the parameter range ${String(param.min)}..${String(param.max)}.`,
        );
      }
      param.value = value;
      return this.#paramInfo(param);
    });
  }

  async insertDevice(id: TrackId, deviceName: string, index: number): Promise<DeviceInfo> {
    return this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (!Number.isInteger(index) || index < 0) {
        throw badInput(`Device index ${String(index)} must be a non-negative integer.`);
      }
      const makeParams = KNOWN_BUILTIN_DEVICES.get(deviceName);
      if (makeParams === undefined) {
        throw sdkRejected(
          `"${deviceName}" is not a known built-in Live device.`,
          'Use a built-in Live device name (e.g. "Reverb", "EQ Eight"); third-party / VST is not supported.',
        );
      }
      const device: DeviceModel = { name: deviceName, parameters: makeParams() };
      const at = Math.min(index, track.devices.length);
      track.devices.splice(at, 0, device);
      return this.#deviceInfo(device);
    });
  }

  async renderTrack(id: TrackId, startBeat: number, endBeat: number): Promise<RenderResult> {
    // A render produces a file; it does not change the Set, so it does NOT open an
    // undo step and is not wrapped in the transaction machinery. It still returns a
    // Promise to mirror the async SDK `renderPreFxAudio`.
    const { track } = this.#resolveTrack(id);
    if (track.kind !== 'audio') {
      throw wrongType(
        id,
        'audio track',
        'renderPreFxAudio renders audio tracks only; this is not an audio track.',
      );
    }
    if (!(endBeat > startBeat)) {
      throw badInput(
        `endBeat ${String(endBeat)} must be greater than startBeat ${String(startBeat)}.`,
      );
    }
    // Deterministic stand-in for the WAV path the host writes to its temp directory.
    const safeName = track.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
    const path = `/tmp/loophole/render/${safeName}_${String(startBeat)}-${String(endBeat)}.wav`;
    return Promise.resolve({ path, track: track.name });
  }

  // --- transaction (one call = one undo, with rollback) ---

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#transactionSnapshot !== null) {
      throw badInput(
        'A transaction is already in progress.',
        'Do not nest transaction calls; return Promise.all([...]) instead.',
      );
    }
    // The SDK contract: the callback is SYNCHRONOUS and returns a Promise (typically
    // Promise.all([...])). An `async` callback is the most common misuse (you cannot
    // `await` inside withinTransaction), so reject it before running anything.
    if (isAsyncFunction(fn)) {
      throw badInput(
        'transaction callback must be synchronous (not async).',
        'Make the callback synchronous and return Promise.all([...]) of your mutations.',
      );
    }

    // Snapshot the whole song so any rejection rolls back to one consistent state.
    const snapshot = cloneSong(this.#song);
    this.#transactionSnapshot = snapshot;
    this.#txDepth += 1;

    let result: Promise<T>;
    try {
      const returned = fn();
      if (!isThenable(returned)) {
        throw badInput(
          'transaction callback must return a Promise.',
          'Make the callback synchronous and return Promise.all([...]) of your mutations.',
        );
      }
      result = returned;
    } catch (error) {
      // The callback threw, or returned a non-Promise. Nothing was awaited, but a
      // synchronous callback may already have mutated state, so roll back to keep
      // one call = one undo. The aborted transaction commits no undo step.
      this.#song = cloneSong(snapshot);
      this.#transactionSnapshot = null;
      this.#txDepth -= 1;
      throw error;
    }

    try {
      const value = await result;
      this.#transactionSnapshot = null;
      this.#txDepth -= 1;
      // The whole group is ONE user-facing undo step.
      this.#undoSteps += 1;
      return value;
    } catch (error) {
      this.#song = cloneSong(snapshot);
      this.#transactionSnapshot = null;
      this.#txDepth -= 1;
      throw error;
    }
  }

  /**
   * Run one mutation body. Outside a transaction this IS its own undo step (so it
   * increments {@link FakeLiveBridge.transactionCount} by one); inside a transaction
   * it just runs and the surrounding {@link FakeLiveBridge.transaction} owns the one
   * undo step and the rollback. The async signature mirrors the SDK's
   * Promise-returning mutators even though the fake resolves synchronously.
   */
  async #mutate<T>(body: () => T): Promise<T> {
    const standalone = this.#txDepth === 0;
    const value = body();
    if (standalone) {
      // A standalone mutation is its own undo step (the SDK wraps each sync setter /
      // structural op in its own withinTransaction).
      this.#undoSteps += 1;
    }
    return value;
  }

  // --- DTO builders ---

  #trackInfo(track: TrackModel): TrackInfo {
    const mixer: MixerInfo = {
      volume: track.mixer.volume.value,
      panning: track.mixer.panning,
      sendCount: track.mixer.sendCount,
    };
    const soloActive = this.#song.tracks.some((t) => t.solo);
    return {
      id: this.#referenceFor('track', track),
      kind: track.kind,
      name: track.name,
      mute: track.mute,
      solo: track.solo,
      mutedViaSolo: soloActive && !track.solo && !track.mute,
      arm: track.arm,
      clipSlotCount: track.clipSlots.length,
      arrangementClipCount: track.arrangementClips.length,
      deviceCount: track.devices.length,
      mixer,
    };
  }

  #clipInfo(
    location: 'session',
    clip: ClipModel,
    slot: ClipSlotModel,
    sceneIndex: number,
  ): SessionClipInfo;
  #clipInfo(location: 'arrangement', clip: ClipModel): ArrangementClipInfo;
  #clipInfo(
    location: ClipLocation,
    clip: ClipModel,
    slot?: ClipSlotModel,
    sceneIndex?: number,
  ): ClipInfo {
    const base = {
      id: this.#referenceFor('clip', clip),
      isMidi: clip.isMidi,
      kind: clip.isMidi ? ('midi' as const) : ('audio' as const),
      name: clip.name,
      startTime: clip.startTime,
      endTime: clip.startTime + clip.duration,
      duration: clip.duration,
      looping: clip.looping,
      loopStart: clip.loopStart,
      loopEnd: clip.loopEnd,
      endMarker: clip.endMarker,
      color: clip.color,
      muted: clip.muted,
    };
    const withFile = clip.filePath === undefined ? base : { ...base, filePath: clip.filePath };
    if (location === 'session') {
      if (slot === undefined || sceneIndex === undefined) {
        throw badInput('A populated Session clip requires a clip-slot reference and scene index.');
      }
      return {
        ...withFile,
        location: 'session',
        slotId: this.#referenceFor('clip-slot', slot),
        sceneIndex,
      };
    }
    return { ...withFile, location: 'arrangement' };
  }

  /** An empty Session clip slot, reported so the model can see where to create a clip. */
  #emptySlotInfo(slot: ClipSlotModel, sceneIndex: number): ClipInfo {
    const slotId = this.#referenceFor('clip-slot', slot);
    return {
      id: slotId,
      isMidi: false,
      kind: 'empty',
      location: 'session',
      slotId,
      sceneIndex,
      name: '',
      startTime: 0,
      endTime: 0,
      duration: 0,
      looping: false,
      loopStart: 0,
      loopEnd: 0,
      endMarker: 0,
      color: 0,
      muted: false,
    };
  }

  #paramInfo(param: ParamModel): DeviceParamInfo {
    return {
      id: this.#referenceFor('parameter', param),
      name: param.name,
      min: param.min,
      max: param.max,
      isQuantized: param.isQuantized,
      defaultValue: param.defaultValue,
      value: param.value,
    };
  }

  #deviceInfo(device: DeviceModel): DeviceInfo {
    return {
      id: this.#referenceFor('device', device),
      name: device.name,
      parameters: device.parameters.map((param) => this.#paramInfo(param)),
    };
  }

  #sceneInfo(scene: SceneModel): SceneInfo {
    return {
      id: this.#referenceFor('scene', scene),
      name: scene.name,
      tempo: scene.tempo,
      signatureNumerator: scene.signatureNumerator,
      signatureDenominator: scene.signatureDenominator,
    };
  }

  #cuePointInfo(cuePoint: CuePointModel): CuePointInfo {
    return {
      id: this.#referenceFor('cue-point', cuePoint),
      time: cuePoint.time,
      name: cuePoint.name,
    };
  }

  static #emptyTrack(kind: TrackKind, name: string): TrackModel {
    return {
      kind,
      name,
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [{ clip: null }],
      arrangementClips: [],
      devices: [],
      mixer: makeMixer(),
    };
  }
}

/**
 * Apply `Track.clearClipsInRange(start, end)` semantics to an arrangement clip list:
 * clips fully inside `[start, end)` are removed, clips that overlap a boundary are
 * TRUNCATED to the part outside the range, and clips fully outside are kept as-is.
 * The geometry fields (`startTime` / `duration` / `loopStart` / `loopEnd` /
 * `endMarker`) are adjusted to the surviving region. Returns a fresh array; clips it
 * keeps unchanged are returned by reference, truncated clips are new objects.
 *
 * A clip that spans the whole range (starts before `start` and ends after `end`) is
 * truncated to the portion before `start`; the SDK would split it into two, but the
 * fake's only caller (Session-to-Song clearing a target range before it writes) does
 * not depend on the split, so this keeps the model simple and the truncate-not-delete
 * contract intact.
 */
function clearRange(clips: readonly ClipModel[], start: number, end: number): ClipModel[] {
  const out: ClipModel[] = [];
  for (const clip of clips) {
    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clip.duration;
    const fullyOutside = clipEnd <= start || clipStart >= end;
    if (fullyOutside) {
      out.push(clip);
      continue;
    }
    const fullyInside = clipStart >= start && clipEnd <= end;
    if (fullyInside) {
      continue;
    }
    // Overlaps a boundary: truncate to the surviving region.
    let newStart = clipStart;
    let newEnd = clipEnd;
    if (clipStart < start) {
      // Keep the head before `start`.
      newEnd = start;
    } else {
      // clipStart is inside the range, so keep the tail after `end`.
      newStart = end;
    }
    const newDuration = newEnd - newStart;
    if (!(newDuration > 0)) {
      continue;
    }
    out.push({
      ...clip,
      startTime: newStart,
      duration: newDuration,
      loopStart: newStart,
      loopEnd: newEnd,
      endMarker: newEnd,
    });
  }
  return out;
}

/** Minimal thenable check used to enforce the sync-callback / Promise-return rule. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** True for an `async function` (whose body cannot run inside `withinTransaction`). */
function isAsyncFunction(fn: () => unknown): boolean {
  return fn.constructor.name === 'AsyncFunction';
}
