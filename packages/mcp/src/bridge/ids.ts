/**
 * Stable, human-readable path ids for Live Object Model objects.
 *
 * The real Ableton Extensions SDK addresses objects by `Handle` (`{ id: bigint }`),
 * an opaque host-local ref that is not stable across sessions and must never be
 * constructed by us or serialized across a wire (see API_REFERENCE.md). The bridge
 * therefore speaks string path ids like `"track:2"`, `"track:2/clipslot:4"`, or
 * `"track:2/clip"`, and an adapter (wave W4) keeps the `Map<PathId, Handle>` privately.
 *
 * A path id is a `/`-joined chain of `kind:index` segments. The `clip` kind has two
 * legal forms: a bare terminal `clip` (the single clip inside a clip slot, reached
 * through its parent slot rather than by an index of its own) and an indexed
 * `clip:M` (an arrangement clip addressed by its position in the track's
 * `arrangementClips` array). These ids are:
 *  - stable enough to re-resolve to a fresh handle on every call,
 *  - safe to send to an LLM and to JSON-serialize,
 *  - parseable back into a typed structure for routing.
 *
 * Handles (`bigint`) are an internal adapter detail and NEVER appear in these types.
 */

/** Object kinds that always carry an index segment in a path id. */
export type IndexedSegmentKind =
  | 'track'
  | 'returntrack'
  | 'clipslot'
  | 'scene'
  | 'cuepoint'
  | 'device'
  | 'param'
  | 'takelane';

/**
 * The `clip` kind is special: a bare `clip` addresses the clip inside a clip slot,
 * while `clip:M` addresses the arrangement clip at array index `M`.
 */
export type ClipSegmentKind = 'clip';

/** Every segment kind a path id may contain. */
export type SegmentKind = IndexedSegmentKind | ClipSegmentKind;

/**
 * One parsed segment of a path id.
 *
 * `index` is present for {@link IndexedSegmentKind} segments and for an indexed
 * arrangement `clip:M`; it is absent for a bare terminal `clip`. Because
 * `exactOptionalPropertyTypes` is on, "absent" is modeled by leaving the property
 * off the object rather than assigning `undefined`.
 */
export type PathSegment =
  | { readonly kind: IndexedSegmentKind; readonly index: number }
  | { readonly kind: ClipSegmentKind; readonly index: number }
  | { readonly kind: ClipSegmentKind };

/**
 * A path id is just a branded string. The brand stops a raw `string` from being
 * passed where a validated id is expected without going through {@link makePathId}
 * or {@link buildPath}.
 */
export type PathId = string & { readonly __brand: 'PathId' };

/** Convenience aliases used by the DTOs and the port for call-site readability. */
export type TrackId = PathId;
export type ClipId = PathId;
export type ClipSlotId = PathId;
export type SceneId = PathId;
export type DeviceId = PathId;
export type ParamId = PathId;
export type CuePointId = PathId;

const SEGMENT_SEPARATOR = '/';
const KIND_INDEX_SEPARATOR = ':';

const INDEXED_KINDS: ReadonlySet<string> = new Set<IndexedSegmentKind>([
  'track',
  'returntrack',
  'clipslot',
  'scene',
  'cuepoint',
  'device',
  'param',
  'takelane',
]);

