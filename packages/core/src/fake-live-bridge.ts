/**
 * In-memory {@link LiveBridge} that reproduces the documented SDK contract without
 * Ableton Live. It is the seam that lets the whole tool layer (and the playground)
 * run on CI with no Live install.
 *
 * Faithful to API_REFERENCE.md:
 *  - getters are synchronous and return cloned snapshots,
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
 * ring-2 suite can assert the headline correctness claim: one tool call = one
 * transaction = one undo. See {@link FakeLiveBridge.transactionCount}.
 *
 * The internal model is a plain mutable object graph. The fake never exposes those
 * objects; every read returns a fresh DTO so callers cannot mutate state behind the
 * fake's back (matching the SDK, where you must assign an array back to change it).
 */

import type {
  ClipInfo,
  ClipLocation,
  DeviceInfo,
  DeviceParamInfo,
  MixerInfo,
  NoteDTO,
  RenderResult,
  SetNotesResult,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackMatch,
  TrackPropsPatch,
} from './dtos.js';
import { badInput, sdkRejected, staleReference, wrongType } from './errors.js';
import {
  arrangementClipId,
  clipSlotId,
  deviceId,
  paramId,
  parsePath,
  sessionClipId,
  trackId,
  type ClipId,
  type ClipSlotId,
  type ParamId,
  type PathSegment,
  type TrackId,
} from './ids.js';
import type { LiveBridge } from './live-bridge.js';
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

interface ClipModel {
  isMidi: boolean;
  name: string;
  startTime: number;
  duration: number;
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  color: number;
  muted: boolean;
  /** Present only for MIDI clips. */
  notes: NoteModel[];
}

interface ClipSlotModel {
  clip: ClipModel | null;
}

interface ParamModel {
  name: string;
  min: number;
  max: number;
  isQuantized: boolean;
  defaultValue: number;
  value: number;
}

interface DeviceModel {
  name: string;
  parameters: ParamModel[];
}

