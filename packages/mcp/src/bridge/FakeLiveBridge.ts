/**
 * In-memory {@link LiveBridge} that reproduces the documented SDK contract without
 * Ableton Live. It is the seam that lets the whole tool layer (and the playground)
 * run on CI with no Live install.
 *
 * Faithful to API_REFERENCE.md:
 *  - getters are synchronous and return cloned snapshots,
 *  - mutators are async (return resolved Promises),
 *  - MIDI notes use read-map-assign: a read clones, a write replaces wholesale,
 *  - pitch is clamped to 0..127 on write (Live rejects out-of-range),
 *  - referencing a deleted or unknown id throws `STALE_REFERENCE` (or `WRONG_TYPE`
 *    when the id resolves to the wrong object kind),
 *  - `withTransaction` groups mutations into one undo step: the callback must be
 *    synchronous (it may return `Promise.all([...])`), and any rejection rolls the
 *    whole group back so one call stays one undo.
 *
 * The internal model is a plain mutable object graph. The fake never exposes those
 * objects; every read returns a fresh DTO so callers cannot mutate state behind the
 * fake's back (matching the SDK, where you must assign an array back to change it).
 */

import type {
  ClipInfo,
  ClipLocation,
  CreateMidiClipArgs,
  MixerInfo,
  NoteDTO,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackPropsPatch,
  TrackQuery,
} from './dtos.js';
import { badInput, staleReference, wrongType } from './errors.js';
import {
  arrangementClipId,
  parsePath,
  sessionClipId,
  trackId,
  type ClipId,
  type PathSegment,
  type TrackId,
} from './ids.js';
import type { LiveBridge } from './LiveBridge.js';
import { clampPitch } from '../domain/notes.js';

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

interface TrackModel {
  kind: TrackKind;
  name: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  clipSlots: ClipSlotModel[];
  arrangementClips: ClipModel[];
  deviceCount: number;
  mixer: { volume: number; panning: number; sendCount: number };
}

interface SongModel {
  tempo: number;
  rootNote: number;
  scaleName: string;
  scaleMode: boolean;
  scaleIntervals: number[];
  tracks: TrackModel[];
  returnTrackCount: number;
  sceneCount: number;
  cuePointCount: number;
}

/** Deep clone of the whole song, used for transaction snapshots / rollback. */
function cloneSong(song: SongModel): SongModel {
  return structuredClone(song);
}

