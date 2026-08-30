/**
 * Pure Set-hygiene transforms for Set Janitor.
 *
 * Two functions, no I/O, no SDK, no bridge:
 *  - {@link detectIssues} sweeps a plain {@link SetDTO} and flags every mess it finds
 *    (empty tracks, placeholder names, optionally verified colors, loop overruns), and
 *  - {@link planFixes} turns the issues the user chose into concrete {@link Fix}es.
 *
 * Both are deterministic and never mutate their inputs. The handler
 * (`handlers/set-janitor.ts`) builds the {@link SetDTO} from the bridge, calls these,
 * and writes the fixes back.
 *
 * Detected issue id scheme (stable, derived from kind + target so a UI can round-trip
 * a selection without a side table): `"<kind>:<opaque-reference>"`. Target type and
 * display ordinal are carried as fields, never decoded from the reference.
 */

import type { Fix, Issue, IssueId, IssueKind, SetClipDTO, SetDTO, SetTrackDTO } from '../dtos.js';
import type { ClipId, TrackId } from '../ids.js';

/**
 * A small legacy/reference color set retained for callers that explicitly choose it.
 *
 * This seven-color list is not an authoritative representation of Live's complete
 * palette and is never used implicitly. A caller may pass it, or another verified
 * allowed-color set, explicitly to {@link detectIssues} and {@link planFixes}.
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
 * `Bassline`, `Keys`, or `Loop` does NOT match.
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
 *  - **offPaletteColor** — only when an explicit verified palette is supplied, a
 *    clip whose `color` is absent from that palette.
 *  - **loopOverrun** — a looping clip whose `endMarker > loopEnd` ({@link isLoopOverrun}).
 *
 * @param set the whole Set as plain data.
 * @param allowedClipColors a caller-verified allowed-color set. Omit it to disable
 *   color diagnosis entirely, which is the safe default when Live's full palette is
 *   unavailable.
 */
export function detectIssues(set: SetDTO, allowedClipColors?: ReadonlySet<number>): Issue[] {
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

      if (
        allowedClipColors !== undefined &&
        allowedClipColors.size > 0 &&
        !allowedClipColors.has(clip.color)
      ) {
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
 *  - `loopOverrun` → `null`. The host exposes no writable loop-end/content-end
 *    operation for an existing clip, so a loop overrun cannot be trimmed. It is
 *    surfaced for the user to fix by hand and yields no automatic {@link Fix}.
 *    (`deleteClip` is reserved for a future explicit removal choice.)
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
 * Pick a deterministic color from an explicitly supplied verified palette. Prefer a
 * non-zero color, then verified zero. Missing or empty palettes yield no target so a
 * recolor can never be invented from incomplete knowledge.
 */
function paletteTargetColor(allowedClipColors?: ReadonlySet<number>): number | null {
  if (allowedClipColors === undefined) return null;
  for (const color of allowedClipColors) {
    if (color !== 0) {
      return color;
    }
  }
  return allowedClipColors.has(0) ? 0 : null;
}

/**
 * Turn the issues the user CHOSE (by {@link IssueId}) into the concrete {@link Fix}
 * list the handler applies. Only issues whose id is in `chosenIds` produce a fix, and
 * only issue kinds that have an automatic repair ({@link fixKindForIssue}) do; a
 * chosen `loopOverrun` is intentionally dropped (it has no auto-fix). Destructive
 * fixes (`deleteTrack` / `deleteClip`) carry no `value` and are thereby marked
 * distinctly from the value-carrying `rename` / `recolor` fixes, so the handler (and
 * a UI) can treat them with extra caution. Output order follows the input `issues`
 * order (which is the detect order).
 *
 * Pure: reads its inputs and returns a fresh array; never mutates them.
 *
 * @param issues the full issue list from {@link detectIssues}.
 * @param chosenIds the ids of the issues the user ticked to fix.
 * @param allowedClipColors the same caller-verified palette used for detection.
 *   Without it, selected color issues intentionally produce no recolor fix.
 */
export function planFixes(
  issues: readonly Issue[],
  chosenIds: readonly string[],
  allowedClipColors?: ReadonlySet<number>,
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
      case 'recolor': {
        const color = paletteTargetColor(allowedClipColors);
        if (color === null) {
          break;
        }
        fixes.push({
          kind,
          target: issue.target,
          targetKind: issue.targetKind,
          color,
        });
        break;
      }
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
