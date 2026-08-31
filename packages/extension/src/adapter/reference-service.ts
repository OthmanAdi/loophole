/**
 * Host-local opaque reference registry. SDK handles stay here: callers receive only a
 * bounded `lhref_*` token and every use re-resolves the live object before acting.
 */
import { randomBytes } from 'node:crypto';
import { isBridgeError, sdkRejected, staleReference, wrongType } from '@othmanadi/loophole-core';
import type {
  ClipId,
  ClipSlotId,
  CuePointId,
  DeviceId,
  ParamId,
  SceneId,
  TrackId,
} from '@othmanadi/loophole-core';
type ReferenceKind =
  'track' | 'scene' | 'cue-point' | 'clip-slot' | 'clip' | 'device' | 'parameter';
type AnyReference = TrackId | SceneId | CuePointId | ClipSlotId | ClipId | DeviceId | ParamId;
type Entry = {
  readonly kind: ReferenceKind;
  readonly fingerprint: bigint;
  /** Original SDK object instance; never exposed outside this host-local registry. */
  readonly object: HandleBacked;
  locator: readonly number[];
};
type HandleBacked = { readonly handle: { readonly id: bigint } };
type ClipSlotNode = HandleBacked & { readonly clip: HandleBacked | null };
type DeviceNode = HandleBacked & { readonly parameters: readonly HandleBacked[] };
type TrackNode = HandleBacked & {
  readonly clipSlots: readonly ClipSlotNode[];
  readonly arrangementClips: readonly HandleBacked[];
  readonly devices: readonly DeviceNode[];
  readonly mixer: { readonly volume: HandleBacked };
};
type SongNode = {
  readonly tracks: readonly TrackNode[];
  readonly scenes: readonly HandleBacked[];
  readonly cuePoints: readonly HandleBacked[];
};
type ReferenceContext = { readonly application: { readonly song: SongNode } };
type Located = { readonly object: HandleBacked; readonly locator: readonly number[] };

const PREFIX: Record<ReferenceKind, string> = {
  track: 'lhref_trk',
  scene: 'lhref_scn',
  'cue-point': 'lhref_cue',
  'clip-slot': 'lhref_slot',
  clip: 'lhref_clip',
  device: 'lhref_dev',
  parameter: 'lhref_param',
};
const MAX_REFERENCES = 4096;
const MAX_LIFETIME_ISSUANCES = 65_536;
const MAX_TOKEN_ATTEMPTS = 32;

export interface ReferenceServiceOptions {
  /** Active reference bound. Least-recently used entries are evicted first. */
  readonly maxEntries?: number;
  /** Session-lifetime bound, which also bounds the permanently retired token set. */
  readonly maxLifetimeIssuances?: number;
  /** Injectable source used by tests; returns only the unprefixed base64url token. */
  readonly nextToken?: () => string;
}

/**
 * A single instance belongs to the extension session and is shared by commands and the
 * MCP bridge. Entries are evicted LRU; issued tokens are permanently retired for the
 * extension session, so an old capability can never be replayed for a new object.
 */
export class ReferenceService {
  readonly #context: ReferenceContext;
  readonly #entries = new Map<string, Entry>();
  readonly #dedupe = new WeakMap<HandleBacked, Map<ReferenceKind, string>>();
  readonly #retiredTokens = new Set<string>();
  readonly #maxEntries: number;
  readonly #maxLifetimeIssuances: number;
  readonly #nextToken: () => string;
  #issuedCount = 0;

  constructor(context: ReferenceContext, options: ReferenceServiceOptions = {}) {
    this.#context = context;
    this.#maxEntries = options.maxEntries ?? MAX_REFERENCES;
    this.#maxLifetimeIssuances = options.maxLifetimeIssuances ?? MAX_LIFETIME_ISSUANCES;
    this.#nextToken = options.nextToken ?? (() => randomBytes(12).toString('base64url'));
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer.');
    }
    if (!Number.isInteger(this.#maxLifetimeIssuances) || this.#maxLifetimeIssuances < 1) {
      throw new RangeError('maxLifetimeIssuances must be a positive integer.');
    }
  }

  issueTrack(track: HandleBacked, index: number): TrackId {
    return this.#issue('track', track, [index]) as TrackId;
  }

  issueScene(scene: HandleBacked, index: number): SceneId {
    return this.#issue('scene', scene, [index]) as SceneId;
  }

  issueCuePoint(cue: HandleBacked, index: number): CuePointId {
    return this.#issue('cue-point', cue, [index]) as CuePointId;
  }

  issueClipSlot(slot: HandleBacked, track: number, index: number): ClipSlotId {
    return this.#issue('clip-slot', slot, [track, index]) as ClipSlotId;
  }

  issueClip(clip: HandleBacked, track: number, index: number): ClipId {
    return this.#issue('clip', clip, [track, index]) as ClipId;
  }

  issueDevice(device: HandleBacked, track: number, index: number): DeviceId {
    return this.#issue('device', device, [track, index]) as DeviceId;
  }

  issueParameter(param: HandleBacked, track: number, device: number, index: number): ParamId {
    return this.#issue('parameter', param, [track, device, index]) as ParamId;
  }

  issueMixerVolume(param: HandleBacked, track: number): ParamId {
    return this.#issue('parameter', param, [track, -1, 0]) as ParamId;
  }

