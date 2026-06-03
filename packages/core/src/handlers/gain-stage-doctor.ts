/**
 * Gain Stage Doctor (W3) command handler, 03_EXTENSIONS_SPEC §3.
 *
 * The thin, SDK-free orchestration between the {@link LiveBridge} port and the pure
 * loudness math in `../transforms/loudness.js`. It reads through the port, decodes the
 * rendered audio via an INJECTED callback (so core imports no `node:fs` and no
 * audio-decode package), measures with the pure functions, and writes every trim back
 * in ONE transaction (one undo).
 *
 * This file is ring 2: it is tested against {@link FakeLiveBridge} with a fake `decode`
 * that returns fixture channels, never against real Live and never against a real WAV.
 * The one piece it cannot prove without Live is the dB-to-internal-value curve baked
 * into {@link dbToParamValue}; that is the flagged W3 de-risk verified in ring 3 (see
 * the de-risk note on `dbToParamValue` and the comment in the handler test).
 *
 * The call shape mirrors the spec's §3(b) data flow exactly:
 *   render (port, async) → decode (injected, async) → analyze (pure) → suggest (pure)
 *   → dbToParamValue (pure) → one `transaction(() => Promise.all(setParam …))`.
 */

import type { LiveBridge } from '../live-bridge.js';
import type { DeviceParamInfo } from '../dtos.js';
import type { ParamId, TrackId } from '../ids.js';
import { analyzeLoudness, dbToParamValue, suggestTrimDb } from '../transforms/loudness.js';

/**
 * A decode callback: turn a rendered WAV path into decoded PCM channels. INJECTED so
 * core stays dependency-free and `node:fs`-free (03_EXTENSIONS_SPEC §0/§3, cross-cutting
 * "audio decode is INJECTED as a callback, never imported in core"). In the extension
 * shell this wraps `fs.readFile` + the `audio-decode` package; in ring-2 tests it is a
 * fake returning fixture {@link Float32Array}s straight past the I/O boundary.
 */
export type DecodeWav = (wavPath: string) => Promise<Float32Array[]>;

/** Arguments for {@link runGainStageDoctor}: the audio tracks to stage and the RMS target. */
export interface GainStageDoctorArgs {
  /** The audio tracks to measure and trim, by stable {@link TrackId}. */
  readonly trackIds: readonly TrackId[];
  /** Target RMS staging level in dBFS (the UI default is −18; §3(c)). */
  readonly targetDb: number;
}

/** One table row of the Gain Stage Doctor report (03_EXTENSIONS_SPEC §3(c)). */
export interface GainStageRow {
  /** The track's display name (from the render result). */
  readonly track: string;
  /** Measured true-peak level in dBFS. */
  readonly peakDb: number;
  /** Measured RMS level in dBFS. */
  readonly rmsDb: number;
  /** Crest factor in dB (`peakDb - rmsDb`). */
  readonly crest: number;
  /** Suggested gain change in dB to reach `targetDb` (`targetDb - rmsDb`). */
  readonly trimDb: number;
}

/** Result of {@link runGainStageDoctor}: one {@link GainStageRow} per measured track. */
export interface GainStageDoctorResult {
  readonly rows: readonly GainStageRow[];
}

/**
 * Fallback render length in beats for a track with no Arrangement clips to bound the
 * render. The spec derives the render range "from the track's clip extents for the
 * per-track variant" (§3(b)); when a track has no Arrangement clips there is no extent,
 * so this one-bar window keeps `renderTrack`'s `endBeat > startBeat` contract satisfied
 * (the render is then effectively silence, which `analyzeLoudness` reports at the
 * guarded floor rather than crashing).
 */
const DEFAULT_RENDER_BEATS = 4;

