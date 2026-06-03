/**
 * The `LiveBridge` port: the entire contract between the MCP tool layer and the
 * Ableton object model.
 *
 * This interface mirrors the SDK shape documented in API_REFERENCE.md but speaks
 * plain DTOs and stable string {@link PathId}s, never `Handle`/`bigint` and never
 * an SDK type. Two implementations exist:
 *  - {@link FakeLiveBridge} (this package, for tests and the out-of-Live playground), and
 *  - `AbletonLiveBridge` (the extension shell, the only file that imports
 *    `@ableton-extensions/sdk`).
 *
 * It is the seam the 12 Loophole Bridge tools sit on: each read tool calls one read
 * method and shapes the result; each write tool calls one mutation method, which is
 * itself one queued transaction (one undo). Mutations return the rich post-write DTO
 * so a tool can report the resulting state without a follow-up read.
 *
 * Contract rules, taken verbatim from the SDK semantics:
 *  1. Reads are handle-backed getters and are SYNCHRONOUS (`getSongOverview`,
 *     `listTracks`, `findTrack`, `listClips`, `getNotes`, `listDeviceParams`). They
 *     return a snapshot, never a Promise.
 *  2. Mutations are ASYNC and return Promises (`setTempo`, `setTrackProps`,
 *     `setNotes`, `createTrack`, `createMidiClip`, `setParam`, `insertDevice`,
 *     `renderTrack`). Always `await` them. Each is one queued transaction = one undo.
 *  3. Group several mutations into ONE user-facing undo step with
 *     {@link LiveBridge.transaction}, mirroring the SDK's `withinTransaction`.
 *  4. Referencing a deleted or unknown id throws a `BridgeError` with code
 *     `STALE_REFERENCE`; referencing the wrong object kind throws `WRONG_TYPE`.
 */

import type {
  ClipInfo,
  DeviceInfo,
  DeviceParamInfo,
  NoteDTO,
  RenderResult,
  SetNotesResult,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackMatch,
  TrackPropsPatch,
} from './dtos.js';
import type { ClipId, ClipSlotId, ParamId, TrackId } from './ids.js';

export interface LiveBridge {
  // --- reads: synchronous handle-backed getters, return a snapshot ---

  /**
   * Snapshot of the Set: tempo, scale, grid, object counts, and a flat list of
   * tracks with ids. A summary, not a full dump; drill down with the list/read
   * methods. Backs `live_get_song_overview`.
   */
  getSongOverview(): SongOverview;

  /**
   * All non-return, non-main tracks, in track order. Matches the SDK's `tracks`
   * (which excludes return and main tracks). Backs the overview, the find, and the
   * track resource.
   */
  listTracks(): readonly TrackInfo[];

  /**
   * Resolve a human track reference (name or substring, case-insensitive) to the
   * stable track ids that match, each as `{ name, id, type }`. Returns an empty
   * array when nothing matches; does not throw on no match (an empty result is a
   * valid answer). Backs `live_find_track`.
   */
  findTrack(query: string): readonly TrackMatch[];

  /**
   * Clips on a track: both Session-view clips (from clip slots) and Arrangement
   * clips, each tagged with its `location` and `kind`. Empty Session slots are
   * reported too (as `kind: 'empty'` entries carrying their `slotId`) so the model
   * knows where it can create a clip. Backs `live_list_clips`.
   *
   * @throws BridgeError `STALE_REFERENCE` if `trackId` is unknown/deleted,
   *   `WRONG_TYPE` if it does not resolve to a track.
   */
  listClips(trackId: TrackId): readonly ClipInfo[];

  /**
   * The MIDI notes of a clip, cloned (the SDK contract is read-array, map,
   * assign-back; callers must not mutate the returned objects in place). Backs
   * `live_get_notes`.
   *
   * @throws BridgeError `STALE_REFERENCE` if the clip is gone, `WRONG_TYPE` if the
   *   id is not a MIDI clip.
   */
  getNotes(clipId: ClipId): readonly NoteDTO[];

  /**
   * Every device parameter on a track, each as a {@link DeviceParamInfo} carrying a
   * stable {@link ParamId}, so the model can obtain a parameter id to pass to
   * {@link LiveBridge.setParam}. Backs the `ableton://track/{i}` resource.
   *
   * @throws BridgeError `STALE_REFERENCE` if `trackId` is unknown/deleted,
   *   `WRONG_TYPE` if it does not resolve to a track.
   */
  listDeviceParams(trackId: TrackId): readonly DeviceParamInfo[];

  // --- mutations: async, awaitable, each ONE queued transaction = ONE undo ---

  /**
   * Set the Set tempo in BPM. Resolves to the post-write {@link SongOverview} so the
   * tool can report the new state. Backs `live_set_tempo`.
   *
   * @throws BridgeError `BAD_INPUT` if `bpm` is not a finite positive number.
   */
  setTempo(bpm: number): Promise<SongOverview>;

