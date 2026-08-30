/**
 * Pure Set-hygiene transforms for Set Janitor (W6), 03_EXTENSIONS_SPEC §5.
 *
 * Two functions, no I/O, no SDK, no bridge:
 *  - {@link detectIssues} sweeps a plain {@link SetDTO} and flags every mess it finds
 *    (empty tracks, placeholder names, off-palette clip colors, loop overruns), and
 *  - {@link planFixes} turns the issues the user CHOSE into the concrete {@link Fix}
 *    list the handler applies in one transaction.
 *
 * Both are deterministic and never mutate their inputs. The handler
 * (`handlers/set-janitor.ts`) builds the {@link SetDTO} from the bridge, calls these,
 * and writes the fixes back; rings 1 keeps the rule logic here, Live-free.
 *
 * Detected issue id scheme (stable, derived from kind + target so a UI can round-trip
 * a selection without a side table): `"<kind>:<opaque-reference>"`. Target type and
 * display ordinal are carried as fields, never decoded from the reference.
 */

import type { Fix, Issue, IssueId, IssueKind, SetClipDTO, SetDTO, SetTrackDTO } from '../dtos.js';
import type { ClipId, TrackId } from '../ids.js';

/**
 * The default Live clip-color palette the off-palette rule checks against.
 *
 * Live ships a fixed palette of clip/track colors; a clip whose color is not one of
 * these reads as a hand-tweaked or imported odd-one-out (03_EXTENSIONS_SPEC §5(a):
 * "inconsistent clip colors"). This set is intentionally a small, well-known slice
 * (the neutral/default plus the primary swatches the fixtures use), NOT Live's full
 * 70-entry palette, which is not exposed through the SDK. The real palette is a
 * presentation concern, so {@link detectIssues} takes the palette as an optional
 * argument: the SDK-facing adapter (or the UI) can pass Live's fuller palette, while
 * tests and the default path use this set.
 *
 * `0` is Live's "no explicit color" / default value and is always considered on
 * palette (an uncolored clip is not "off palette").
 */
export const DEFAULT_CLIP_PALETTE: ReadonlySet<number> = new Set<number>([
  0, // default / uncolored
  255, // blue
  16711680, // red
  65280, // green
  16776960, // yellow
  16777215, // white
  8421504, // gray
]);

/**
 * Matches the Live default-style placeholder names the rename rule flags: a bare
 * `MIDI` / `Audio`, an indexed `MIDI 2` / `Audio 3`, or the `1-MIDI` / `2-Audio`
 * track-default style, optionally combined (`1-Audio 4`). Anchored, case-sensitive
 * (Live's defaults are capitalised exactly so), so a real name like `Bass`,
 * `Bassline`, `Keys`, or `Loop` does NOT match. 03_EXTENSIONS_SPEC §5(a)/§5(f).
 */
const PLACEHOLDER_NAME = /^(\d+-)?(MIDI|Audio)( \d+)?$/;

/** Build a stable {@link IssueId} from an issue kind and opaque target reference. */
function issueId(kind: IssueKind, target: TrackId | ClipId): IssueId {
  return `${kind}:${target}`;
}

/** True when `name` is a Live default-style placeholder (see {@link PLACEHOLDER_NAME}). */
function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAME.test(name.trim());
}

/** True when a track has neither clips nor devices (the empty-track rule). */
function isEmptyTrack(track: SetTrackDTO): boolean {
  return track.clips.length === 0 && track.deviceCount === 0;
}

/** True when a clip's content end marker overruns its loop end (the loop-overrun rule). */
function isLoopOverrun(clip: SetClipDTO): boolean {
  // Only meaningful for a looping clip: the content (endMarker) extends past the
  // loop brace (loopEnd), so playback loops before the written content ends.
  return clip.looping && clip.endMarker > clip.loopEnd;
}

/**
 * Sweep a {@link SetDTO} and return every hygiene {@link Issue} found, in a stable
 * order: tracks in track order, and within each track the track-level issues
 * (empty-track, then placeholder name) before its clips' issues (placeholder name,
 * off-palette color, loop overrun), clips in list order.
 *
 * Pure: reads `set` and returns a fresh array; never mutates its input. The rules:
 *  - **emptyTrack** — a track with no clips and no devices ({@link isEmptyTrack}).
 *  - **placeholderName** — a track or clip whose name is a Live default-style
 *    placeholder ({@link PLACEHOLDER_NAME}).
 *  - **offPaletteColor** — a clip whose `color` is not in `palette`.
 *  - **loopOverrun** — a looping clip whose `endMarker > loopEnd` ({@link isLoopOverrun}).
 *
 * @param set the whole Set as plain data.
 * @param palette the set of on-palette color values; defaults to
 *   {@link DEFAULT_CLIP_PALETTE}. The adapter/UI may pass Live's fuller palette.
 */
