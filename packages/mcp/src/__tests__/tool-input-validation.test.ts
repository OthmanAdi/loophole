/**
 * Ring 1 (unit) — every tool's Zod input REJECT path.
 *
 * The first line of the error model (02_BRIDGE_SPEC §7, §8): a malformed argument
 * must be rejected by the tool's Zod schema BEFORE the handler ever runs, so a bad
 * call is a clean validation failure, not a stack trace. Over the MCP wire the SDK
 * parses `args` against this same schema and turns a failure into a clean
 * `isError: true` "Input validation error" result (asserted in the integration
 * ring); here we assert the schema layer directly, which is where the rejection is
 * decided.
 *
 * The cases are driven off `collectTools()`, so EVERY one of the 12 tools is
 * covered by construction: each entry below is matched to a real tool by name, the
 * test fails if a tool is missing a case, and each tool's `inputSchema` must accept
 * its `valid` sample and reject every `invalid` sample. A Zod rejection has no
 * BridgeError `code` (that is the bridge layer's surface, tested separately); the
 * claim here is purely `safeParse(...).success === false`.
 */

import { describe, expect, it } from 'vitest';

import { collectTools } from '../tools/index.js';
import type { ToolModule } from '../tools/registry.js';

/** A valid argument sample plus the malformed samples the schema must reject. */
interface ToolInputCase {
  readonly valid: unknown;
  readonly invalid: readonly {
    readonly label: string;
    readonly args: unknown;
    readonly expectedPath?: readonly (string | number)[];
  }[];
}

const TRACK_REFERENCE = 'lhref_trk_0123456789abcdef';
const CLIP_REFERENCE = 'lhref_clip_0123456789abcdef';
const CLIP_SLOT_REFERENCE = 'lhref_slot_0123456789abcdef';
const PARAMETER_REFERENCE = 'lhref_param_0123456789abcdef';

/**
 * One case per tool, keyed by tool name. Every tool in `collectTools()` must have
 * an entry (asserted below), and every `invalid` sample must be rejected by the
 * tool's `.strict()` Zod schema.
 */
