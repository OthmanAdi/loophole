/**
 * The `LiveBridge` port: the entire contract between the MCP tool layer and the
 * Ableton object model.
 *
 * This interface mirrors the SDK shape documented in API_REFERENCE.md but speaks
 * plain DTOs and stable string {@link PathId}s, never `Handle`/`bigint` and never
 * an SDK type. Two implementations exist:
 *  - `FakeLiveBridge` (this package, for tests and the out-of-Live playground), and
 *  - `AbletonLiveBridge` (wave W4, in `packages/extension`, the only file that
 *    imports `@ableton-extensions/sdk`).
 *
 * Contract rules, taken verbatim from the SDK semantics:
 *  1. Reads are handle-backed getters and are synchronous (`getSongOverview`,
 *     `getTracks`, `findTrack`, `getClips`, `getNotes`). They return a snapshot.
 *  2. Structural changes and property writes are async and return Promises
 *     (`setNotes`, `setTempo`, `setTrackProps`, `create*`). Always `await` them.
 *  3. Every mutation is individually undoable. Group several into ONE user-facing
 *     undo step with {@link LiveBridge.withTransaction}.
 *  4. Referencing a deleted or unknown id throws a `BridgeError` with code
 *     `STALE_REFERENCE`; referencing the wrong object kind throws `WRONG_TYPE`.
 */

import type {
  ClipInfo,
  CreateMidiClipArgs,
  NoteDTO,
  SongOverview,
  TrackInfo,
  TrackPropsPatch,
  TrackQuery,
} from './dtos.js';
import type { ClipId, TrackId } from './ids.js';

export interface LiveBridge {
  // --- reads: synchronous handle-backed getters, return a snapshot ---

  /**
   * Snapshot of the Set: tempo, scale, and object counts. A summary, not a full
   * dump; drill down with the list/read methods.
   */
  getSongOverview(): SongOverview;

  /**
   * All non-return, non-main tracks, in track order. Matches the SDK's `tracks`
   * (which excludes return and main tracks).
   */
  getTracks(): readonly TrackInfo[];

  /**
   * Tracks matching `query` (name substring, kind), in track order. Returns an
   * empty array when nothing matches; does not throw on no match.
   */
  findTrack(query: TrackQuery): readonly TrackInfo[];

  /**
   * Clips on a track: both Session-view clips (from non-empty clip slots) and
   * Arrangement clips, each tagged with its `location`.
   *
   * @throws BridgeError `STALE_REFERENCE` if `trackId` is unknown/deleted,
   *   `WRONG_TYPE` if it does not resolve to a track.
   */
  getClips(trackId: TrackId): readonly ClipInfo[];

  /**
   * The MIDI notes of a clip, cloned (the SDK contract is read-array, map,
   * assign-back; callers must not mutate the returned objects in place).
   *
   * @throws BridgeError `STALE_REFERENCE` if the clip is gone, `WRONG_TYPE` if the
   *   id is not a MIDI clip.
   */
  getNotes(clipId: ClipId): readonly NoteDTO[];

  // --- mutations: async, awaitable, each one undo step on its own ---

  /**
   * Replace the notes of a MIDI clip wholesale (read-map-assign). Pitches are
   * clamped to 0..127 to match Live rejecting out-of-range values.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` as for {@link getNotes}.
   */
  setNotes(clipId: ClipId, notes: readonly NoteDTO[]): Promise<void>;

  /**
   * Set the Set tempo in BPM.
   *
   * @throws BridgeError `BAD_INPUT` if `bpm` is not a finite positive number.
   */
  setTempo(bpm: number): Promise<void>;

  /**
   * Apply a partial patch of writable track properties (`name`, `mute`, `solo`,
   * `arm`). Only the keys present are written.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` for a bad `trackId`.
   */
  setTrackProps(trackId: TrackId, props: TrackPropsPatch): Promise<void>;

  /**
   * Create a new, empty MIDI track at the end of the track list. Resolves to the
   * new track's stable id. Mirrors `Song.createMidiTrack()`.
   */
  createMidiTrack(): Promise<TrackId>;

  /**
   * Create a new, empty audio track at the end of the track list. Resolves to the
   * new track's stable id. Mirrors `Song.createAudioTrack()`.
   */
  createAudioTrack(): Promise<TrackId>;

  /**
   * Create a MIDI clip on the Arrangement timeline of a MIDI track. Resolves to
   * the new clip's stable id. Mirrors `MidiTrack.createMidiClip(start, duration)`.
   *
   * @throws BridgeError `STALE_REFERENCE` / `WRONG_TYPE` for a bad track,
   *   `BAD_INPUT` if `duration <= 0` or `startTime < 0`.
   */
  createMidiClip(args: CreateMidiClipArgs): Promise<ClipId>;

  // --- transaction grouping ---

  /**
   * Group several mutations into ONE user-facing undo step, mirroring the SDK's
   * `withinTransaction`.
   *
   * The callback is **synchronous**: it must not be `async` and must not `await`.
   * To batch async mutations, return `Promise.all([...])` from the callback. On
   * any rejection, the whole transaction rolls back so one call stays one undo.
   *
   * @throws BridgeError `BAD_INPUT` if the callback does not return a Promise
   *   (the most common misuse, matching the SDK's sync-callback rule).
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
