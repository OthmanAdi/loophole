/**
 * `AbletonLiveBridge`: the real, in-Live implementation of the core {@link LiveBridge}
 * port (00_MASTER_PLAN §5, 02_BRIDGE_SPEC §9, the locked import boundary). The SDK is
 * imported only by the adapter, the five command modules, and `activate()`, all excluded
 * from the committed CI tsconfig. Everything that touches a `Handle`, an `instanceof`,
 * the {@link WriteQueue}, and `withinTransaction` lives behind this seam, so the MCP
 * tools and the five command handlers stay pure DTO-in / DTO-out and never see an SDK
 * type.
 *
 * It is constructed once in `activate()` from the {@link ExtensionContext} returned by
 * `initialize(activation, "1.0.0")` and lives for the whole Live session
 * (02_BRIDGE_SPEC §1.1, §1.3):
 *
 * ```ts
 * const context = initialize(activation, '1.0.0');
 * const bridge = new AbletonLiveBridge(context);
 * const server = buildServer(bridge);
 * ```
 *
 * Contract mapping (verbatim from 01_SDK_MAP §0 and 02_BRIDGE_SPEC §4), kept aligned to
 * {@link import("@othmanadi/loophole-core").FakeLiveBridge} so the two pass the same
 * contract tests:
 *  - READS resolve a fresh object via the {@link Resolver}, shape it through
 *    {@link import("./mappers.js")}, and bypass the queue (no transaction, no undo step).
 *    Most are synchronous handle-backed getters. The two exceptions, `getTrackMixer` and
 *    `listDeviceParams`, are async: a parameter's live `value` comes from
 *    `DeviceParameter.getValue()`, the one async getter (01_SDK_MAP §2), so they `await`
 *    it for the REAL value and return a Promise. They are still pure reads.
 *  - PROPERTY SETTERS are synchronous: `track.name = x`, `clip.color = c`,
 *    `cuePoint.name = n` commit immediately and are NEVER awaited (01_SDK_MAP §0 Rule
 *    A). Only `create*` / `delete*` / `insertDevice` / `DeviceParameter.setValue` /
 *    `renderPreFxAudio` are awaited.
 *  - MUTATIONS run through the {@link WriteQueue} (one FIFO) and are wrapped in
 *    `context.withinTransaction`, so one method call = one undo. The transaction
 *    callback is SYNCHRONOUS and returns the Promise(s) to batch; you cannot
 *    create-then-configure in one transaction (you need the instance first), so a
 *    "create then set props" intent is two sequential transactions (02_BRIDGE_SPEC §4).
 *  - Type narrowing uses `instanceof` (in the {@link Resolver} and mappers), throwing
 *    the core {@link import("@othmanadi/loophole-core").BridgeError}s `WRONG_TYPE` /
 *    `STALE_REFERENCE` / `BAD_INPUT` / `SDK_REJECTED`.
 *
 * RING-3 PENDING (no Ableton here; nothing below is Live-proven): the one-undo behavior
 * of each mutation, the two-step create-then-rename of a cue point (TWO undo steps, an
 * SDK limitation, see {@link AbletonLiveBridge.createCuePoint}), the W3 dB→internal
 * volume mapping, and the install / `.ablx` flow are verified only by the manual
 * `E2E_CHECKLIST.md`. The code is typed against the real v1.0.0-beta.0 `.d.mts`.
 */