/** Build a NoteModel from an incoming DTO, clamping pitch and dropping absent keys. */
function noteFromDTO(dto: NoteDTO): NoteModel {
  const model: NoteModel = {
    pitch: clampPitch(dto.pitch),
    startTime: dto.startTime,
    duration: dto.duration,
  };
  if (dto.velocity !== undefined) model.velocity = dto.velocity;
  if (dto.muted !== undefined) model.muted = dto.muted;
  if (dto.probability !== undefined) model.probability = dto.probability;
  if (dto.velocityDeviation !== undefined) model.velocityDeviation = dto.velocityDeviation;
  if (dto.releaseVelocity !== undefined) model.releaseVelocity = dto.releaseVelocity;
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

  /** A track with one Session MIDI clip whose notes are `notes` (test helper). */
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
      tracks: [
        {
          kind: 'midi',
          name: 'MIDI',
          mute: false,
          solo: false,
          arm: false,
          clipSlots: [{ clip }],
          arrangementClips: [],
          deviceCount: 0,
          mixer: { volume: 0.85, panning: 0.5, sendCount: 0 },
        },
      ],
      returnTrackCount: 0,
      sceneCount: 1,
      cuePointCount: 0,
    };
    return new FakeLiveBridge(song);
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
      deviceCount: 1,
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
      deviceCount: 0,
      mixer: { volume: 0.8, panning: 0.5, sendCount: 2 },
    };
    const vocals: TrackModel = {
      kind: 'audio',
      name: 'Vocals',
      mute: false,
      solo: false,
      arm: false,
      clipSlots: [{ clip: null }],
      arrangementClips: [],
      deviceCount: 2,
      mixer: { volume: 0.9, panning: 0.5, sendCount: 2 },
    };
    return {
      tempo: 124,
      rootNote: 0,
      scaleName: 'Minor',
      scaleMode: true,
      scaleIntervals: [0, 2, 3, 5, 7, 8, 10],
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
    const clip = this.#resolveClipUnderTrack(id, track, rest);
    return clip;
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

  // --- reads (synchronous) ---

  getSongOverview(): SongOverview {
    const s = this.#song;
    return {
      tempo: s.tempo,
      rootNote: s.rootNote,
      scaleName: s.scaleName,
      scaleMode: s.scaleMode,
      scaleIntervals: [...s.scaleIntervals],
      trackCount: s.tracks.length,
      returnTrackCount: s.returnTrackCount,
      sceneCount: s.sceneCount,
      cuePointCount: s.cuePointCount,
    };
  }

  getTracks(): readonly TrackInfo[] {
    return this.#song.tracks.map((track, index) => this.#trackInfo(index, track));
  }

  findTrack(query: TrackQuery): readonly TrackInfo[] {
    const needle = query.name?.toLowerCase();
    return this.#song.tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => {
        if (query.kind !== undefined && track.kind !== query.kind) {
          return false;
        }
        if (needle !== undefined && !track.name.toLowerCase().includes(needle)) {
          return false;
        }
        return true;
      })
      .map(({ track, index }) => this.#trackInfo(index, track));
  }

  getClips(id: TrackId): readonly ClipInfo[] {
    const { index, track } = this.#resolveTrack(id);
    const out: ClipInfo[] = [];
    track.clipSlots.forEach((slot, slotIndex) => {
      if (slot.clip !== null) {
        out.push(this.#clipInfo(sessionClipId(index, slotIndex), 'session', slot.clip));
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

  // --- mutations (async) ---

  async setNotes(id: ClipId, notes: readonly NoteDTO[]): Promise<void> {
    await this.#mutate(() => {
      const clip = this.#resolveClip(id);
      if (!clip.isMidi) {
        throw wrongType(id, 'MIDI clip');
      }
      // Replace wholesale (assign-back), clamping pitch like Live does.
      clip.notes = notes.map(noteFromDTO);
    });
  }

  async setTempo(bpm: number): Promise<void> {
    await this.#mutate(() => {
      if (!Number.isFinite(bpm) || bpm <= 0) {
        throw badInput(`Tempo ${String(bpm)} is not a positive number.`);
      }
      this.#song.tempo = bpm;
    });
  }

  async setTrackProps(id: TrackId, props: TrackPropsPatch): Promise<void> {
    await this.#mutate(() => {
      const { track } = this.#resolveTrack(id);
      if (props.name !== undefined) track.name = props.name;
      if (props.mute !== undefined) track.mute = props.mute;
      if (props.solo !== undefined) track.solo = props.solo;
      if (props.arm !== undefined) track.arm = props.arm;
    });
  }

  async createMidiTrack(): Promise<TrackId> {
    return this.#mutate(() => {
      this.#song.tracks.push(FakeLiveBridge.#emptyTrack('midi', 'MIDI'));
      return trackId(this.#song.tracks.length - 1);
    });
  }

  async createAudioTrack(): Promise<TrackId> {
    return this.#mutate(() => {
      this.#song.tracks.push(FakeLiveBridge.#emptyTrack('audio', 'Audio'));
      return trackId(this.#song.tracks.length - 1);
    });
  }

  async createMidiClip(args: CreateMidiClipArgs): Promise<ClipId> {
    return this.#mutate(() => {
      const { index, track } = this.#resolveTrack(args.trackId);
      if (track.kind !== 'midi') {
        throw wrongType(args.trackId, 'MIDI track');
      }
      if (!(args.duration > 0)) {
        throw badInput(`Clip duration ${String(args.duration)} must be > 0.`);
      }
      if (args.startTime < 0) {
        throw badInput(`Clip startTime ${String(args.startTime)} must be >= 0.`);
      }
      const clip: ClipModel = {
        isMidi: true,
        name: 'MIDI Clip',
        startTime: args.startTime,
        duration: args.duration,
        looping: false,
        loopStart: args.startTime,
        loopEnd: args.startTime + args.duration,
        color: 0,
        muted: false,
        notes: [],
      };
      track.arrangementClips.push(clip);
      return arrangementClipId(index, track.arrangementClips.length - 1);
    });
  }

  // --- transaction (one call = one undo, with rollback) ---

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#transactionSnapshot !== null) {
      throw badInput(
        'A transaction is already in progress.',
        'Do not nest withTransaction calls; return Promise.all([...]) instead.',
      );
    }
    // Snapshot the whole song so any rejection rolls back to one consistent state.
    const snapshot = cloneSong(this.#song);
    this.#transactionSnapshot = snapshot;

    // The SDK contract: the callback is SYNCHRONOUS and returns a Promise
    // (typically Promise.all([...])). Invoke it synchronously and verify the
    // return is thenable before awaiting; an async callback or a non-Promise
    // return is the most common misuse, so we reject it loudly.
    let result: Promise<T>;
    try {
      const returned = fn();
      if (!isThenable(returned)) {
        throw badInput(
          'withTransaction callback must return a Promise.',
          'Make the callback synchronous and return Promise.all([...]) of your mutations.',
        );
      }
      result = returned;
    } catch (error) {
      // The callback threw, or returned a non-Promise. Nothing was awaited, but a
      // synchronous callback may already have mutated state, so roll back to keep
      // one call = one undo.
      this.#song = cloneSong(snapshot);
      this.#transactionSnapshot = null;
      throw error;
    }

    try {
      const value = await result;
      this.#transactionSnapshot = null;
      return value;
    } catch (error) {
      this.#song = cloneSong(snapshot);
      this.#transactionSnapshot = null;
      throw error;
    }
  }

  /**
   * Run one mutation body. Outside a transaction this is its own undo step; inside
   * a transaction it just runs (the surrounding {@link withTransaction} owns the
   * snapshot and rollback). The async signature mirrors the SDK's Promise-returning
   * mutators even though the fake resolves synchronously.
   */
  async #mutate<T>(body: () => T): Promise<T> {
    return body();
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
      deviceCount: track.deviceCount,
      mixer,
    };
  }

  #clipInfo(id: ClipId, location: ClipLocation, clip: ClipModel): ClipInfo {
    return {
      id,
      isMidi: clip.isMidi,
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
      deviceCount: 0,
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