/**
 * Run Gain Stage Doctor over `args.trackIds` (03_EXTENSIONS_SPEC §3).
 *
 * Per track, in order:
 *  1. derive `[startBeat, endBeat]` from the track's Arrangement clip extents
 *     ({@link deriveRenderRange}), then `await bridge.renderTrack(...)` to a WAV path
 *     (`renderTrack` itself adds no undo step — it produces a file, it does not change
 *     the Set),
 *  2. `await decode(path)` to PCM channels (the injected boundary),
 *  3. {@link analyzeLoudness} → peak / RMS / crest,
 *  4. {@link suggestTrimDb}(rmsDb, targetDb) → the dB trim,
 *  5. `await bridge.getTrackMixer(trackId)` for its `volume` (an async read; no undo
 *     step) and {@link dbToParamValue} the trim onto its internal scale → the new value.
 *
 * Then it commits EVERY trim in a single transaction:
 *   `bridge.transaction(() => Promise.all(targets.map(t => bridge.setParam(t.volumeParamId, t.newValue))))`.
 * That `setParam` batch is the one and only undo step the whole run produces; the
 * renders above are side-effect-free file writes outside the transaction. When no track
 * yields a trim (e.g. an empty `trackIds`), no transaction is opened at all.
 *
 * The measurement rows are returned for the report regardless of whether the write
 * runs, so the caller can show the table even before the user confirms "Apply trims".
 *
 * @param bridge The {@link LiveBridge} port (real adapter in Live, fake in tests).
 * @param args The tracks to stage and the RMS target (dBFS).
 * @param decode The injected WAV-decode callback (keeps core `fs`-free / dep-free).
 */
export async function runGainStageDoctor(
  bridge: LiveBridge,
  args: GainStageDoctorArgs,
  decode: DecodeWav,
): Promise<GainStageDoctorResult> {
  const rows: GainStageRow[] = [];
  const targets: { readonly volumeParamId: ParamId; readonly newValue: number }[] = [];

  for (const trackId of args.trackIds) {
    const { startBeat, endBeat } = deriveRenderRange(bridge, trackId);

    // Render is async and side-effect-free (a file write, not a Set mutation), so it
    // is NOT inside the transaction.
    const render = await bridge.renderTrack(trackId, startBeat, endBeat);
    const channels = await decode(render.path);

    const { peakDb, rmsDb, crest } = analyzeLoudness(channels);
    const trimDb = suggestTrimDb(rmsDb, args.targetDb);
    rows.push({ track: render.track, peakDb, rmsDb, crest, trimDb });

    // Map the dB trim onto the mixer volume's internal scale, anchored at its unity
    // (defaultValue) and clamped to its range. getTrackMixer is an async read (the live
    // volume value comes from DeviceParameter.getValue()); it adds no undo step.
    const volume: DeviceParamInfo = (await bridge.getTrackMixer(trackId)).volume;
    const newValue = dbToParamValue(trimDb, volume);
    targets.push({ volumeParamId: volume.id, newValue });
  }

  // Group every trim write into ONE undo step. setParam is async, so the sync
  // transaction callback returns Promise.all([...]) (never awaits inside). With no
  // targets there is nothing to undo, so skip opening a transaction entirely.
  if (targets.length > 0) {
    await bridge.transaction(() =>
      Promise.all(targets.map((t) => bridge.setParam(t.volumeParamId, t.newValue))),
    );
  }

  return { rows };
}

/**
 * Derive the `[startBeat, endBeat]` render window for a track from its Arrangement clip
 * extents (03_EXTENSIONS_SPEC §3(b): "from the track's clip extents for the per-track
 * variant"): the earliest clip `startTime` to the latest clip `endTime`. A track with
 * no Arrangement clips has no extent, so it falls back to `[0, DEFAULT_RENDER_BEATS]`
 * to keep `renderTrack`'s `endBeat > startBeat` contract. `listClips` is a SYNC read.
 *
 * Only Arrangement clips bound the render: `renderPreFxAudio` renders the Arrangement
 * timeline (§3(b)), and Session clips have no Arrangement position. The returned range
 * is always non-empty (`endBeat > startBeat`).
 */
function deriveRenderRange(
  bridge: LiveBridge,
  trackId: TrackId,
): { readonly startBeat: number; readonly endBeat: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const clip of bridge.listClips(trackId)) {
    if (clip.location !== 'arrangement') {
      continue;
    }
    if (clip.startTime < start) {
      start = clip.startTime;
    }
    if (clip.endTime > end) {
      end = clip.endTime;
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
    return { startBeat: 0, endBeat: DEFAULT_RENDER_BEATS };
  }
  return { startBeat: start, endBeat: end };
}
