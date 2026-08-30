import { describe, expect, it, vi } from 'vitest';
import type { HumanizeOpts, SnapMode } from '@othmanadi/loophole-core';
import {
  authorizeSetJanitorSelection,
  dispatchSetJanitorModal,
  dispatchValidatedModal,
  parseValidatedModal,
  validateHumanizeModal,
  validateScaleLockModal,
  validateSessionToSongModal,
  validateSetJanitorModal,
  type ValidatedSectionInput,
} from './modal-validation.js';
import { parseModalResult } from './support.js';

const validHumanize = {
  strength: 0.5,
  swing: 0.25,
  doTiming: true,
  doVelocity: false,
  doDuration: true,
  living: false,
};

describe('shared modal parsing', () => {
  it('keeps valid JSON unknown-shaped until a validator accepts it', () => {
    expect(parseModalResult('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseValidatedModal(JSON.stringify(validHumanize), validateHumanizeModal)).toEqual(
      validHumanize,
    );
  });

  it.each(['', '{', 'NaN', 'Infinity'])('treats malformed JSON %j as cancel', (raw) => {
    expect(parseModalResult(raw)).toBeNull();
  });

  it('never dispatches a malformed payload to a command handler', async () => {
    const humanize = vi.fn(async (_opts: HumanizeOpts): Promise<void> => undefined);
    const scaleLock = vi.fn(async (_mode: SnapMode): Promise<void> => undefined);
    const sessionToSong = vi.fn(
      async (_sections: readonly ValidatedSectionInput[]): Promise<void> => undefined,
    );
    const setJanitor = vi.fn(async (_issueIds: readonly string[]): Promise<void> => undefined);

    await expect(dispatchValidatedModal('[]', validateHumanizeModal, humanize)).resolves.toBe(
      false,
    );
    await expect(dispatchValidatedModal('{}', validateHumanizeModal, humanize)).resolves.toBe(
      false,
    );
    await expect(
      dispatchValidatedModal('{"strength":null}', validateHumanizeModal, humanize),
    ).resolves.toBe(false);
    await expect(
      dispatchValidatedModal('{"mode":"sideways"}', validateScaleLockModal, scaleLock),
    ).resolves.toBe(false);
    await expect(
      dispatchValidatedModal(
        '{"sections":[{"name":"A","sceneIndex":0,"bars":null}]}',
        validateSessionToSongModal,
        sessionToSong,
      ),
    ).resolves.toBe(false);
    await expect(
      dispatchValidatedModal('{"chosenIssueIds":[42]}', validateSetJanitorModal, setJanitor),
    ).resolves.toBe(false);

    expect(humanize).not.toHaveBeenCalled();
    expect(scaleLock).not.toHaveBeenCalled();
    expect(sessionToSong).not.toHaveBeenCalled();
    expect(setJanitor).not.toHaveBeenCalled();
  });

  it('dispatches one copied, validated payload exactly once', async () => {
    const apply = vi.fn(async (_opts: HumanizeOpts): Promise<void> => undefined);
    await expect(
      dispatchValidatedModal(JSON.stringify(validHumanize), validateHumanizeModal, apply),
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(validHumanize);
  });
});

describe('Humanize modal validation', () => {
  it('accepts exact apply payloads, including numeric boundaries', () => {
    expect(validateHumanizeModal(validHumanize)).toEqual(validHumanize);
    expect(validateHumanizeModal({ ...validHumanize, strength: 0, swing: 1 })).toEqual({
      ...validHumanize,
      strength: 0,
      swing: 1,
    });
  });

  it.each([
    null,
    [],
    'payload',
    {},
    { strength: null, extra: true },
    { ...validHumanize, strength: Number.NaN },
    { ...validHumanize, strength: Number.POSITIVE_INFINITY },
    { ...validHumanize, strength: -0.01 },
    { ...validHumanize, swing: 1.01 },
    { ...validHumanize, doTiming: 1 },
    { ...validHumanize, living: 'false' },
    { ...validHumanize, extra: true },
  ])('rejects adversarial apply payload %#', (value) => {
    expect(validateHumanizeModal(value)).toBeNull();
  });

  it('rejects inherited, null-prototype, poison-key, and throwing payloads', () => {
    const inherited = Object.create(validHumanize);
    const nullPrototype = Object.assign(Object.create(null), validHumanize);
    const poisonKey = JSON.parse(`{"__proto__":{},${JSON.stringify(validHumanize).slice(1)}`);
    const symbolKey = { ...validHumanize, [Symbol('extra')]: true };
    const throwing = new Proxy(validHumanize, {
      get: () => {
        throw new Error('getter trap');
      },
    });

    expect(validateHumanizeModal(inherited)).toBeNull();
    expect(validateHumanizeModal(nullPrototype)).toBeNull();
    expect(validateHumanizeModal(poisonKey)).toBeNull();
    expect(validateHumanizeModal(symbolKey)).toBeNull();
    expect(validateHumanizeModal(throwing)).toBeNull();
  });
});

describe('Scale Lock modal validation', () => {
  it.each(['up', 'down', 'nearest'] as const)('accepts the exact %s snap mode', (mode) => {
    expect(validateScaleLockModal({ mode })).toBe(mode);
  });

  it.each([
    null,
    [],
    {},
    { mode: null },
    { mode: 'nearest', extra: false },
    { mode: 'nearest ' },
    { mode: true },
  ])('cancels or rejects invalid scale payload %#', (value) => {
    expect(validateScaleLockModal(value)).toBeNull();
  });

  it('rejects a mode inherited through the prototype', () => {
    expect(validateScaleLockModal(Object.create({ mode: 'nearest' }))).toBeNull();
  });
});

describe('Session-to-Song modal validation', () => {
  it('copies exact section rows with optional color', () => {
    const payload = {
      sections: [
        { name: 'Intro', sceneIndex: 0, bars: 8 },
        { name: 'Verse', sceneIndex: 1, bars: 16, color: 4 },
      ],
    };
    const validated = validateSessionToSongModal(payload);

    expect(validated).toEqual(payload.sections);
    expect(validated).not.toBe(payload.sections);
  });

  it.each([
    null,
    [],
    {},
    { sections: null },
    { sections: {} },
    { sections: [{ name: 'A', sceneIndex: 0, bars: Number.NaN }] },
    { sections: [{ name: 'A', sceneIndex: 0, bars: Number.POSITIVE_INFINITY }] },
    { sections: [{ name: 'A', sceneIndex: 0.5, bars: 4 }] },
    { sections: [{ name: 'A', sceneIndex: -1, bars: 4 }] },
    { sections: [{ name: 'A', sceneIndex: 0, bars: 0 }] },
    { sections: [{ name: 'A', sceneIndex: 0, bars: 4, color: Number.NaN }] },
    { sections: [{ name: 'A', sceneIndex: 0, bars: 4, extra: true }] },
    { sections: [], extra: true },
  ])('cancels or rejects invalid section payload %#', (value) => {
    expect(validateSessionToSongModal(value)).toBeNull();
  });

  it('rejects a section row with a custom prototype', () => {
    const inherited = Object.create({ name: 'A', sceneIndex: 0, bars: 4 });
    expect(validateSessionToSongModal({ sections: [inherited] })).toBeNull();
  });
});

describe('Set Janitor modal validation', () => {
  it('copies an exact string selection and preserves an empty valid selection', () => {
    const chosenIssueIds = ['rename:track', 'deleteClip:clip'];
    const validated = validateSetJanitorModal({ chosenIssueIds });
    expect(validated).toEqual(chosenIssueIds);
    expect(validated).not.toBe(chosenIssueIds);
    expect(validateSetJanitorModal({ chosenIssueIds: [] })).toEqual([]);
  });

  it.each([
    null,
    [],
    {},
    { chosenIssueIds: null },
    { chosenIssueIds: 'rename:track' },
    { chosenIssueIds: ['valid', 42] },
    { chosenIssueIds: [], extra: true },
  ])('cancels or rejects invalid issue selection %#', (value) => {
    expect(validateSetJanitorModal(value)).toBeNull();
  });

  it('rejects inherited issue selections', () => {
    expect(validateSetJanitorModal(Object.create({ chosenIssueIds: ['issue'] }))).toBeNull();
  });

  it.each([['forged'], ['rename:track', 'rename:track'], ['rename:track', 'forged']])(
    'rejects forged or duplicate snapshot selections %#',
    (chosenIssueIds) => {
      expect(
        authorizeSetJanitorSelection(chosenIssueIds, ['rename:track', 'deleteClip:clip']),
      ).toBeNull();
    },
  );

  it('does not dispatch forged, duplicate, or mixed-invalid selections', async () => {
    const apply = vi.fn(async (_issueIds: readonly string[]): Promise<void> => undefined);
    const rendered = ['rename:track', 'deleteClip:clip'];
    for (const chosenIssueIds of [
      ['forged'],
      ['rename:track', 'rename:track'],
      ['rename:track', 'forged'],
    ]) {
      await expect(
        dispatchSetJanitorModal(JSON.stringify({ chosenIssueIds }), rendered, apply),
      ).resolves.toBe(false);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('dispatches one unique selection bound to the rendered issue snapshot', async () => {
    const apply = vi.fn(async (_issueIds: readonly string[]): Promise<void> => undefined);
    await expect(
      dispatchSetJanitorModal(
        JSON.stringify({ chosenIssueIds: ['deleteClip:clip', 'rename:track'] }),
        ['rename:track', 'deleteClip:clip'],
        apply,
      ),
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(['deleteClip:clip', 'rename:track']);
  });
});
