import { describe, expect, it } from 'vitest';
import type { SceneInfo } from '@othmanadi/loophole-core';
import { sceneIndexForReference, sceneReferenceForIndex } from './scene-selection.js';

function scenes(...ids: string[]): readonly Pick<SceneInfo, 'id'>[] {
  return ids.map((id) => ({ id: id as SceneInfo['id'] }));
}

function expectStale(action: () => unknown): void {
  try {
    action();
    expect.unreachable('expected a stale scene reference');
  } catch (error) {
    expect(error).toMatchObject({ code: 'STALE_REFERENCE' });
  }
}

function expectBadInput(action: () => unknown): void {
  try {
    action();
    expect.unreachable('expected invalid modal scene input');
  } catch (error) {
    expect(error).toMatchObject({ code: 'BAD_INPUT' });
  }
}

describe('sceneIndexForReference', () => {
  it('selects a non-first opaque scene reference by current enumeration identity', () => {
    const listed = scenes(
      'lhref_scn_aaaaaaaaaaaaaaaa',
      'lhref_scn_bbbbbbbbbbbbbbbb',
      'lhref_scn_cccccccccccccccc',
    );

    expect(sceneIndexForReference(listed, listed[2]!.id)).toBe(2);
  });

  it('fails closed for stale and unknown opaque scene references', () => {
    const listed = scenes('lhref_scn_aaaaaaaaaaaaaaaa', 'lhref_scn_bbbbbbbbbbbbbbbb');

    expectStale(() => sceneIndexForReference([], listed[1]!.id));
    expectStale(() =>
      sceneIndexForReference(listed, 'lhref_scn_cccccccccccccccc' as SceneInfo['id']),
    );
  });
});

describe('sceneReferenceForIndex', () => {
  it('binds a modal index to the matching reference from its opening snapshot', () => {
    const opening = scenes(
      'lhref_scn_aaaaaaaaaaaaaaaa',
      'lhref_scn_bbbbbbbbbbbbbbbb',
      'lhref_scn_cccccccccccccccc',
    );

    const selected = sceneReferenceForIndex(opening, 1);
    const afterReorder = [opening[2]!, opening[0]!, opening[1]!];

    expect(selected).toBe(opening[1]!.id);
    expect(sceneIndexForReference(afterReorder, selected)).toBe(2);
  });

  it('rejects malformed or out-of-snapshot modal indexes without a fallback scene', () => {
    const opening = scenes('lhref_scn_aaaaaaaaaaaaaaaa');

    expectBadInput(() => sceneReferenceForIndex(opening, -1));
    expectBadInput(() => sceneReferenceForIndex(opening, 1));
    expectBadInput(() => sceneReferenceForIndex(opening, 1.5));
  });
});