const CASES: Readonly<Record<string, ToolInputCase>> = {
  // --- reads ---
  live_get_song_overview: {
    valid: {},
    invalid: [{ label: 'an unknown key (strict)', args: { foo: 1 } }],
  },
  live_find_track: {
    valid: { query: 'bass' },
    invalid: [
      { label: 'an empty query string', args: { query: '' } },
      { label: 'a non-string query', args: { query: 7 } },
      { label: 'a missing query', args: {} },
      { label: 'an unknown key (strict)', args: { query: 'bass', extra: true } },
    ],
  },
  live_list_clips: {
    valid: { trackId: TRACK_REFERENCE },
    invalid: [
      { label: 'an empty trackId', args: { trackId: '' } },
      { label: 'a non-string trackId', args: { trackId: 2 } },
      { label: 'a legacy positional trackId', args: { trackId: 'track:0' } },
      { label: 'a missing trackId', args: {} },
    ],
  },
  live_get_notes: {
    valid: { clipId: CLIP_REFERENCE },
    invalid: [
      { label: 'an empty clipId', args: { clipId: '' } },
      { label: 'a missing clipId', args: {} },
      { label: 'a legacy positional clipId', args: { clipId: 'track:0/clipslot:0/clip' } },
      { label: 'an unknown key (strict)', args: { clipId: CLIP_REFERENCE, n: 1 } },
    ],
  },
  // --- writes ---
  live_set_tempo: {
    valid: { bpm: 120 },
    invalid: [
      { label: "a non-numeric bpm ('fast')", args: { bpm: 'fast' } },
      { label: 'a bpm below the 20 floor', args: { bpm: 10 } },
      { label: 'a bpm above the 999 ceiling', args: { bpm: 5000 } },
      { label: 'NaN bpm', args: { bpm: Number.NaN }, expectedPath: ['bpm'] },
      {
        label: 'positive-infinity bpm',
        args: { bpm: Number.POSITIVE_INFINITY },
        expectedPath: ['bpm'],
      },
      {
        label: 'negative-infinity bpm',
        args: { bpm: Number.NEGATIVE_INFINITY },
        expectedPath: ['bpm'],
      },
      { label: 'a missing bpm', args: {} },
      { label: 'an unknown key (strict)', args: { bpm: 120, swing: 1 } },
    ],
  },
  live_set_track_props: {
    valid: { trackId: TRACK_REFERENCE, props: { name: 'Kit', mute: true } },
    invalid: [
      {
        label: 'an empty props object (refine)',
        args: { trackId: TRACK_REFERENCE, props: {} },
        expectedPath: ['props'],
      },
      {
        label: 'an empty name string',
        args: { trackId: TRACK_REFERENCE, props: { name: '' } },
        expectedPath: ['props', 'name'],
      },
      {
        label: 'a non-boolean mute',
        args: { trackId: TRACK_REFERENCE, props: { mute: 'yes' } },
        expectedPath: ['props', 'mute'],
      },
      {
        label: 'an unknown prop key (strict)',
        args: { trackId: TRACK_REFERENCE, props: { color: 1 } },
      },
      { label: 'a missing props', args: { trackId: TRACK_REFERENCE }, expectedPath: ['props'] },
    ],
  },
  live_set_notes: {
    valid: { clipId: CLIP_REFERENCE, notes: [{ pitch: 60, startTime: 0, duration: 1 }] },
    invalid: [
      {
        label: 'a note pitch above 127',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 200, startTime: 0, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'pitch'],
      },
      {
        label: 'a negative note pitch',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: -1, startTime: 0, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'pitch'],
      },
      {
        label: 'a non-integer pitch',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60.5, startTime: 0, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'pitch'],
      },
      {
        label: 'a non-finite pitch',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: Number.NaN, startTime: 0, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'pitch'],
      },
      {
        label: 'a negative startTime (beats)',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: -1, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'startTime'],
      },
      {
        label: 'a non-finite startTime',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: Number.POSITIVE_INFINITY, duration: 1 }],
        },
        expectedPath: ['notes', 0, 'startTime'],
      },
      {
        label: 'a zero note duration',
        args: { clipId: CLIP_REFERENCE, notes: [{ pitch: 60, startTime: 0, duration: 0 }] },
        expectedPath: ['notes', 0, 'duration'],
      },
      {
        label: 'a non-finite note duration',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: 0, duration: Number.NEGATIVE_INFINITY }],
        },
        expectedPath: ['notes', 0, 'duration'],
      },
      {
        label: 'a non-finite note probability',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: 0, duration: 1, probability: Number.NaN }],
        },
        expectedPath: ['notes', 0, 'probability'],
      },
      {
        label: 'an out-of-range note probability',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: 0, duration: 1, probability: 1.01 }],
        },
        expectedPath: ['notes', 0, 'probability'],
      },
      {
        label: 'a non-finite note velocity',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: Number.POSITIVE_INFINITY }],
        },
        expectedPath: ['notes', 0, 'velocity'],
      },
      {
        label: 'a non-finite velocity deviation',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [
            { pitch: 60, startTime: 0, duration: 1, velocityDeviation: Number.NEGATIVE_INFINITY },
          ],
        },
        expectedPath: ['notes', 0, 'velocityDeviation'],
      },
      {
        label: 'an unknown note key (strict NoteSchema)',
        args: {
          clipId: CLIP_REFERENCE,
          notes: [{ pitch: 60, startTime: 0, duration: 1, channel: 1 }],
        },
      },
      {
        label: 'a non-array notes',
        args: { clipId: CLIP_REFERENCE, notes: {} },
        expectedPath: ['notes'],
      },
      { label: 'a missing notes', args: { clipId: CLIP_REFERENCE }, expectedPath: ['notes'] },
    ],
  },
  live_create_track: {
    valid: { kind: 'midi' },
    invalid: [
      { label: 'a kind outside the enum', args: { kind: 'return' } },
      { label: 'a non-string kind', args: { kind: 1 } },
      { label: 'a missing kind', args: {} },
    ],
  },
  live_create_midi_clip: {
    valid: { slotId: CLIP_SLOT_REFERENCE, lengthBeats: 4 },
    invalid: [
      {
        label: 'a length below the 0.25 minimum',
        args: { slotId: CLIP_SLOT_REFERENCE, lengthBeats: 0.1 },
        expectedPath: ['lengthBeats'],
      },
      {
        label: 'a non-numeric length',
        args: { slotId: CLIP_SLOT_REFERENCE, lengthBeats: 'four' },
        expectedPath: ['lengthBeats'],
      },
      {
        label: 'a non-finite length',
        args: { slotId: CLIP_SLOT_REFERENCE, lengthBeats: Number.POSITIVE_INFINITY },
        expectedPath: ['lengthBeats'],
      },
      {
        label: 'a negative-infinity length',
        args: { slotId: CLIP_SLOT_REFERENCE, lengthBeats: Number.NEGATIVE_INFINITY },
        expectedPath: ['lengthBeats'],
      },
      { label: 'an empty slotId', args: { slotId: '', lengthBeats: 4 } },
      {
        label: 'a legacy positional slotId',
        args: { slotId: 'track:0/clipslot:1', lengthBeats: 4 },
      },
      {
        label: 'a missing lengthBeats',
        args: { slotId: CLIP_SLOT_REFERENCE },
        expectedPath: ['lengthBeats'],
      },
    ],
  },
  live_set_param: {
    valid: { paramId: PARAMETER_REFERENCE, value: 1000 },
    invalid: [
      {
        label: 'a non-numeric value',
        args: { paramId: PARAMETER_REFERENCE, value: 'loud' },
        expectedPath: ['value'],
      },
      {
        label: 'a non-finite parameter value',
        args: { paramId: PARAMETER_REFERENCE, value: Number.NaN },
        expectedPath: ['value'],
      },
      {
        label: 'an infinite parameter value',
        args: { paramId: PARAMETER_REFERENCE, value: Number.NEGATIVE_INFINITY },
        expectedPath: ['value'],
      },
      { label: 'an empty paramId', args: { paramId: '', value: 1 } },
      {
        label: 'a legacy positional paramId',
        args: { paramId: 'track:2/device:0/param:0', value: 1 },
      },
      { label: 'a missing value', args: { paramId: PARAMETER_REFERENCE }, expectedPath: ['value'] },
      {
        label: 'an unknown key (strict)',
        args: { paramId: PARAMETER_REFERENCE, value: 1, unit: 'hz' },
      },
    ],
  },
  live_insert_device: {
    valid: { trackId: TRACK_REFERENCE, deviceName: 'Reverb', index: 0 },
    invalid: [
      {
        label: 'a negative chain index',
        args: { trackId: TRACK_REFERENCE, deviceName: 'Reverb', index: -1 },
        expectedPath: ['index'],
      },
      {
        label: 'a non-integer index',
        args: { trackId: TRACK_REFERENCE, deviceName: 'Reverb', index: 1.5 },
        expectedPath: ['index'],
      },
      {
        label: 'a non-finite chain index',
        args: { trackId: TRACK_REFERENCE, deviceName: 'Reverb', index: Number.NEGATIVE_INFINITY },
        expectedPath: ['index'],
      },
      {
        label: 'a positive-infinity chain index',
        args: { trackId: TRACK_REFERENCE, deviceName: 'Reverb', index: Number.POSITIVE_INFINITY },
        expectedPath: ['index'],
      },
      {
        label: 'an empty deviceName',
        args: { trackId: TRACK_REFERENCE, deviceName: '', index: 0 },
        expectedPath: ['deviceName'],
      },
      {
        label: 'a missing index',
        args: { trackId: TRACK_REFERENCE, deviceName: 'Reverb' },
        expectedPath: ['index'],
      },
    ],
  },
  live_render_track: {
    valid: { trackId: TRACK_REFERENCE, startBeat: 0, endBeat: 8 },
    invalid: [
      {
        label: 'an endBeat equal to startBeat (refine)',
        args: { trackId: TRACK_REFERENCE, startBeat: 4, endBeat: 4 },
        expectedPath: ['endBeat'],
      },
      {
        label: 'an endBeat below startBeat (refine)',
        args: { trackId: TRACK_REFERENCE, startBeat: 8, endBeat: 4 },
        expectedPath: ['endBeat'],
      },
      {
        label: 'a negative startBeat',
        args: { trackId: TRACK_REFERENCE, startBeat: -1, endBeat: 8 },
        expectedPath: ['startBeat'],
      },
      {
        label: 'a non-finite startBeat',
        args: { trackId: TRACK_REFERENCE, startBeat: Number.POSITIVE_INFINITY, endBeat: 8 },
        expectedPath: ['startBeat'],
      },
      {
        label: 'a negative-infinity startBeat',
        args: { trackId: TRACK_REFERENCE, startBeat: Number.NEGATIVE_INFINITY, endBeat: 8 },
        expectedPath: ['startBeat'],
      },
      {
        label: 'a non-finite endBeat',
        args: { trackId: TRACK_REFERENCE, startBeat: 0, endBeat: Number.POSITIVE_INFINITY },
        expectedPath: ['endBeat'],
      },
      {
        label: 'a legacy positional trackId',
        args: { trackId: 'track:2', startBeat: 0, endBeat: 8 },
      },
      {
        label: 'a missing endBeat',
        args: { trackId: TRACK_REFERENCE, startBeat: 0 },
        expectedPath: ['endBeat'],
      },
    ],
  },
};