  resolveTrack(ref: TrackId): HandleBacked {
    return this.#resolve(ref, 'track', () =>
      this.#context.application.song.tracks.map((object, index) => ({ object, locator: [index] })),
    );
  }

  resolveScene(ref: SceneId): HandleBacked {
    return this.#resolve(ref, 'scene', () =>
      this.#context.application.song.scenes.map((object, index) => ({ object, locator: [index] })),
    );
  }

  resolveCuePoint(ref: CuePointId): HandleBacked {
    return this.#resolve(ref, 'cue-point', () =>
      this.#context.application.song.cuePoints.map((object, index) => ({
        object,
        locator: [index],
      })),
    );
  }

  resolveClipSlot(ref: ClipSlotId): HandleBacked {
    return this.#resolve(ref, 'clip-slot', () =>
      this.#context.application.song.tracks.flatMap((track, trackIndex) =>
        track.clipSlots.map((object, slotIndex) => ({ object, locator: [trackIndex, slotIndex] })),
      ),
    );
  }

  resolveClip(ref: ClipId): HandleBacked {
    return this.#resolve(ref, 'clip', () =>
      this.#context.application.song.tracks.flatMap((track, trackIndex) => [
        ...track.clipSlots.flatMap((slot, slotIndex) =>
          slot.clip === null ? [] : [{ object: slot.clip, locator: [trackIndex, slotIndex, 0] }],
        ),
        ...track.arrangementClips.map((object, clipIndex) => ({
          object,
          locator: [trackIndex, clipIndex, 1],
        })),
      ]),
    );
  }

  resolveDevice(ref: DeviceId): HandleBacked {
    return this.#resolve(ref, 'device', () =>
      this.#context.application.song.tracks.flatMap((track, trackIndex) =>
        track.devices.map((object, deviceIndex) => ({
          object,
          locator: [trackIndex, deviceIndex],
        })),
      ),
    );
  }

  resolveParameter(ref: ParamId): HandleBacked {
    return this.#resolve(ref, 'parameter', () =>
      this.#context.application.song.tracks.flatMap((track, trackIndex) => [
        { object: track.mixer.volume, locator: [trackIndex, -1, 0] },
        ...track.devices.flatMap((device, deviceIndex) =>
          device.parameters.map((object, parameterIndex) => ({
            object,
            locator: [trackIndex, deviceIndex, parameterIndex],
          })),
        ),
      ]),
    );
  }

  #issue(kind: ReferenceKind, object: HandleBacked, locator: readonly number[]): AnyReference {
    let fingerprint: bigint;
    try {
      fingerprint = object.handle.id;
    } catch {
      throw sdkRejected(
        `Cannot issue a ${kind} reference because the host identity is unavailable.`,
        'Refresh the Live object list and retry.',
      );
    }
    const existing = this.#dedupe.get(object)?.get(kind);
    if (existing !== undefined) {
      const entry = this.#entries.get(existing);
      if (entry !== undefined && entry.fingerprint === fingerprint) {
        this.#touch(existing);
        return existing as AnyReference;
      }
      if (entry !== undefined) this.#remove(existing, entry);
    }
    if (this.#issuedCount >= this.#maxLifetimeIssuances) {
      throw sdkRejected(
        'Reference lifetime issuance limit reached. Reopen the extension to start a new session.',
      );
    }
    const token = this.#allocateToken(kind);
    this.#entries.set(token, { kind, fingerprint, object, locator });
    const byKind = this.#dedupe.get(object) ?? new Map<ReferenceKind, string>();
    byKind.set(kind, token);
    this.#dedupe.set(object, byKind);
    this.#retiredTokens.add(token);
    this.#issuedCount += 1;
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.entries().next().value;
      if (oldest !== undefined) {
        this.#remove(oldest[0], oldest[1]);
      }
    }
    return token as AnyReference;
  }

  #resolve(
    ref: string,
    expected: ReferenceKind,
    candidates: () => readonly Located[],
  ): HandleBacked {
    const entry = this.#entries.get(ref);
    if (entry === undefined) throw staleReference(ref);
    if (entry.kind !== expected) throw wrongType(ref, expected);
    try {
      const found = candidates().find(
        ({ object }) => object === entry.object && object.handle.id === entry.fingerprint,
      );
      if (found === undefined) {
        this.#remove(ref, entry);
        throw staleReference(ref);
      }
      // An object may be reordered. Its index locator is private, and is rebased only
      // after both the SDK object identity and its handle fingerprint prove this is
      // the same object. A future handle-id reuse cannot retarget the capability.
      entry.locator = found.locator;
      this.#touch(ref);
      return found.object;
    } catch (error) {
      if (isBridgeError(error)) throw error;
      this.#remove(ref, entry);
      throw staleReference(ref);
    }
  }

  #allocateToken(kind: ReferenceKind): string {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      const suffix = this.#nextToken();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(suffix)) {
        throw new RangeError('Reference token source returned an invalid token.');
      }
      const token = `${PREFIX[kind]}_${suffix}`;
      if (!this.#retiredTokens.has(token)) return token;
    }
    throw sdkRejected('Reference token source repeatedly produced a retired token.');
  }

  #touch(token: string): void {
    const entry = this.#entries.get(token);
    if (entry === undefined) return;
    this.#entries.delete(token);
    this.#entries.set(token, entry);
  }

  #remove(token: string, entry: Entry): void {
    this.#entries.delete(token);
    const byKind = this.#dedupe.get(entry.object);
    if (byKind?.get(entry.kind) === token) {
      byKind.delete(entry.kind);
      if (byKind.size === 0) this.#dedupe.delete(entry.object);
    }
  }
}