import {
  type ExtensionContext,
  GridQuantization,
  MidiTrack,
  type Track,
} from '@ableton-extensions/sdk';
import {
  assertValidNote,
  badInput,
  type ClipId,
  type ClipInfo,
  type ClipSlotId,
  type CreateAudioClipArgs,
  type CuePointId,
  type CuePointInfo,
  type DeviceInfo,
  type DeviceParamInfo,
  type LiveBridge,
  type NoteDTO,
  type ParamId,
  type RenderResult,
  type SceneInfo,
  sdkRejected,
  type SetNotesResult,
  type SongOverview,
  type TrackId,
  type TrackInfo,
  type TrackKind,
  type TrackMatch,
  type TrackMixerInfo,
  type TrackPropsPatch,
  wrongType,
} from '@othmanadi/loophole-core';
import {
  clipInfo,
  cuePointInfo,
  deviceInfo,
  emptySlotInfo,
  mixerInfo,
  noteToDescription,
  noteToDTO,
  paramInfo,
  sceneInfo,
  trackInfo,
  trackKind,
  trackMixerInfo,
} from './mappers.js';
import { ReferenceService } from './reference-service.js';
import { Resolver, type V } from './resolver.js';
import { WriteQueue } from './write-queue.js';

/**
 * Map the SDK's {@link GridQuantization} enum to the `"1/N"` label the core
 * {@link import("@othmanadi/loophole-core").GridInfo} derivation parses (and to which
 * Humanize scales its nudge). The enum is NUMERIC, so `String(enum)` would emit `"8"`,
 * not `"1/16"`, and Humanize would silently fall back to a one-beat cell. The bar-level
 * values have no `1/N` form; they map to a label core treats as the safe fallback.
 *
 * SDK-DIFFERS (flagged): the port's `gridQuantization` is a free string; the SDK value
 * is this enum. This mapping is the adapter's translation, not a port change.
 */
function gridLabel(grid: GridQuantization): string {
  switch (grid) {
    case GridQuantization.Quarter:
      return '1/4';
    case GridQuantization.Eighth:
      return '1/8';
    case GridQuantization.Sixteenth:
      return '1/16';
    case GridQuantization.ThirtySecond:
      return '1/32';
    case GridQuantization.Half:
      return '1/2';
    case GridQuantization.Bar:
      return '1 Bar';
    case GridQuantization.TwoBars:
      return '2 Bars';
    case GridQuantization.FourBars:
      return '4 Bars';
    case GridQuantization.EightBars:
      return '8 Bars';
    case GridQuantization.NoGrid:
      return 'None';
    default:
      return 'None';
  }
}

/** Minimal thenable check, mirroring `FakeLiveBridge`, for the transaction contract. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** True for an `async function` (whose body cannot legally run inside a transaction). */
function isAsyncFunction(fn: () => unknown): boolean {
  return fn.constructor.name === 'AsyncFunction';
}

export class AbletonLiveBridge implements LiveBridge {
  readonly #context: ExtensionContext<V>;
  readonly #references: ReferenceService;
  readonly #resolver: Resolver;
  readonly #queue: WriteQueue;
  /**
   * Nesting depth of {@link AbletonLiveBridge.transaction}. While > 0, a single
   * mutation does NOT take its own queue slot or open its own `withinTransaction`: the
   * surrounding transaction already holds the queue slot and owns the one undo step,
   * and re-entering {@link WriteQueue.run} from inside the in-flight transaction would
   * DEADLOCK (the slot is held until the outer batch resolves). Mutations check this
   * and run their structural op inline so the outer `withinTransaction` batches it.
   */
  #txDepth = 0;

  constructor(context: ExtensionContext<V>, references: ReferenceService, maxPending?: number) {
    this.#context = context;
    this.#references = references;
    this.#resolver = new Resolver(context, references);
    this.#queue = new WriteQueue(maxPending);
  }

  // --- internal write machinery ---

