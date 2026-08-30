import { describe, expect, it } from 'vitest';
import { ReferenceService, type ReferenceServiceOptions } from './reference-service.js';

type FakeNode = {
  readonly handle: { readonly id: bigint };
};

type FakeClipSlot = FakeNode & { clip: FakeNode | null };
type FakeDevice = FakeNode & { readonly parameters: FakeNode[] };
type FakeTrack = FakeNode & {
  readonly clipSlots: FakeClipSlot[];
  readonly arrangementClips: FakeNode[];
  readonly devices: FakeDevice[];
  readonly mixer: { volume: FakeNode };
};

type FakeContext = {
  readonly application: {
    readonly song: {
      readonly tracks: FakeTrack[];
      readonly scenes: FakeNode[];
      readonly cuePoints: FakeNode[];
    };
  };
};

function fakeNode(id: bigint): FakeNode {
  return { handle: { id } };
}

function fakeTrack(id: bigint): FakeTrack {
  return {
    handle: { id },
    clipSlots: [],
    arrangementClips: [],
    devices: [],
    mixer: { volume: fakeNode(id + 10_000n) },
  };
}

function fakeContext(
  tracks: FakeTrack[],
  scenes: FakeNode[] = [],
  cuePoints: FakeNode[] = [],
): FakeContext {
  return { application: { song: { tracks, scenes, cuePoints } } };
}

function tokens(...values: string[]): ReferenceServiceOptions {
  let index = 0;
  return { nextToken: () => values[index++] ?? values.at(-1)! };
}

