import { describe, expect, it } from 'vitest';

import {
  ClipReference,
  ClipSlotReference,
  CuePointReference,
  DeviceReference,
  ParameterReference,
  SceneReference,
  TrackReference,
} from '../schemas/primitives.js';

const TOKEN = '0123456789abcdef';
const references = [
  ['track', TrackReference, `lhref_trk_${TOKEN}`],
  ['scene', SceneReference, `lhref_scn_${TOKEN}`],
  ['cue-point', CuePointReference, `lhref_cue_${TOKEN}`],
  ['clip-slot', ClipSlotReference, `lhref_slot_${TOKEN}`],
  ['clip', ClipReference, `lhref_clip_${TOKEN}`],
  ['device', DeviceReference, `lhref_dev_${TOKEN}`],
  ['parameter', ParameterReference, `lhref_param_${TOKEN}`],
] as const;

describe('opaque reference schemas', () => {
  it.each(references)('accepts only a valid %s reference', (_kind, schema, reference) => {
    expect(schema.safeParse(reference).success).toBe(true);
  });

  it.each(references)('rejects a positional locator for %s', (_kind, schema) => {
    expect(schema.safeParse('track:0/clipslot:0/clip').success).toBe(false);
  });

  it.each(references)(
    'rejects a differently tagged reference for %s',
    (_kind, schema, reference) => {
      const wrongReference = reference.startsWith('lhref_trk_')
        ? `lhref_clip_${TOKEN}`
        : `lhref_trk_${TOKEN}`;
      expect(schema.safeParse(wrongReference).success).toBe(false);
    },
  );
});