interface TrackModel {
  kind: TrackKind;
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  clipSlots: ClipSlotModel[];
  arrangementClips: ClipModel[];
  devices: DeviceModel[];
  mixer: { volume: number; panning: number; sendCount: number };
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
  sceneCount: number;
  cuePointCount: number;
}

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

  constructor(song?: SongModel) {
    this.#song = song ?? FakeLiveBridge.#seedModel();
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
   * `notes`. The clip is `track:0/clipslot:0/clip` ({@link FakeLiveBridge.firstClipId}).
   * Tempo 120, C-major scale. The headline ring-2 fixture.
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
          mixer: { volume: 0.85, panning: 0.5, sendCount: 0 },
        },
      ],
      returnTrackCount: 0,
      sceneCount: 1,
      cuePointCount: 0,
    };
    return new FakeLiveBridge(song);
  }

  /**
   * The id of the first Session clip in the {@link FakeLiveBridge.withOneMidiClip}
   * fixture (`track:0/clipslot:0/clip`). An INSTANCE accessor so the ring-2 suite can
   * write `live.firstClipId` (as the 02_BRIDGE_SPEC §8 sketch does), without
   * rebuilding the id.
   */
  get firstClipId(): ClipId {
    return sessionClipId(0, 0);
  }

  /**
   * The id of the first Session clip slot in the {@link FakeLiveBridge.withOneMidiClip}
   * fixture (`track:0/clipslot:0`). The second slot (`track:0/clipslot:1`) is empty.
   * An instance accessor, paired with {@link FakeLiveBridge.firstClipId}.
   */
  get firstSlotId(): ClipSlotId {
    return clipSlotId(0, 0);
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
   * into that single step). This is the affordance ring 2 uses to assert "one tool
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
      mixer: { volume: 0.85, panning: 0.5, sendCount: 2 },
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
          color: 255,
          muted: false,
          notes: [{ pitch: 36, startTime: 0, duration: 4, velocity: 100 }],
        },
      ],
      devices: [],
      mixer: { volume: 0.8, panning: 0.5, sendCount: 2 },
    };
    const vocals: TrackModel = {
      kind: 'audio',
      name: 'Vocals',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [{ clip: null }],
      // One AUDIO arrangement clip (`track:2/clip:0`) so the WRONG_TYPE branch of
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
          color: 16777215,
          muted: false,
          notes: [],
        },
      ],
      devices: [
        { name: 'EQ Eight', parameters: [makeParam('1 Frequency A', 20, 20000, 1000)] },
        { name: 'Compressor', parameters: [makeParam('Threshold', -60, 0, -12)] },
      ],
      mixer: { volume: 0.9, panning: 0.5, sendCount: 2 },
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
      sceneCount: 2,
      cuePointCount: 0,
    };
  }

  // --- resolution helpers (throw STALE_REFERENCE / WRONG_TYPE like the SDK) ---

  #resolveTrack(id: TrackId): { index: number; track: TrackModel } {
    const segments = parsePath(id);
    const head = segments[0];
    if (head === undefined || head.kind !== 'track' || !('index' in head)) {
      throw wrongType(id, 'track');
    }
    if (segments.length !== 1) {
      throw wrongType(id, 'track');
    }
    const track = this.#song.tracks[head.index];
    if (track === undefined) {
      throw staleReference(id);
    }
    return { index: head.index, track };
  }

  /** Resolve any clip id (session or arrangement) to its mutable model. */
  #resolveClip(id: ClipId): ClipModel {
    const segments = parsePath(id);
    const head = segments[0];
    if (head === undefined || head.kind !== 'track' || !('index' in head)) {
      throw wrongType(id, 'clip');
    }
    const track = this.#song.tracks[head.index];
    if (track === undefined) {
      throw staleReference(id);
    }
    const rest: readonly PathSegment[] = segments.slice(1);
    return this.#resolveClipUnderTrack(id, track, rest);
  }

  #resolveClipUnderTrack(id: ClipId, track: TrackModel, rest: readonly PathSegment[]): ClipModel {
    const first = rest[0];
    if (first === undefined) {
      throw wrongType(id, 'clip');
    }
    // Arrangement clip: track:N/clip:M
    if (first.kind === 'clip' && 'index' in first) {
      const clip = track.arrangementClips[first.index];
      if (clip === undefined) {
        throw staleReference(id);
      }
      return clip;
    }
    // Session clip: track:N/clipslot:M/clip
    if (first.kind === 'clipslot' && 'index' in first) {
      const slot = track.clipSlots[first.index];
      if (slot === undefined) {
        throw staleReference(id);
      }
      const terminal = rest[1];
      if (terminal === undefined || terminal.kind !== 'clip') {
        throw wrongType(id, 'clip');
      }
      if (slot.clip === null) {
        throw staleReference(id, `Clip slot "${id}" is empty.`);
      }
      return slot.clip;
    }
    throw wrongType(id, 'clip');
  }

  /** Resolve a clip-slot id (`track:N/clipslot:M`) to its mutable model + indices. */
  #resolveSlot(id: ClipSlotId): { trackIndex: number; slotIndex: number; slot: ClipSlotModel } {
    const segments = parsePath(id);
    const head = segments[0];
    if (head === undefined || head.kind !== 'track' || !('index' in head)) {
      throw wrongType(id, 'clip slot');
    }
    const second = segments[1];
    if (second === undefined || second.kind !== 'clipslot' || !('index' in second)) {
      throw wrongType(id, 'clip slot');
    }
    if (segments.length !== 2) {
      throw wrongType(id, 'clip slot');
    }
    const track = this.#song.tracks[head.index];
    if (track === undefined) {
      throw staleReference(id);
    }
    const slot = track.clipSlots[second.index];
    if (slot === undefined) {
      throw staleReference(id);
    }
    return { trackIndex: head.index, slotIndex: second.index, slot };
  }

  /** Resolve a parameter id (`track:N/device:D/param:P`) to its model + ids. */
  #resolveParam(id: ParamId): { trackIndex: number; deviceIndex: number; param: ParamModel } {
    const segments = parsePath(id);
    const head = segments[0];
    const dev = segments[1];
    const par = segments[2];
    if (
      head === undefined ||
      head.kind !== 'track' ||
      !('index' in head) ||
      dev === undefined ||
      dev.kind !== 'device' ||
      !('index' in dev) ||
      par === undefined ||
      par.kind !== 'param' ||
      !('index' in par) ||
      segments.length !== 3
    ) {
      throw wrongType(id, 'device parameter');
    }
    const track = this.#song.tracks[head.index];
    if (track === undefined) {
      throw staleReference(id);
    }
    const device = track.devices[dev.index];
    if (device === undefined) {
      throw staleReference(id);
    }
    const param = device.parameters[par.index];
    if (param === undefined) {
      throw staleReference(id);
    }
    return { trackIndex: head.index, deviceIndex: dev.index, param };
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
      sceneCount: s.sceneCount,
      cuePointCount: s.cuePointCount,
      tracks: s.tracks.map((track, index) => ({
        id: trackId(index),
        name: track.name,
        type: track.kind,
      })),
    };
  }

  listTracks(): readonly TrackInfo[] {
    return this.#song.tracks.map((track, index) => this.#trackInfo(index, track));
  }

  findTrack(query: string): readonly TrackMatch[] {
    const needle = query.toLowerCase();
    const matches: TrackMatch[] = [];
    this.#song.tracks.forEach((track, index) => {
      if (track.name.toLowerCase().includes(needle)) {
        matches.push({ id: trackId(index), name: track.name, type: track.kind });
      }
    });
    return matches;
  }

  listClips(id: TrackId): readonly ClipInfo[] {
    const { index, track } = this.#resolveTrack(id);
    const out: ClipInfo[] = [];
    track.clipSlots.forEach((slot, slotIndex) => {
      if (slot.clip !== null) {
        out.push(
          this.#clipInfo(
            sessionClipId(index, slotIndex),
            'session',
            slot.clip,
            clipSlotId(index, slotIndex),
          ),
        );
      } else {
        out.push(this.#emptySlotInfo(clipSlotId(index, slotIndex)));
      }
    });
    track.arrangementClips.forEach((clip, clipIndex) => {
      out.push(this.#clipInfo(arrangementClipId(index, clipIndex), 'arrangement', clip));
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

  listDeviceParams(id: TrackId): readonly DeviceParamInfo[] {
    const { index, track } = this.#resolveTrack(id);
    const out: DeviceParamInfo[] = [];
    track.devices.forEach((device, deviceIndex) => {
      device.parameters.forEach((param, paramIndex) => {
        out.push(this.#paramInfo(paramId(index, deviceIndex, paramIndex), param));
      });
    });
    return out;
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
      const { index, track } = this.#resolveTrack(id);
      if (props.name !== undefined) track.name = props.name;
      if (props.mute !== undefined) track.mute = props.mute;
      if (props.solo !== undefined) track.solo = props.solo;
      if (props.arm !== undefined) track.arm = props.arm;
      return this.#trackInfo(index, track);
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
      const index = this.#song.tracks.length - 1;
      const track = this.#song.tracks[index];
      if (track === undefined) {
        // Unreachable: we just pushed it. Guards noUncheckedIndexedAccess.
        throw sdkRejected('Track creation did not yield a track.');
      }
      return this.#trackInfo(index, track);
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
        color: 0,
        muted: false,
        notes: [],
      };
      slot.clip = clip;
      return this.#clipInfo(
        sessionClipId(trackIndex, slotIndex),
        'session',
        clip,
        clipSlotId(trackIndex, slotIndex),
      );
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
      return this.#paramInfo(id, param);
    });
  }

  async insertDevice(id: TrackId, deviceName: string, index: number): Promise<DeviceInfo> {
    return this.#mutate(() => {
      const { index: trackIndex, track } = this.#resolveTrack(id);
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
      return this.#deviceInfo(trackIndex, at, device);
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

  #trackInfo(index: number, track: TrackModel): TrackInfo {
    const mixer: MixerInfo = {
      volume: track.mixer.volume,
      panning: track.mixer.panning,
      sendCount: track.mixer.sendCount,
    };
    const soloActive = this.#song.tracks.some((t) => t.solo);
    return {
      id: trackId(index),
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

  #clipInfo(id: ClipId, location: ClipLocation, clip: ClipModel, slotId?: ClipSlotId): ClipInfo {
    const base = {
      id,
      isMidi: clip.isMidi,
      kind: clip.isMidi ? ('midi' as const) : ('audio' as const),
      location,
      name: clip.name,
      startTime: clip.startTime,
      endTime: clip.startTime + clip.duration,
      duration: clip.duration,
      looping: clip.looping,
      loopStart: clip.loopStart,
      loopEnd: clip.loopEnd,
      color: clip.color,
      muted: clip.muted,
    };
    // Omit slotId when absent (exactOptionalPropertyTypes): never set key: undefined.
    return slotId === undefined ? base : { ...base, slotId };
  }

  /** An empty Session clip slot, reported so the model can see where to create a clip. */
  #emptySlotInfo(slotId: ClipSlotId): ClipInfo {
    return {
      id: slotId,
      isMidi: false,
      kind: 'empty',
      location: 'session',
      slotId,
      name: '',
      startTime: 0,
      endTime: 0,
      duration: 0,
      looping: false,
      loopStart: 0,
      loopEnd: 0,
      color: 0,
      muted: false,
    };
  }

  #paramInfo(id: ParamId, param: ParamModel): DeviceParamInfo {
    return {
      id,
      name: param.name,
      min: param.min,
      max: param.max,
      isQuantized: param.isQuantized,
      defaultValue: param.defaultValue,
      value: param.value,
    };
  }

  #deviceInfo(trackIndex: number, deviceIndex: number, device: DeviceModel): DeviceInfo {
    return {
      id: deviceId(trackIndex, deviceIndex),
      name: device.name,
      parameters: device.parameters.map((param, paramIndex) =>
        this.#paramInfo(paramId(trackIndex, deviceIndex, paramIndex), param),
      ),
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
      mixer: { volume: 0.85, panning: 0.5, sendCount: 0 },
    };
  }
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