function expectBridgeError(action: () => unknown, code: string): void {
  try {
    action();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
const D = 'dddddddddddddddd';

type IdentityFixture = {
  readonly original: FakeNode;
  readonly replacement: FakeNode;
  readonly issueOriginal: () => string;
  readonly issueReplacement: () => string;
  readonly resolve: (reference: string) => FakeNode;
  readonly reorder: () => void;
  readonly replace: () => void;
};

type IdentityCase = {
  readonly name: string;
  readonly create: () => IdentityFixture;
};

function topLevelFixture(kind: 'scene' | 'cue-point'): IdentityFixture {
  const original = fakeNode(101n);
  const other = fakeNode(102n);
  const replacement = fakeNode(101n);
  const values = [original, other];
  const context = kind === 'scene' ? fakeContext([], values, []) : fakeContext([], [], values);
  const references = new ReferenceService(context, tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () =>
      kind === 'scene'
        ? references.issueScene(original, values.indexOf(original))
        : references.issueCuePoint(original, values.indexOf(original)),
    issueReplacement: () =>
      kind === 'scene'
        ? references.issueScene(replacement, values.indexOf(original))
        : references.issueCuePoint(replacement, values.indexOf(original)),
    resolve: (reference) =>
      kind === 'scene'
        ? references.resolveScene(reference as never)
        : references.resolveCuePoint(reference as never),
    reorder: () => values.reverse(),
    replace: () => values.splice(values.indexOf(original), 1, replacement),
  };
}

function clipSlotFixture(): IdentityFixture {
  const original: FakeClipSlot = { ...fakeNode(201n), clip: null };
  const other: FakeClipSlot = { ...fakeNode(202n), clip: null };
  const replacement: FakeClipSlot = { ...fakeNode(201n), clip: null };
  const track = fakeTrack(1n);
  track.clipSlots.push(original, other);
  const references = new ReferenceService(fakeContext([track]), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () => references.issueClipSlot(original, 0, track.clipSlots.indexOf(original)),
    issueReplacement: () =>
      references.issueClipSlot(replacement, 0, track.clipSlots.indexOf(original)),
    resolve: (reference) => references.resolveClipSlot(reference as never),
    reorder: () => track.clipSlots.reverse(),
    replace: () => track.clipSlots.splice(track.clipSlots.indexOf(original), 1, replacement),
  };
}

function sessionClipFixture(): IdentityFixture {
  const original = fakeNode(301n);
  const other = fakeNode(302n);
  const replacement = fakeNode(301n);
  const originalSlot: FakeClipSlot = { ...fakeNode(401n), clip: original };
  const otherSlot: FakeClipSlot = { ...fakeNode(402n), clip: other };
  const track = fakeTrack(1n);
  track.clipSlots.push(originalSlot, otherSlot);
  const references = new ReferenceService(fakeContext([track]), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () => references.issueClip(original, 0, track.clipSlots.indexOf(originalSlot)),
    issueReplacement: () =>
      references.issueClip(replacement, 0, track.clipSlots.indexOf(originalSlot)),
    resolve: (reference) => references.resolveClip(reference as never),
    reorder: () => track.clipSlots.reverse(),
    replace: () => {
      originalSlot.clip = replacement;
    },
  };
}

function arrangementClipFixture(): IdentityFixture {
  const original = fakeNode(501n);
  const other = fakeNode(502n);
  const replacement = fakeNode(501n);
  const track = fakeTrack(1n);
  track.arrangementClips.push(original, other);
  const references = new ReferenceService(fakeContext([track]), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () =>
      references.issueClip(original, 0, track.arrangementClips.indexOf(original)),
    issueReplacement: () =>
      references.issueClip(replacement, 0, track.arrangementClips.indexOf(original)),
    resolve: (reference) => references.resolveClip(reference as never),
    reorder: () => track.arrangementClips.reverse(),
    replace: () =>
      track.arrangementClips.splice(track.arrangementClips.indexOf(original), 1, replacement),
  };
}

function deviceFixture(): IdentityFixture {
  const original: FakeDevice = { ...fakeNode(601n), parameters: [] };
  const other: FakeDevice = { ...fakeNode(602n), parameters: [] };
  const replacement: FakeDevice = { ...fakeNode(601n), parameters: [] };
  const track = fakeTrack(1n);
  track.devices.push(original, other);
  const references = new ReferenceService(fakeContext([track]), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () => references.issueDevice(original, 0, track.devices.indexOf(original)),
    issueReplacement: () => references.issueDevice(replacement, 0, track.devices.indexOf(original)),
    resolve: (reference) => references.resolveDevice(reference as never),
    reorder: () => track.devices.reverse(),
    replace: () => track.devices.splice(track.devices.indexOf(original), 1, replacement),
  };
}

function ordinaryParameterFixture(): IdentityFixture {
  const original = fakeNode(701n);
  const other = fakeNode(702n);
  const replacement = fakeNode(701n);
  const device: FakeDevice = { ...fakeNode(601n), parameters: [original, other] };
  const track = fakeTrack(1n);
  track.devices.push(device);
  const references = new ReferenceService(fakeContext([track]), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () =>
      references.issueParameter(original, 0, 0, device.parameters.indexOf(original)),
    issueReplacement: () =>
      references.issueParameter(replacement, 0, 0, device.parameters.indexOf(original)),
    resolve: (reference) => references.resolveParameter(reference as never),
    reorder: () => device.parameters.reverse(),
    replace: () => device.parameters.splice(device.parameters.indexOf(original), 1, replacement),
  };
}

function mixerParameterFixture(): IdentityFixture {
  const original = fakeNode(801n);
  const replacement = fakeNode(801n);
  const firstTrack = fakeTrack(1n);
  const secondTrack = fakeTrack(2n);
  firstTrack.mixer.volume = original;
  const tracks = [firstTrack, secondTrack];
  const references = new ReferenceService(fakeContext(tracks), tokens(A, B));
  return {
    original,
    replacement,
    issueOriginal: () => references.issueMixerVolume(original, tracks.indexOf(firstTrack)),
    issueReplacement: () => references.issueMixerVolume(replacement, tracks.indexOf(firstTrack)),
    resolve: (reference) => references.resolveParameter(reference as never),
    reorder: () => tracks.reverse(),
    replace: () => {
      firstTrack.mixer.volume = replacement;
    },
  };
}

const identityCases: readonly IdentityCase[] = [
  { name: 'scene', create: () => topLevelFixture('scene') },
  { name: 'cue point', create: () => topLevelFixture('cue-point') },
  { name: 'clip slot', create: clipSlotFixture },
  { name: 'session clip', create: sessionClipFixture },
  { name: 'arrangement clip', create: arrangementClipFixture },
  { name: 'device', create: deviceFixture },
  { name: 'ordinary parameter', create: ordinaryParameterFixture },
  { name: 'mixer parameter', create: mixerParameterFixture },
];

describe('ReferenceService', () => {
  it('issues bounded opaque references and deduplicates the same host identity', () => {
    const track = fakeTrack(41n);
    const references = new ReferenceService(fakeContext([track]), tokens(A));

    const first = references.issueTrack(track, 0);
    const second = references.issueTrack(track, 0);

    expect(first).toBe(second);
    expect(first).toBe(`lhref_trk_${A}`);
  });

  it('does not deduplicate distinct SDK objects that reuse the same handle id', () => {
    const original = fakeTrack(41n);
    const replacement = fakeTrack(41n);
    const references = new ReferenceService(fakeContext([original, replacement]), tokens(A, B));

    const originalRef = references.issueTrack(original, 0);
    const replacementRef = references.issueTrack(replacement, 1);

    expect(originalRef).toBe(`lhref_trk_${A}`);
    expect(replacementRef).toBe(`lhref_trk_${B}`);
    expect(replacementRef).not.toBe(originalRef);
  });

  it('touches deduplicated issue and successful resolution for LRU eviction', () => {
    const first = fakeTrack(41n);
    const second = fakeTrack(42n);
    const third = fakeTrack(43n);
    const references = new ReferenceService(fakeContext([first, second, third]), {
      maxEntries: 2,
      ...tokens(A, B, C),
    });
    const firstRef = references.issueTrack(first, 0);
    const secondRef = references.issueTrack(second, 1);

    expect(references.issueTrack(first, 0)).toBe(firstRef);
    references.issueTrack(third, 2);

    expectBridgeError(() => references.resolveTrack(secondRef), 'STALE_REFERENCE');
    expect(references.resolveTrack(firstRef)).toBe(first);
  });

  it('never reissues an evicted token and bounds lifetime issuance', () => {
    const first = fakeTrack(41n);
    const second = fakeTrack(42n);
    const references = new ReferenceService(fakeContext([first, second]), {
      maxEntries: 1,
      maxLifetimeIssuances: 2,
      ...tokens(A, A, B),
    });
    const firstRef = references.issueTrack(first, 0);
    const secondRef = references.issueTrack(second, 1);

    expect(secondRef).toBe(`lhref_trk_${B}`);
    expectBridgeError(() => references.resolveTrack(firstRef), 'STALE_REFERENCE');
    expectBridgeError(() => references.issueTrack(first, 0), 'SDK_REJECTED');
  });

  it('rejects malformed, unknown, and wrong-kind references', () => {
    const track = fakeTrack(41n);
    const references = new ReferenceService(fakeContext([track]), tokens(A));
    const reference = references.issueTrack(track, 0);

    expectBridgeError(() => references.resolveTrack('not-a-reference' as never), 'STALE_REFERENCE');
    expectBridgeError(() => references.resolveTrack(`lhref_trk_${D}` as never), 'STALE_REFERENCE');
    expectBridgeError(() => references.resolveScene(reference as never), 'WRONG_TYPE');
  });

  it('marks deletion or same-position replacement stale, without positional fallback', () => {
    const original = fakeTrack(41n);
    const replacement = fakeTrack(42n);
    const tracks = [original];
    const references = new ReferenceService(fakeContext(tracks), tokens(A));
    const reference = references.issueTrack(original, 0);

    tracks.splice(0, 1, replacement);

    expectBridgeError(() => references.resolveTrack(reference), 'STALE_REFERENCE');
  });

  it('marks a replacement SDK object stale even when it reuses the same handle id', () => {
    const original = fakeTrack(41n);
    const replacement = fakeTrack(41n);
    const tracks = [original];
    const references = new ReferenceService(fakeContext(tracks), tokens(A));
    const reference = references.issueTrack(original, 0);

    tracks.splice(0, 1, replacement);

    expectBridgeError(() => references.resolveTrack(reference), 'STALE_REFERENCE');
  });

  it('rebases a reordered object only after matching its host identity', () => {
    const first = fakeTrack(41n);
    const second = fakeTrack(42n);
    const tracks = [first, second];
    const references = new ReferenceService(fakeContext(tracks), tokens(A));
    const reference = references.issueTrack(first, 0);

    tracks.reverse();

    expect(references.resolveTrack(reference)).toBe(first);
  });

  it('fails closed when a raw SDK getter error has a code-shaped property', () => {
    const track = fakeTrack(41n);
    const context = fakeContext([track]) as {
      application: { song: { tracks: FakeTrack[]; scenes: unknown[]; cuePoints: unknown[] } };
    };
    const references = new ReferenceService(context as never, tokens(A));
    const reference = references.issueTrack(track, 0);
    Object.defineProperty(context.application.song, 'tracks', {
      configurable: true,
      get: () => {
        throw Object.assign(new Error('raw SDK failure'), { code: 'WRONG_TYPE' });
      },
    });

    expectBridgeError(() => references.resolveTrack(reference), 'STALE_REFERENCE');
    expectBridgeError(() => references.resolveTrack(reference), 'STALE_REFERENCE');
  });

  it('fails typed and issues nothing when the SDK identity getter throws', () => {
    const unavailable = fakeTrack(41n);
    const available = fakeTrack(42n);
    Object.defineProperty(unavailable, 'handle', {
      configurable: true,
      get: () => {
        throw new Error('raw SDK identity failure');
      },
    });
    const references = new ReferenceService(fakeContext([unavailable, available]), tokens(A));

    expectBridgeError(() => references.issueTrack(unavailable, 0), 'SDK_REJECTED');
    expect(references.issueTrack(available, 1)).toBe(`lhref_trk_${A}`);
  });
});

describe('ReferenceService candidate collectors', () => {
  for (const identityCase of identityCases) {
    describe(identityCase.name, () => {
      it('deduplicates only the exact SDK object instance', () => {
        const fixture = identityCase.create();

        const first = fixture.issueOriginal();
        expect(fixture.issueOriginal()).toBe(first);
        expect(fixture.issueReplacement()).not.toBe(first);
      });

      it('resolves the same SDK object after reorder', () => {
        const fixture = identityCase.create();
        const reference = fixture.issueOriginal();

        fixture.reorder();

        expect(fixture.resolve(reference)).toBe(fixture.original);
      });

      it('fails stale for a replacement object that reuses the handle id', () => {
        const fixture = identityCase.create();
        const reference = fixture.issueOriginal();

        fixture.replace();

        expectBridgeError(() => fixture.resolve(reference), 'STALE_REFERENCE');
      });
    });
  }
});
