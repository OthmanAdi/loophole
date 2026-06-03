/**
 * The `LiveBridge` port: the entire contract between the MCP tool layer and the
 * Ableton object model.
 *
 * This interface mirrors the SDK shape documented in API_REFERENCE.md but speaks
 * plain DTOs and stable string {@link PathId}s, never `Handle`/`bigint` and never
 * an SDK type. Two implementations exist:
 *  - {@link FakeLiveBridge} (this package, for tests and the out-of-Live playground), and
 *  - `AbletonLiveBridge` (the extension shell). In the extension package the SDK is
 *    imported only by the adapter, the five command modules, and `activate()`, all
 *    excluded from the committed CI tsconfig.
 *
 * It is the seam the 12 Loophole Bridge tools sit on: each read tool calls one read
 * method and shapes the result; each write tool calls one mutation method, which is
 * itself one queued transaction (one undo). Mutations return the rich post-write DTO
 * so a tool can report the resulting state without a follow-up read.
 *
 * Contract rules, taken verbatim from the SDK semantics:
 *  1. Most reads are handle-backed getters and are SYNCHRONOUS (`getSongOverview`,
 *     `listTracks`, `findTrack`, `listClips`, `getNotes`, `listScenes`). They return a
 *     snapshot, never a Promise. The two exceptions are `listDeviceParams` and
 *     `getTrackMixer`: a parameter's live value comes from `DeviceParameter.getValue()`,
 *     the one ASYNC getter in the SDK (01_SDK_MAP §2), so these reads return a Promise.
 *     They are still pure reads: they open no transaction and add no undo step.
 *  2. Mutations are ASYNC and return Promises (`setTempo`, `setTrackProps`,
 *     `setNotes`, `setClipProps`, `createTrack`, `createMidiClip`,
 *     `createArrangementMidiClip`, `createArrangementAudioClip`, `clearClipsInRange`,
 *     `createCuePoint`, `deleteTrack`, `deleteClip`, `setParam`, `insertDevice`,
 *     `renderTrack`). Always `await` them. Each is one queued transaction = one undo
 *     (and collapses to zero extra undo steps when called inside
 *     {@link LiveBridge.transaction}).
 *  3. Group several mutations into ONE user-facing undo step with
 *     {@link LiveBridge.transaction}, mirroring the SDK's `withinTransaction`.
 *  4. Referencing a deleted or unknown id throws a `BridgeError` with code
 *     `STALE_REFERENCE`; referencing the wrong object kind throws `WRONG_TYPE`.
 */