  /**
   * Run one structural mutation as a single undo step. Outside a transaction it takes a
   * {@link WriteQueue} slot (writes never interleave) and is wrapped in
   * `context.withinTransaction` (one undo). `body` is SYNCHRONOUS and returns the
   * Promise to await (the SDK's sync-callback rule); `withinTransaction` returns that
   * Promise, which this awaits.
   *
   * Inside a {@link AbletonLiveBridge.transaction} (`#txDepth > 0`), `body` runs WITHOUT
   * its own queue hop or transaction wrap: the surrounding transaction holds the slot
   * and owns the undo step, the SDK collapses nested transactions, and re-entering the
   * queue here would deadlock. The op is still INITIATED synchronously (an async method
   * runs synchronously up to its first `await`, and `body()` is that first slice), so it
   * is batched into the outer transaction's one undo step.
   */
  async #write<T>(body: () => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) {
      return body();
    }
    return this.#queue.run(() => this.#context.withinTransaction(body));
  }

  // --- reads (synchronous; resolve a fresh object, shape it, bypass the queue) ---

  getSongOverview(): SongOverview {
    const song = this.#resolver.song;
    const tracks = song.tracks;
    return {
      tempo: song.tempo,
      rootNote: song.rootNote,
      scaleName: song.scaleName,
      scaleMode: song.scaleMode,
      scaleIntervals: [...song.scaleIntervals],
      gridQuantization: gridLabel(song.gridQuantization),
      gridIsTriplet: song.gridIsTriplet,
      trackCount: tracks.length,
      returnTrackCount: song.returnTracks.length,
      sceneCount: song.scenes.length,
      cuePointCount: song.cuePoints.length,
      tracks: tracks.map((track, index) => ({
        id: this.#references.issueTrack(track, index),
        name: track.name,
        type: trackKind(track),
      })),
    };
  }

  listTracks(): readonly TrackInfo[] {
    // A full TrackInfo's mixer scalars (volume / panning) are async parameter values
    // (DeviceParameter.getValue()), but the port types listTracks() as synchronous.
    // Report the structural facts and a sync-safe mixer (sendCount from the sync `sends`
    // getter; volume / panning seeded 0). The exact, addressable volume value is obtained
    // via getTrackMixer, which is async precisely so it can await that real value.
    return this.#resolver.song.tracks.map((track, index) =>
      trackInfo(track, this.#references.issueTrack(track, index), {
        volume: 0,
        panning: 0,
        sendCount: track.mixer.sends.length,
      }),
    );
  }

  findTrack(query: string): readonly TrackMatch[] {
    const needle = query.toLowerCase();
    const matches: TrackMatch[] = [];
    this.#resolver.song.tracks.forEach((track, index) => {
      if (track.name.toLowerCase().includes(needle)) {
        matches.push({
          id: this.#references.issueTrack(track, index),
          name: track.name,
          type: trackKind(track),
        });
      }
    });
    return matches;
  }

  listClips(id: TrackId): readonly ClipInfo[] {
    const { track, index } = this.#resolver.resolveTrack(id);
    const out: ClipInfo[] = [];
    track.clipSlots.forEach((slot, slotIndex) => {
      const clip = slot.clip;
      if (clip !== null) {
        out.push(
          clipInfo(
            clip,
            this.#references.issueClip(clip, index, slotIndex),
            'session',
            this.#references.issueClipSlot(slot, index, slotIndex),
            slotIndex,
          ),
        );
      } else {
        out.push(emptySlotInfo(this.#references.issueClipSlot(slot, index, slotIndex), slotIndex));
      }
    });
    track.arrangementClips.forEach((clip, clipIndex) => {
      out.push(clipInfo(clip, this.#references.issueClip(clip, index, clipIndex), 'arrangement'));
    });
    return out;
  }

  getNotes(id: ClipId): readonly NoteDTO[] {
    const resolved = this.#resolver.resolveClip(id);
    const midi = this.#resolver.asMidiClip(id, resolved.clip);
    // Clone-on-read: notes is a fresh snapshot getter; noteToDTO builds new objects so
    // a caller cannot mutate Live state without a setNotes write.
    return midi.notes.map(noteToDTO);
  }

  async listDeviceParams(id: TrackId): Promise<readonly DeviceParamInfo[]> {
    // ASYNC read (no undo step): a parameter's current value comes from
    // DeviceParameter.getValue(), the one async getter (01_SDK_MAP §2). paramInfo awaits
    // that real value; the reads run in parallel with Promise.all, order preserved so the
    // param ids line up with their index.
    const { track, index } = this.#resolver.resolveTrack(id);
    const params = track.devices.flatMap((device, deviceIndex) =>
      device.parameters.map((param, paramIndex) =>
        paramInfo(param, this.#references.issueParameter(param, index, deviceIndex, paramIndex)),
      ),
    );
    return Promise.all(params);
  }

  listScenes(): readonly SceneInfo[] {
    return this.#resolver.song.scenes.map((scene, index) =>
      sceneInfo(scene, this.#references.issueScene(scene, index)),
    );
  }

  async getTrackMixer(id: TrackId): Promise<TrackMixerInfo> {
    // ASYNC read (no undo step): the volume's live value comes from
    // DeviceParameter.getValue(), the one async getter (01_SDK_MAP §2). trackMixerInfo
    // awaits the real value and exposes the volume as an addressable parameter whose id is
    // track:N/mixer/volume, so Gain Stage Doctor reads the true level to fit the dB
    // mapping and commits the trim via setParam (one undo).
    const { track, index } = this.#resolver.resolveTrack(id);
    return trackMixerInfo(
      track.mixer,
      this.#references.issueMixerVolume(track.mixer.volume, index),
    );
  }

  // --- mutations (async; one queued transaction = one undo) ---

  async setTempo(bpm: number): Promise<SongOverview> {
    if (!Number.isFinite(bpm) || bpm <= 0) {
      throw badInput(`Tempo ${String(bpm)} is not a positive number.`);
    }
    await this.#write(() => {
      // tempo is a SYNC setter: assign, do not await. Return a resolved Promise so the
      // transaction callback's contract (return a Promise to batch) holds.
      this.#resolver.song.tempo = bpm;
      return Promise.resolve();
    });
    return this.getSongOverview();
  }

  async setTrackProps(id: TrackId, props: TrackPropsPatch): Promise<TrackInfo> {
    await this.#write(() => {
      const { track } = this.#resolver.resolveTrack(id);
      // All four are SYNC setters; assign whichever keys are present (never await).
      if (props.name !== undefined) track.name = props.name;
      if (props.mute !== undefined) track.mute = props.mute;
      if (props.solo !== undefined) track.solo = props.solo;
      if (props.arm !== undefined) track.arm = props.arm;
      return Promise.resolve();
    });
    const { track } = this.#resolver.resolveTrack(id);
    const mixer = await mixerInfo(track.mixer);
    return trackInfo(track, id, mixer);
  }

  async setNotes(id: ClipId, notes: readonly NoteDTO[]): Promise<SetNotesResult> {
    for (const note of notes) {
      assertValidNote(note);
    }
    const descriptions = notes.map(noteToDescription);
    await this.#write(() => {
      const resolved = this.#resolver.resolveClip(id);
      const midi = this.#resolver.asMidiClip(id, resolved.clip);
      // notes is a SYNC setter (whole-array assign-back). Assign, do not await.
      midi.notes = descriptions;
      return Promise.resolve();
    });
    const resolved = this.#resolver.resolveClip(id);
    const midi = this.#resolver.asMidiClip(id, resolved.clip);
    return { id, name: midi.name, count: midi.notes.length };
  }

  async createTrack(kind: TrackKind): Promise<TrackInfo> {
    // The two creators return different concrete subclasses; widen to the base Track so
    // #write's result type is monomorphic (the result is unused — we re-resolve below).
    const created = await this.#write<Track<V>>(() => {
      const operation =
        kind === 'midi'
          ? this.#resolver.song.createMidiTrack()
          : this.#resolver.song.createAudioTrack();
      return operation as Promise<Track<V>>;
    });
    // The new track is appended (no track was selected via the API). Re-derive its
    // index from the post-create list; build the DTO outside the transaction (you
    // cannot create-then-read in one sync callback).
    const index = this.#resolver.song.tracks.findIndex(
      (track) => track === created && track.handle.id === created.handle.id,
    );
    if (index < 0) throw sdkRejected('Track creation did not yield a track.');
    const track = created;
    const mixer = await mixerInfo(track.mixer);
    return trackInfo(track, this.#references.issueTrack(track, index), mixer);
  }

  async createMidiClip(id: ClipSlotId, lengthBeats: number): Promise<ClipInfo> {
    if (!Number.isFinite(lengthBeats) || !(lengthBeats > 0)) {
      throw badInput(`Clip length ${String(lengthBeats)} must be a finite number > 0.`);
    }
    const created = await this.#write(() => {
      const { track, slot } = this.#resolver.resolveSlot(id);
      if (!(track instanceof MidiTrack)) throw wrongType(id, 'MIDI track clip slot');
      if (slot.clip !== null) {
        throw sdkRejected(
          `Clip slot "${id}" is already occupied.`,
          'Pick an empty slot or clear it first.',
        );
      }
      // ClipSlot.createMidiClip(length): single POSITIONAL length in beats.
      return slot.createMidiClip(lengthBeats);
    });
    const { trackIndex, slotIndex, slot } = this.#resolver.resolveSlot(id);
    return clipInfo(
      created,
      this.#references.issueClip(created, trackIndex, slotIndex),
      'session',
      this.#references.issueClipSlot(slot, trackIndex, slotIndex),
      slotIndex,
    );
  }

  async setClipProps(id: ClipId, props: { name?: string; color?: number }): Promise<ClipInfo> {
    await this.#write(() => {
      const resolved = this.#resolver.resolveClip(id);
      // name and color are SYNC setters on Clip; assign whichever keys are present.
      if (props.name !== undefined) resolved.clip.name = props.name;
      if (props.color !== undefined) resolved.clip.color = props.color;
      return Promise.resolve();
    });
    const resolved = this.#resolver.resolveClip(id);
    return clipInfo(resolved.clip, id, resolved.location, resolved.slotId, resolved.sceneIndex);
  }

  async deleteTrack(id: TrackId): Promise<void> {
    await this.#write(() => {
      const { track } = this.#resolver.resolveTrack(id);
      return this.#resolver.song.deleteTrack(track);
    });
  }

  async deleteClip(id: ClipId): Promise<void> {
    await this.#write(() => {
      const target = this.#resolver.resolveClipForDelete(id);
      if (target.kind === 'session') {
        // ClipSlot.deleteClip(): empties the slot (the slot remains, reports empty).
        return target.slot.deleteClip();
      }
      // Arrangement clip: Track.deleteClip(clip).
      return target.track.deleteClip(target.clip);
    });
  }

  async createArrangementMidiClip(
    id: TrackId,
    startBeat: number,
    lengthBeats: number,
  ): Promise<ClipInfo> {
    if (!(startBeat >= 0) || !Number.isFinite(startBeat)) {
      throw badInput(`startBeat ${String(startBeat)} must be a non-negative number.`);
    }
    if (!Number.isFinite(lengthBeats) || !(lengthBeats > 0)) {
      throw badInput(`Clip length ${String(lengthBeats)} must be a finite number > 0.`);
    }
    const created = await this.#write(() => {
      const { track } = this.#resolver.resolveTrackOfKind(id, 'midi');
      // MidiTrack.createMidiClip(startTime, duration): POSITIONAL args (01_SDK_MAP §2).
      return track.createMidiClip(startBeat, lengthBeats);
    });
    const { index } = this.#resolver.resolveTrackOfKind(id, 'midi');
    return clipInfo(created, this.#references.issueClip(created, index, -1), 'arrangement');
  }

  async createArrangementAudioClip(id: TrackId, args: CreateAudioClipArgs): Promise<ClipInfo> {
    if (args.filePath.length === 0) {
      throw badInput('filePath must be a non-empty absolute path.');
    }
    if (!(args.startTime >= 0) || !Number.isFinite(args.startTime)) {
      throw badInput(`startTime ${String(args.startTime)} must be a non-negative number.`);
    }
    if (!Number.isFinite(args.duration) || !(args.duration > 0)) {
      throw badInput(`duration ${String(args.duration)} must be a finite number > 0.`);
    }
    const created = await this.#write(() => {
      const { track } = this.#resolver.resolveTrackOfKind(id, 'audio');
      // AudioTrack.createAudioClip({ filePath, startTime, duration }): SINGLE-OBJECT arg
      // with startTime REQUIRED (01_SDK_MAP §2 / §createClip table).
      return track.createAudioClip({
        filePath: args.filePath,
        startTime: args.startTime,
        duration: args.duration,
      });
    });
    const { index } = this.#resolver.resolveTrackOfKind(id, 'audio');
    return clipInfo(created, this.#references.issueClip(created, index, -1), 'arrangement');
  }

  async clearClipsInRange(id: TrackId, startBeat: number, endBeat: number): Promise<void> {
    if (!(startBeat >= 0) || !Number.isFinite(startBeat)) {
      throw badInput(`startBeat ${String(startBeat)} must be a non-negative number.`);
    }
    if (!Number.isFinite(endBeat) || !(endBeat > startBeat)) {
      throw badInput(
        `endBeat ${String(endBeat)} must be greater than startBeat ${String(startBeat)}.`,
      );
    }
    await this.#write(() => {
      const { track } = this.#resolver.resolveTrack(id);
      // Track.clearClipsInRange(startTime, endTime): clips overlapping a boundary are
      // TRUNCATED, not deleted (01_SDK_MAP §2).
      return track.clearClipsInRange(startBeat, endBeat);
    });
  }

  async createCuePoint(beat: number, name?: string): Promise<CuePointInfo> {
    if (!Number.isFinite(beat) || beat < 0) {
      throw badInput(`Cue point beat ${String(beat)} must be a non-negative number.`);
    }
    if (name !== undefined && this.#txDepth > 0) {
      throw badInput(
        'A cue point name depends on the asynchronous creator result and cannot share this transaction.',
        'Create the cue point first, then set its name in a second transaction.',
      );
    }
    const created = await this.#write(() => this.#resolver.song.createCuePoint(beat));
    const index = this.#resolver.song.cuePoints.findIndex(
      (cuePoint) => cuePoint === created && cuePoint.handle.id === created.handle.id,
    );
    if (index < 0) throw sdkRejected('Cue point creation did not yield a cue point.');
    const id = this.#references.issueCuePoint(created, index);
    const info = cuePointInfo(id, created.time, created.name);
    return name === undefined ? info : this.setCuePointName(id, name);
  }

  async setCuePointName(id: CuePointId, name: string): Promise<CuePointInfo> {
    const cuePoints = this.#resolver.song.cuePoints;
    await this.#write(() => {
      const cuePoint = this.#references.resolveCuePoint(id) as (typeof cuePoints)[number];
      cuePoint.name = name;
      return Promise.resolve();
    });
    const cuePoint = this.#references.resolveCuePoint(id) as (typeof cuePoints)[number];
    return cuePointInfo(id, cuePoint.time, cuePoint.name);
  }

  async setParam(id: ParamId, value: number): Promise<DeviceParamInfo> {
    await this.#write(() => {
      const fresh = this.#resolver.resolveParam(id);
      if (!Number.isFinite(value) || value < fresh.min || value > fresh.max) {
        throw badInput(
          `Value ${String(value)} is outside the parameter range ${String(
            fresh.min,
          )}..${String(fresh.max)}.`,
        );
      }
      // DeviceParameter.setValue(value) is ASYNC; return it for the transaction to
      // batch. It rejects with Error(message) on host refusal -> surfaces upstream.
      return fresh.setValue(value);
    });
    const fresh = this.#resolver.resolveParam(id);
    return paramInfo(fresh, id);
  }

  async insertDevice(id: TrackId, deviceName: string, index: number): Promise<DeviceInfo> {
    if (!Number.isInteger(index) || index < 0) {
      throw badInput(`Device index ${String(index)} must be a non-negative integer.`);
    }
    const device = await this.#write(() => {
      const { track } = this.#resolver.resolveTrack(id);
      // Track.insertDevice(deviceName, index): built-in Live devices ONLY; rejects on an
      // unknown name (-> SDK_REJECTED upstream). index is a public number.
      return track.insertDevice(deviceName, index);
    });
    const { trackIndex, deviceIndex } = this.#resolver.resolveDevice(
      this.#references.issueDevice(device, -1, -1),
    );
    const parameters = await Promise.all(
      device.parameters.map((param, parameterIndex) =>
        paramInfo(
          param,
          this.#references.issueParameter(param, trackIndex, deviceIndex, parameterIndex),
        ),
      ),
    );
    return deviceInfo(
      device,
      this.#references.issueDevice(device, trackIndex, deviceIndex),
      parameters,
    );
  }

  async renderTrack(id: TrackId, startBeat: number, endBeat: number): Promise<RenderResult> {
    // A render produces a file and does NOT change the Set, so it is NOT wrapped in a
    // transaction (nothing to undo). It is queued so the I/O does not interleave with
    // structural writes (02_BRIDGE_SPEC §5 tool 12). renderPreFxAudio takes an
    // AudioTrack only.
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      throw badInput(`startBeat ${String(startBeat)} must be a finite non-negative number.`);
    }
    if (!Number.isFinite(endBeat) || !(endBeat > startBeat)) {
      throw badInput(
        `endBeat ${String(endBeat)} must be greater than startBeat ${String(startBeat)}.`,
      );
    }
    return this.#queue.run(async () => {
      const { track } = this.#resolver.resolveTrackOfKind(id, 'audio');
      const path = await this.#context.resources.renderPreFxAudio(track, startBeat, endBeat);
      return { path, track: track.name };
    });
  }

  // --- transaction grouping (one call = one undo, sync callback contract) ---

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // The SDK contract: the callback is SYNCHRONOUS and returns a Promise (typically
    // Promise.all([...])). An async callback is the most common misuse (you cannot await
    // inside withinTransaction), so reject it before running anything, matching
    // FakeLiveBridge and the port's documented BAD_INPUT.
    if (isAsyncFunction(fn)) {
      throw badInput(
        'transaction callback must be synchronous (not async).',
        'Make the callback synchronous and return Promise.all([...]) of your mutations.',
      );
    }
    // One queued unit, one withinTransaction. Inside the callback each bridge mutation
    // sees #txDepth > 0 and runs inline (no queue hop, no own transaction), so the SDK
    // records a single undo step for the whole batch. Each mutation's structural op is
    // INITIATED synchronously during fn()'s synchronous run (an async method runs
    // synchronously up to its first await), so all ops land inside this transaction.
    return this.#queue.run(() =>
      this.#context.withinTransaction(() => this.#runTransactionBody(fn)),
    );
  }

  /**
   * Run a transaction callback with `#txDepth` raised for the duration of its
   * SYNCHRONOUS execution, validate it returned a thenable, and hand that Promise back
   * to `withinTransaction` to batch. `#txDepth` is lowered as soon as `fn()` returns
   * (its structural ops are already initiated synchronously; the awaited continuations
   * only build read DTOs, which must not be inside the transaction).
   */
  #runTransactionBody<T>(fn: () => Promise<T>): Promise<T> {
    this.#txDepth += 1;
    try {
      const value = fn();
      if (!isThenable(value)) {
        throw badInput(
          'transaction callback must return a Promise.',
          'Make the callback synchronous and return Promise.all([...]) of your mutations.',
        );
      }
      return value;
    } finally {
      this.#txDepth -= 1;
    }
  }
}
