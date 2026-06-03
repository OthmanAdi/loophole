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
 * a selection without a side table): `"<kind>:<target>"`, e.g.
 * `"emptyTrack:track:2"`, `"placeholderName:track:1"`, `"offPaletteColor:track:0/clipslot:0/clip"`.
 * The target segment is itself a path id, so the id reads as `kind` + `:` + the path.
 */

import type { Fix, Issue, IssueId, IssueKind, SetClipDTO, SetDTO, SetTrackDTO } from '../dtos.js';
import { parsePath, type PathId, type PathSegment } from '../ids.js';

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

/** Build a stable {@link IssueId} from an issue kind and its target path id. */
function issueId(kind: IssueKind, target: PathId): IssueId {
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

  for (const track of set.tracks) {
    if (isEmptyTrack(track)) {
      issues.push({
        id: issueId('emptyTrack', track.id),
        kind: 'emptyTrack',
        target: track.id,
        detail: `Track "${track.name}" is empty (no clips, no devices).`,
      });
    }

    if (isPlaceholderName(track.name)) {
      issues.push({
        id: issueId('placeholderName', track.id),
        kind: 'placeholderName',
        target: track.id,
        detail: `Track name "${track.name}" looks like a Live default.`,
      });
    }

    for (const clip of track.clips) {
      if (isPlaceholderName(clip.name)) {
        issues.push({
          id: issueId('placeholderName', clip.id),
          kind: 'placeholderName',
          target: clip.id,
          detail: `Clip name "${clip.name}" looks like a Live default.`,
        });
      }

      if (!palette.has(clip.color)) {
        issues.push({
          id: issueId('offPaletteColor', clip.id),
          kind: 'offPaletteColor',
          target: clip.id,
          detail: `Clip "${clip.name}" uses an off-palette color (${String(clip.color)}).`,
        });
      }

      if (isLoopOverrun(clip)) {
        issues.push({
          id: issueId('loopOverrun', clip.id),
          kind: 'loopOverrun',
          target: clip.id,
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
 * The proposed new name for a placeholder-named track or clip, derived from the
 * object's `target` path id (never from its current name), so the result is:
 *  - **deterministic** (the same target always yields the same name), and
 *  - **idempotent against the detector** — it is a `"Track N"` / `"Clip N"` label,
 *    which {@link PLACEHOLDER_NAME} does NOT match (that pattern only matches the
 *    `MIDI` / `Audio` Live defaults), so a second sweep does not re-flag the renamed
 *    object. (Normalising `1-MIDI` to `MIDI` would re-trip the rule; this does not.)
 *
 * `N` is the 1-based position taken from the path: a track id's track index, or a
 * clip id's clip-slot index (Session clips) / arrangement-clip index. Kept
 * deliberately plain: Janitor is the structural sweep, not a content-aware renamer
 * (03_EXTENSIONS_SPEC §5(d) defers descriptive naming to RNMR); it only replaces a
 * placeholder with a clean, intentional-looking label. Decoupled from the issue
 * `detail` text (which the DTO docs describe as editable UI prose), so the fix logic
 * does not depend on presentation strings.
 */
function suggestedName(target: PathId): string {
  const segments = parsePath(target);
  const leaf = segments[segments.length - 1];
  // A clip target ends in a `clip` segment: name it from the clip-slot index (Session
  // clip: track:N/clipslot:M/clip) or the arrangement clip index (track:N/clip:M).
  if (leaf?.kind === 'clip') {
    const slot = segments.find((s) => s.kind === 'clipslot');
    const index = indexOf(slot) ?? indexOf(leaf) ?? 0;
    return `Clip ${String(index + 1)}`;
  }
  // Otherwise it is a track target (track:N): name it from the track index.
  const index = indexOf(leaf) ?? 0;
  return `Track ${String(index + 1)}`;
}

/**
 * The `index` of a path segment, or `null` when the segment is index-less (a bare
 * terminal `clip` / `mixer` / `volume`) or absent. Keeps {@link suggestedName} from
 * reaching into a segment that has no `index` under `noUncheckedIndexedAccess`.
 */
function indexOf(segment: PathSegment | undefined): number | null {
  return segment !== undefined && 'index' in segment ? segment.index : null;
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
        fixes.push({ kind, target: issue.target, name: suggestedName(issue.target) });
        break;
      case 'recolor':
        fixes.push({ kind, target: issue.target, color: paletteTargetColor(palette) });
        break;
      case 'deleteTrack':
      case 'deleteClip':
        // Destructive: no value. The absent name/color is what marks a delete fix
        // distinctly from a rename/recolor.
        fixes.push({ kind, target: issue.target });
        break;
    }
  }

  return fixes;
}