function isIndexedKind(value: string): value is IndexedSegmentKind {
  return INDEXED_KINDS.has(value);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Thrown when a string cannot be parsed into a valid {@link PathId}. */
export class PathIdParseError extends Error {
  override readonly name = 'PathIdParseError';
  constructor(
    readonly input: string,
    detail: string,
  ) {
    super(`Invalid path id "${input}": ${detail}`);
  }
}

/** True when a parsed segment carries an `index` property. */
function hasIndex(segment: PathSegment): segment is Extract<PathSegment, { index: number }> {
  return 'index' in segment;
}

/**
 * Render a single segment to its `kind:index` (or bare `kind`) string form.
 */
function renderSegment(segment: PathSegment): string {
  if (!hasIndex(segment)) {
    return segment.kind;
  }
  return `${segment.kind}${KIND_INDEX_SEPARATOR}${String(segment.index)}`;
}

/**
 * Parse a single segment string. Returns `null` on any malformed segment so the
 * caller can produce one error mentioning the whole input.
 */
function parseSegment(raw: string): PathSegment | null {
  if (raw === 'clip') {
    return { kind: 'clip' };
  }
  const sep = raw.indexOf(KIND_INDEX_SEPARATOR);
  if (sep <= 0 || sep === raw.length - 1) {
    return null;
  }
  const kind = raw.slice(0, sep);
  const indexPart = raw.slice(sep + 1);
  // Reject anything that is not a plain non-negative integer literal
  // (e.g. "1.5", "-1", "0x1", " 2 "; a leading-zero "01" is rejected too).
  if (!/^(0|[1-9]\d*)$/.test(indexPart)) {
    return null;
  }
  const index = Number(indexPart);
  if (!isNonNegativeInteger(index)) {
    return null;
  }
  if (kind === 'clip') {
    return { kind, index };
  }
  if (!isIndexedKind(kind)) {
    return null;
  }
  return { kind, index };
}

/**
 * Build a {@link PathId} from an ordered list of segments. This is the only
 * blessed way (besides {@link makePathId}) to produce a `PathId`, so every id in
 * the system is well-formed by construction.
 *
 * @throws {PathIdParseError} if the segment list is empty or a segment is invalid.
 */
export function buildPath(segments: readonly PathSegment[]): PathId {
  if (segments.length === 0) {
    throw new PathIdParseError('', 'a path id must have at least one segment');
  }
  for (const segment of segments) {
    if (hasIndex(segment) && !isNonNegativeInteger(segment.index)) {
      throw new PathIdParseError(
        renderSegments(segments),
        `segment "${segment.kind}" needs a non-negative integer index`,
      );
    }
  }
  return renderSegments(segments) as PathId;
}

function renderSegments(segments: readonly PathSegment[]): string {
  return segments.map(renderSegment).join(SEGMENT_SEPARATOR);
}

/**
 * Parse a raw string into its typed segments. Use this for routing a call to the
 * right object kind.
 *
 * @throws {PathIdParseError} if any segment is malformed.
 */
export function parsePath(id: string): readonly PathSegment[] {
  if (id.length === 0) {
    throw new PathIdParseError(id, 'empty string is not a path id');
  }
  const rawSegments = id.split(SEGMENT_SEPARATOR);
  const segments: PathSegment[] = [];
  for (const raw of rawSegments) {
    const segment = parseSegment(raw);
    if (segment === null) {
      throw new PathIdParseError(id, `malformed segment "${raw}"`);
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Validate a raw string and brand it as a {@link PathId}. Cheaper than
 * {@link parsePath} when you only need the branded value, not the segments.
 *
 * @throws {PathIdParseError} if the string is not a valid path id.
 */
export function makePathId(id: string): PathId {
  parsePath(id);
  return id as PathId;
}

/** Returns the parsed segments if `id` is valid, otherwise `null` (no throw). */
export function tryParsePath(id: string): readonly PathSegment[] | null {
  try {
    return parsePath(id);
  } catch {
    return null;
  }
}

/** The last segment of a path id, useful for dispatching on the leaf object kind. */
export function leafSegment(id: PathId): PathSegment {
  const segments = parsePath(id);
  // parsePath guarantees at least one segment for any value it returns,
  // and a PathId is always non-empty, so the last element exists.
  const last = segments[segments.length - 1];
  if (last === undefined) {
    throw new PathIdParseError(id, 'path id had no segments');
  }
  return last;
}

/** The leaf object kind of a path id (`"track"`, `"clip"`, ...). */
export function leafKind(id: PathId): SegmentKind {
  return leafSegment(id).kind;
}

// --- typed builders for the kinds the W0 port actually uses ---

/** Build a track id, e.g. `track:2`. */
export function trackId(index: number): TrackId {
  return buildPath([{ kind: 'track', index }]);
}

/** Build a return-track id, e.g. `returntrack:0`. */
export function returnTrackId(index: number): TrackId {
  return buildPath([{ kind: 'returntrack', index }]);
}

/** Build a clip-slot id under a track, e.g. `track:2/clipslot:4`. */
export function clipSlotId(track: number, slot: number): ClipSlotId {
  return buildPath([
    { kind: 'track', index: track },
    { kind: 'clipslot', index: slot },
  ]);
}

/** Build the id of the clip held by a clip slot, e.g. `track:2/clipslot:4/clip`. */
export function sessionClipId(track: number, slot: number): ClipId {
  return buildPath([
    { kind: 'track', index: track },
    { kind: 'clipslot', index: slot },
    { kind: 'clip' },
  ]);
}

/**
 * Build the id of an arrangement clip on a track by its position in that track's
 * `arrangementClips` array, e.g. `track:2/clip:0`.
 *
 * The SDK exposes arrangement clips as an array on the track, so we address them
 * by array index using an indexed `clip:M` segment. The bare terminal `clip`
 * segment is reserved for the single clip inside a clip slot.
 */
export function arrangementClipId(track: number, clipIndex: number): ClipId {
  return buildPath([
    { kind: 'track', index: track },
    { kind: 'clip', index: clipIndex },
  ]);
}

/** Build a scene id, e.g. `scene:1`. */
export function sceneId(index: number): SceneId {
  return buildPath([{ kind: 'scene', index }]);
}

/** Build a cue-point id, e.g. `cuepoint:0`. */
export function cuePointId(index: number): CuePointId {
  return buildPath([{ kind: 'cuepoint', index }]);
}

/** Build a device id under a track, e.g. `track:2/device:0`. */
export function deviceId(track: number, device: number): DeviceId {
  return buildPath([
    { kind: 'track', index: track },
    { kind: 'device', index: device },
  ]);
}

/** Build a device-parameter id, e.g. `track:2/device:0/param:3`. */
export function paramId(track: number, device: number, param: number): ParamId {
  return buildPath([
    { kind: 'track', index: track },
    { kind: 'device', index: device },
    { kind: 'param', index: param },
  ]);
}