  /**
   * Apply a partial patch of writable track properties (`name`, `mute`, `solo`,
   * `arm`) in one undo step. Only the keys present are written. Resolves to the
   * post-write {@link TrackInfo}. Backs `live_set_track_props`.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` for a bad `trackId`.
   */
  setTrackProps(trackId: TrackId, props: TrackPropsPatch): Promise<TrackInfo>;

  /**
   * Replace the notes of a MIDI clip wholesale (read-map-assign). Pitches and
   * velocities are clamped to 0..127 to match Live rejecting out-of-range values.
   * Resolves to `{ id, name, count }` with the resulting note count. Backs
   * `live_set_notes`.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` as for {@link getNotes}.
   */
  setNotes(clipId: ClipId, notes: readonly NoteDTO[]): Promise<SetNotesResult>;

  /**
   * Create one new, empty MIDI or audio track at the end of the track list.
   * Resolves to the new {@link TrackInfo}. Naming is a separate call (the SDK cannot
   * create-then-configure in one transaction): use {@link LiveBridge.setTrackProps}.
   * Backs `live_create_track`. Mirrors `Song.createMidiTrack()` /
   * `Song.createAudioTrack()`.
   *
   * @throws BridgeError `SDK_REJECTED` if the host refuses creation.
   */
  createTrack(kind: TrackKind): Promise<TrackInfo>;

  /**
   * Create an empty MIDI clip in a Session clip slot, ready for
   * {@link LiveBridge.setNotes}. Resolves to the new clip's {@link ClipInfo}. Mirrors
   * `ClipSlot.createMidiClip(length)` (a single positional length in beats). Backs
   * `live_create_midi_clip`.
   *
   * @throws BridgeError `STALE_REFERENCE` if the slot is gone, `WRONG_TYPE` if the id
   *   is not a clip slot or the slot is on an audio track, `SDK_REJECTED` if the slot
   *   is already occupied, `BAD_INPUT` if `lengthBeats` is not > 0.
   */
  createMidiClip(slotId: ClipSlotId, lengthBeats: number): Promise<ClipInfo>;

  /**
   * Set one device parameter to a value (within the parameter's own `min..max`).
   * Resolves to the post-write {@link DeviceParamInfo}. Mirrors
   * `DeviceParameter.setValue(value)`. Backs `live_set_param`.
   *
   * @throws BridgeError `STALE_REFERENCE` if the device/param is gone, `WRONG_TYPE`
   *   if the id is not a parameter, `BAD_INPUT` if `value` is outside `min..max`,
   *   `SDK_REJECTED` on host refusal.
   */
  setParam(paramId: ParamId, value: number): Promise<DeviceParamInfo>;

  /**
   * Insert a built-in Live device (e.g. `"Reverb"`, `"EQ Eight"`) onto a track at an
   * index in its device chain. Resolves to the new {@link DeviceInfo} (with its
   * parameters) so the model can immediately address parameters with
   * {@link LiveBridge.setParam}. Built-in devices only; third-party / VST is not
   * supported. Mirrors `Track.insertDevice(deviceName, index)`. Backs
   * `live_insert_device`.
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is gone, `WRONG_TYPE` if the
   *   id is not a track, `BAD_INPUT` for a negative index, `SDK_REJECTED` if
   *   `deviceName` is not a known built-in device.
   */
  insertDevice(trackId: TrackId, deviceName: string, index: number): Promise<DeviceInfo>;

  /**
   * Render a track's pre-FX audio over a beat range to a WAV in the temp directory,
   * and resolve to `{ path, track }`. This produces a file; it does not change the
   * Set, so it is NOT wrapped in a transaction (there is nothing to undo). The render
   * is pre-FX. Mirrors `Resources.renderPreFxAudio(track, startTime, endTime)`. Backs
   * `live_render_track`.
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is gone, `WRONG_TYPE` if the id
   *   is not a track, `BAD_INPUT` if `endBeat <= startBeat`, `UNSUPPORTED` /
   *   `SDK_REJECTED` if the host cannot render this track.
   */
  renderTrack(trackId: TrackId, startBeat: number, endBeat: number): Promise<RenderResult>;

  // --- transaction grouping ---

  /**
   * Group several mutations into ONE user-facing undo step, mirroring the SDK's
   * `withinTransaction`.
   *
   * The callback is **synchronous**: it must not be `async` and must not `await`.
   * To batch async mutations, return `Promise.all([...])` from the callback. On any
   * rejection, the whole transaction rolls back so one call stays one undo.
   *
   * @throws BridgeError `BAD_INPUT` if the callback does not return a Promise (the
   *   most common misuse, matching the SDK's sync-callback rule).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
