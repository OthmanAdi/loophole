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
  readonly invalid: readonly { readonly label: string; readonly args: unknown }[];
}

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
    valid: { trackId: 'track:2' },
    invalid: [
      { label: 'an empty trackId', args: { trackId: '' } },
      { label: 'a non-string trackId', args: { trackId: 2 } },
      { label: 'a missing trackId', args: {} },
    ],
  },
  live_get_notes: {
    valid: { clipId: 'track:2/clipslot:4/clip' },
    invalid: [
      { label: 'an empty clipId', args: { clipId: '' } },
      { label: 'a missing clipId', args: {} },
      { label: 'an unknown key (strict)', args: { clipId: 'track:0/clipslot:0/clip', n: 1 } },
    ],
  },
  // --- writes ---
  live_set_tempo: {
    valid: { bpm: 120 },
    invalid: [
      { label: "a non-numeric bpm ('fast')", args: { bpm: 'fast' } },
      { label: 'a bpm below the 20 floor', args: { bpm: 10 } },
      { label: 'a bpm above the 999 ceiling', args: { bpm: 5000 } },
      { label: 'a missing bpm', args: {} },
      { label: 'an unknown key (strict)', args: { bpm: 120, swing: 1 } },
    ],
  },
  live_set_track_props: {
    valid: { trackId: 'track:0', props: { name: 'Kit', mute: true } },
    invalid: [
      { label: 'an empty props object (refine)', args: { trackId: 'track:0', props: {} } },
      {
        label: 'an empty name string',
        args: { trackId: 'track:0', props: { name: '' } },
      },
      {
        label: 'a non-boolean mute',
        args: { trackId: 'track:0', props: { mute: 'yes' } },
      },
      {
        label: 'an unknown prop key (strict)',
        args: { trackId: 'track:0', props: { color: 1 } },
      },
      { label: 'a missing props', args: { trackId: 'track:0' } },
    ],
  },
  live_set_notes: {
    valid: { clipId: 'track:0/clipslot:0/clip', notes: [{ pitch: 60, startTime: 0, duration: 1 }] },
    invalid: [
      {
        label: 'a note pitch above 127',
        args: {
          clipId: 'track:0/clipslot:0/clip',
          notes: [{ pitch: 200, startTime: 0, duration: 1 }],
        },
      },
      {
        label: 'a negative note pitch',
        args: {
          clipId: 'track:0/clipslot:0/clip',
          notes: [{ pitch: -1, startTime: 0, duration: 1 }],
        },
      },
      {
        label: 'a non-integer pitch',
        args: {
          clipId: 'track:0/clipslot:0/clip',
          notes: [{ pitch: 60.5, startTime: 0, duration: 1 }],
        },
      },
      {
        label: 'a negative startTime (beats)',
        args: {
          clipId: 'track:0/clipslot:0/clip',
          notes: [{ pitch: 60, startTime: -1, duration: 1 }],
        },
      },
      {
        label: 'an unknown note key (strict NoteSchema)',
        args: {
          clipId: 'track:0/clipslot:0/clip',
          notes: [{ pitch: 60, startTime: 0, duration: 1, channel: 1 }],
        },
      },
      { label: 'a non-array notes', args: { clipId: 'track:0/clipslot:0/clip', notes: {} } },
      { label: 'a missing notes', args: { clipId: 'track:0/clipslot:0/clip' } },
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
    valid: { slotId: 'track:0/clipslot:1', lengthBeats: 4 },
    invalid: [
      {
        label: 'a length below the 0.25 minimum',
        args: { slotId: 'track:0/clipslot:1', lengthBeats: 0.1 },
      },
      {
        label: 'a non-numeric length',
        args: { slotId: 'track:0/clipslot:1', lengthBeats: 'four' },
      },
      { label: 'an empty slotId', args: { slotId: '', lengthBeats: 4 } },
      { label: 'a missing lengthBeats', args: { slotId: 'track:0/clipslot:1' } },
    ],
  },
  live_set_param: {
    valid: { paramId: 'track:2/device:0/param:0', value: 1000 },
    invalid: [
      {
        label: 'a non-numeric value',
        args: { paramId: 'track:2/device:0/param:0', value: 'loud' },
      },
      { label: 'an empty paramId', args: { paramId: '', value: 1 } },
      { label: 'a missing value', args: { paramId: 'track:2/device:0/param:0' } },
      {
        label: 'an unknown key (strict)',
        args: { paramId: 'track:2/device:0/param:0', value: 1, unit: 'hz' },
      },
    ],
  },
  live_insert_device: {
    valid: { trackId: 'track:1', deviceName: 'Reverb', index: 0 },
    invalid: [
      {
        label: 'a negative chain index',
        args: { trackId: 'track:1', deviceName: 'Reverb', index: -1 },
      },
      {
        label: 'a non-integer index',
        args: { trackId: 'track:1', deviceName: 'Reverb', index: 1.5 },
      },
      { label: 'an empty deviceName', args: { trackId: 'track:1', deviceName: '', index: 0 } },
      { label: 'a missing index', args: { trackId: 'track:1', deviceName: 'Reverb' } },
    ],
  },
  live_render_track: {
    valid: { trackId: 'track:2', startBeat: 0, endBeat: 8 },
    invalid: [
      {
        label: 'an endBeat equal to startBeat (refine)',
        args: { trackId: 'track:2', startBeat: 4, endBeat: 4 },
      },
      {
        label: 'an endBeat below startBeat (refine)',
        args: { trackId: 'track:2', startBeat: 8, endBeat: 4 },
      },
      {
        label: 'a negative startBeat',
        args: { trackId: 'track:2', startBeat: -1, endBeat: 8 },
      },
      { label: 'a missing endBeat', args: { trackId: 'track:2', startBeat: 0 } },
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

      for (const { label, args } of testCase.invalid) {
        it(`rejects ${label}`, () => {
          expect(tool).toBeDefined();
          const result = tool!.inputSchema.safeParse(args);
          // A clean schema rejection: success is false and Zod issues are present.
          // This is the "clean BAD_INPUT at the validation layer" the spec calls
          // for; it carries no BridgeError code (that is the bridge surface).
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.issues.length).toBeGreaterThan(0);
          }
        });
      }
    });
  }
});