import type {
  ClipInfo,
  CreateAudioClipArgs,
  CuePointInfo,
  DeviceInfo,
  DeviceParamInfo,
  NoteDTO,
  RenderResult,
  SceneInfo,
  SetNotesResult,
  SongOverview,
  TrackInfo,
  TrackKind,
  TrackMatch,
  TrackMixerInfo,
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
   * clips, each tagged with its `location` and `kind`, and each carrying its loop
   * geometry including `endMarker` (so Set Janitor's loop-overrun rule can compare
   * `endMarker > loopEnd` through the port). Empty Session slots are reported too (as
   * `kind: 'empty'` entries carrying their `slotId`, with `endMarker: 0`) so the model
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
   * ASYNC because each parameter's `value` is read with `DeviceParameter.getValue()`,
   * the one async getter in the SDK (01_SDK_MAP §2), so the real adapter returns the
   * live value rather than a placeholder. It is still a pure read: it opens NO
   * transaction and adds NO undo step.
   *
   * @throws BridgeError `STALE_REFERENCE` if `trackId` is unknown/deleted,
   *   `WRONG_TYPE` if it does not resolve to a track.
   */
  listDeviceParams(trackId: TrackId): Promise<readonly DeviceParamInfo[]>;

  /**
   * Every scene in the Set, in scene order, each as a {@link SceneInfo} carrying its
   * stable {@link import("./ids.js").SceneId}, name, and (read-only) tempo / time
   * signature. Mirrors `Song.scenes`. Session-to-Song (W5) reads this so the user can
   * map each scene to a song section.
   */
  listScenes(): readonly SceneInfo[];

  /**
   * The mixer of a track, exposing its volume as an addressable
   * {@link DeviceParamInfo} (with `min` / `max` / `defaultValue` / `value`). Mirrors
   * `Track.mixer.volume`, a `DeviceParameter`. ASYNC because the volume's live `value`
   * comes from `DeviceParameter.getValue()`, the one async getter in the SDK
   * (01_SDK_MAP §2), so the real adapter returns the live value rather than a
   * placeholder. It is still a pure read: it opens NO transaction and adds NO undo
   * step. The returned `volume.id` is a writable {@link ParamId}, so Gain Stage Doctor
   * (W3) computes a trim and commits it through {@link LiveBridge.setParam} (the
   * existing one-undo write path) without any new mutation method.
   *
   * @throws BridgeError `STALE_REFERENCE` if `trackId` is unknown/deleted,
   *   `WRONG_TYPE` if it does not resolve to a track.
   */
  getTrackMixer(trackId: TrackId): Promise<TrackMixerInfo>;

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
   * Apply a partial patch of writable clip properties (`name`, `color`) in one undo
   * step. Only the keys present are written. Accepts a Session or Arrangement clip
   * id. Resolves to the post-write {@link ClipInfo}. Mirrors the sync `Clip.name =` /
   * `Clip.color =` setters. Backs Set Janitor recolor/rename and Session-to-Song clip
   * naming/coloring.
   *
   * @throws BridgeError `STALE_REFERENCE` if the clip is gone, `WRONG_TYPE` if the id
   *   is not a clip.
   */
  setClipProps(clipId: ClipId, props: { name?: string; color?: number }): Promise<ClipInfo>;

  /**
   * Delete a track from the Set. Resolves when the track is gone. Mirrors
   * `Song.deleteTrack(track)`. Backs Set Janitor's empty-track removal. After this,
   * ids that referenced the track (or objects under it) are stale.
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is unknown/deleted,
   *   `WRONG_TYPE` if the id is not a track.
   */
  deleteTrack(trackId: TrackId): Promise<void>;

  /**
   * Delete a clip, accepting either a Session clip id (mirrors `ClipSlot.deleteClip()`,
   * which empties the slot) or an Arrangement clip id (mirrors `Track.deleteClip(clip)`).
   * Resolves when the clip is gone. Backs Set Janitor's clip removal. After this, the
   * clip id is stale; for a Session clip the slot remains and reports empty.
   *
   * @throws BridgeError `STALE_REFERENCE` if the clip is gone, `WRONG_TYPE` if the id
   *   is not a clip.
   */
  deleteClip(clipId: ClipId): Promise<void>;

  /**
   * Create an empty MIDI clip on the Arrangement timeline of a track at `startBeat`
   * for `lengthBeats`, ready for {@link LiveBridge.setNotes}. Resolves to the new
   * clip's {@link ClipInfo} (its id is an indexed arrangement clip id,
   * `track:N/clip:M`). Mirrors `MidiTrack.createMidiClip(startTime, duration)`
   * (positional, beats). Backs Session-to-Song's MIDI placements.
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is gone, `WRONG_TYPE` if it is
   *   not a MIDI track, `BAD_INPUT` if `startBeat` is negative or `lengthBeats` is
   *   not > 0.
   */
  createArrangementMidiClip(
    trackId: TrackId,
    startBeat: number,
    lengthBeats: number,
  ): Promise<ClipInfo>;

  /**
   * Create an audio clip on the Arrangement timeline of an audio track by file
   * reference. Resolves to the new clip's {@link ClipInfo} (carrying `filePath`).
   * Mirrors `AudioTrack.createAudioClip({ filePath, startTime, duration })`. Backs
   * Session-to-Song's audio placements (it references the source clip by file rather
   * than moving it).
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is gone, `WRONG_TYPE` if it is
   *   not an audio track, `BAD_INPUT` if `startTime` is negative, `duration` is not
   *   > 0, or `filePath` is empty.
   */
  createArrangementAudioClip(trackId: TrackId, args: CreateAudioClipArgs): Promise<ClipInfo>;

  /**
   * Clear the Arrangement timeline of a track over a beat range, deleting clips fully
   * inside it and TRUNCATING clips that overlap a boundary (matching
   * `Track.clearClipsInRange(startTime, endTime)`). Resolves when done. Backs
   * Session-to-Song cleaning the target range before it writes the new arrangement.
   *
   * @throws BridgeError `STALE_REFERENCE` if the track is gone, `WRONG_TYPE` if the id
   *   is not a track, `BAD_INPUT` if `endBeat <= startBeat` or either is negative.
   */
  clearClipsInRange(trackId: TrackId, startBeat: number, endBeat: number): Promise<void>;

  /**
   * Create an Arrangement cue point (locator) at `beat` with `name`. Resolves to the
   * new {@link CuePointInfo}. Mirrors `Song.createCuePoint(time)` followed by the sync
   * `CuePoint.name =` setter, grouped as one undo. Backs Session-to-Song's section
   * locators.
   *
   * @throws BridgeError `BAD_INPUT` if `beat` is negative or not finite.
   */
  createCuePoint(beat: number, name: string): Promise<CuePointInfo>;

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