export function detectIssues(
  set: SetDTO,
  palette: ReadonlySet<number> = DEFAULT_CLIP_PALETTE,
): Issue[] {
  const issues: Issue[] = [];

  for (const [trackIndex, track] of set.tracks.entries()) {
    if (isEmptyTrack(track)) {
      issues.push({
        id: issueId('emptyTrack', track.id),
        kind: 'emptyTrack',
        target: track.id,
        targetKind: 'track',
        detail: `Track "${track.name}" is empty (no clips, no devices).`,
      });
    }

    if (isPlaceholderName(track.name)) {
      issues.push({
        id: issueId('placeholderName', track.id),
        kind: 'placeholderName',
        target: track.id,
        targetKind: 'track',
        suggestedName: `Track ${String(trackIndex + 1)}`,
        detail: `Track name "${track.name}" looks like a Live default.`,
      });
    }

    for (const [clipIndex, clip] of track.clips.entries()) {
      if (isPlaceholderName(clip.name)) {
        issues.push({
          id: issueId('placeholderName', clip.id),
          kind: 'placeholderName',
          target: clip.id,
          targetKind: 'clip',
          suggestedName: `Clip ${String(clipIndex + 1)}`,
          detail: `Clip name "${clip.name}" looks like a Live default.`,
        });
      }

      if (!palette.has(clip.color)) {
        issues.push({
          id: issueId('offPaletteColor', clip.id),
          kind: 'offPaletteColor',
          target: clip.id,
          targetKind: 'clip',
          detail: `Clip "${clip.name}" uses an off-palette color (${String(clip.color)}).`,
        });
      }

      if (isLoopOverrun(clip)) {
        issues.push({
          id: issueId('loopOverrun', clip.id),
          kind: 'loopOverrun',
          target: clip.id,
          targetKind: 'clip',
          detail: `Clip "${clip.name}" overruns its loop (content ends at ${String(
            clip.endMarker,
          )}, loop ends at ${String(clip.loopEnd)}).`,
        });
      }
    }
  }

  return issues;
}

/**
 * The fix kind that repairs a given {@link IssueKind}, or `null` when the issue is
 * detect-only (no automatic repair the beta can apply):
 *  - `placeholderName` → `rename`,
 *  - `offPaletteColor` → `recolor`,
 *  - `emptyTrack` → `deleteTrack`,
 *  - `loopOverrun` → `null`. The SDK exposes no `loopEnd` / `endMarker` setter on an
 *    existing clip (01_SDK_MAP §2: those are read-only getters, no setters in
 *    v1.0.0), so a loop overrun cannot be trimmed; it is surfaced for the user to
 *    fix by hand and yields no automatic {@link Fix}. (`deleteClip` is reserved for a
 *    future "the clip is junk, remove it" choice and is not auto-derived from a
 *    detected issue here.)
 */
function fixKindForIssue(kind: IssueKind): Fix['kind'] | null {
  switch (kind) {
    case 'placeholderName':
      return 'rename';
    case 'offPaletteColor':
      return 'recolor';
    case 'emptyTrack':
      return 'deleteTrack';
    case 'loopOverrun':
      return null;
  }
}

/**
 * The on-palette color a recolor steers an off-palette clip toward: the first
 * non-default entry of the palette (a stable, deterministic pick). Falls back to `0`
 * (Live's default) for an empty / default-only palette.
 */
function paletteTargetColor(palette: ReadonlySet<number>): number {
  for (const color of palette) {
    if (color !== 0) {
      return color;
    }
  }
  return 0;
}

/**
 * Turn the issues the user CHOSE (by {@link IssueId}) into the concrete {@link Fix}
 * list the handler applies. Only issues whose id is in `chosenIds` produce a fix, and
 * only issue kinds that have an automatic repair ({@link fixKindForIssue}) do; a
 * chosen `loopOverrun` is intentionally dropped (it has no auto-fix). Destructive
 * fixes (`deleteTrack` / `deleteClip`) carry no `value` and are thereby marked
 * distinctly from the value-carrying `rename` / `recolor` fixes, so the handler (and
 * a UI) can treat them with the off-by-default caution 03_EXTENSIONS_SPEC §5(c) asks
 * for. Output order follows the input `issues` order (which is the detect order).
 *
 * Pure: reads its inputs and returns a fresh array; never mutates them.
 *
 * @param issues the full issue list from {@link detectIssues}.
 * @param chosenIds the ids of the issues the user ticked to fix.
 * @param palette the palette a `recolor` steers toward; defaults to
 *   {@link DEFAULT_CLIP_PALETTE} (matching the {@link detectIssues} default).
 */
export function planFixes(
  issues: readonly Issue[],
  chosenIds: readonly string[],
  palette: ReadonlySet<number> = DEFAULT_CLIP_PALETTE,
): Fix[] {
  const chosen = new Set(chosenIds);
  const fixes: Fix[] = [];

  for (const issue of issues) {
    if (!chosen.has(issue.id)) {
      continue;
    }
    const kind = fixKindForIssue(issue.kind);
    if (kind === null) {
      continue;
    }
    switch (kind) {
      case 'rename':
        fixes.push({
          kind,
          target: issue.target,
          targetKind: issue.targetKind,
          name: issue.suggestedName ?? (issue.targetKind === 'track' ? 'Track' : 'Clip'),
        });
        break;
      case 'recolor':
        fixes.push({
          kind,
          target: issue.target,
          targetKind: issue.targetKind,
          color: paletteTargetColor(palette),
        });
        break;
      case 'deleteTrack':
      case 'deleteClip':
        // Destructive: no value. The absent name/color is what marks a delete fix
        // distinctly from a rename/recolor.
        fixes.push({ kind, target: issue.target, targetKind: issue.targetKind });
        break;
    }
  }

  return fixes;
}