/** Index the live tool modules by name. */
const toolsByName: ReadonlyMap<string, ToolModule> = new Map(
  collectTools().map((tool) => [tool.name, tool]),
);

describe('ring 1: every tool covers a Zod input reject path', () => {
  it('there is one input-validation case per registered tool', () => {
    const caseNames = Object.keys(CASES).sort();
    const toolNames = [...toolsByName.keys()].sort();
    expect(caseNames).toEqual(toolNames);
  });

  for (const [name, testCase] of Object.entries(CASES)) {
    describe(name, () => {
      const tool = toolsByName.get(name);

      it('accepts a valid argument sample', () => {
        expect(tool, `tool ${name} must be registered`).toBeDefined();
        const result = tool!.inputSchema.safeParse(testCase.valid);
        expect(result.success).toBe(true);
      });

      for (const { label, args, expectedPath } of testCase.invalid) {
        it(`rejects ${label}`, () => {
          expect(tool).toBeDefined();
          const result = tool!.inputSchema.safeParse(args);
          // A clean schema rejection: success is false and Zod issues are present.
          // This is the "clean BAD_INPUT at the validation layer" the spec calls
          // for; it carries no BridgeError code (that is the bridge surface).
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.issues.length).toBeGreaterThan(0);
            if (expectedPath !== undefined) {
              expect(
                result.error.issues.some((issue) => pathsEqual(issue.path, expectedPath)),
              ).toBe(true);
            }
          }
        });
      }
    });
  }
});

function pathsEqual(left: PropertyKey[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
