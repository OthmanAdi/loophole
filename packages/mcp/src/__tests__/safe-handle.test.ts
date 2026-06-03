/**
 * Ring 1 (unit) — `safeHandle`'s catch-and-map contract (02_BRIDGE_SPEC §7.2).
 *
 * `safeHandle` is the single place a tool failure is converted into a clean
 * `{ isError: true }` result, so a tool body never throws to the MCP protocol.
 * The claims pinned here:
 *  - a thrown `BridgeError` of EACH of the five `BridgeErrorCode`s becomes an
 *    error result carrying that error's `message`, its recovery `hint`, and the
 *    `code` (surfaced in `structuredContent.code`);
 *  - a non-`BridgeError` throw becomes a generic `SDK_REJECTED` result with a
 *    fixed retry hint and the tool name in the message;
 *  - a handler that resolves normally is passed through untouched.
 *
 * The bridge is never called here; a stub handler throws the value under test, so
 * this is a pure unit of the mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  badInput,
  sdkRejected,
  staleReference,
  unsupported,
  wrongType,
  type BridgeError,
  type BridgeErrorCode,
  type LiveBridge,
} from '@othmanadi/loophole-core';

import { safeHandle } from '../result/safe-handle.js';
import { ok, type ToolResult } from '../result/ok.js';

/** A stand-in bridge: never invoked, only needed to satisfy the handler signature. */
const bridge = {} as LiveBridge;

/** The concatenated text of a result's content blocks. */
function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join('');
}

/** The `code` a result carries in `structuredContent`, if any. */
function code(result: ToolResult): unknown {
  return result.structuredContent?.code;
}

describe('ring 1: safeHandle maps each BridgeError code to its hint', () => {
  // One representative BridgeError per code, built through the core helpers so the
  // default hint per code is the one the model will actually see.
  const cases: readonly { readonly code: BridgeErrorCode; readonly error: BridgeError }[] = [
    { code: 'STALE_REFERENCE', error: staleReference('track:9') },
    { code: 'WRONG_TYPE', error: wrongType('track:0/clip:0', 'MIDI clip') },
    { code: 'BAD_INPUT', error: badInput('Tempo -1 is not a positive number.') },
    { code: 'SDK_REJECTED', error: sdkRejected('Live refused the change.') },
    { code: 'UNSUPPORTED', error: unsupported('Real-time audio is not in the v1.0.0 API.') },
  ];

  for (const { code: expectedCode, error } of cases) {
    it(`maps ${expectedCode} to its message, hint, and code`, async () => {
      const guarded = safeHandle('test_tool', () => {
        throw error;
      });
      const result = await guarded({}, bridge);

      expect(result.isError).toBe(true);
      // The code is surfaced for a client to branch on.
      expect(code(result)).toBe(expectedCode);
      // The original message and the recovery hint both reach the model.
      expect(text(result)).toContain(error.message);
      expect(text(result)).toContain(error.hint);
      // The hint is rendered on its own "Recovery:" line.
      expect(text(result)).toContain(`Recovery: ${error.hint}`);
    });
  }

  it('preserves a custom hint set on the BridgeError (not just the default)', async () => {
    const custom = badInput('Value 9 is outside 0..1.', 'Pass a value within the range.');
    const guarded = safeHandle('live_set_param', () => {
      throw custom;
    });
    const result = await guarded({}, bridge);
    expect(code(result)).toBe('BAD_INPUT');
    expect(text(result)).toContain('Pass a value within the range.');
  });
});

describe('ring 1: safeHandle handles non-BridgeError throws and success', () => {
  it('maps an arbitrary Error to a generic SDK_REJECTED result naming the tool', async () => {
    const guarded = safeHandle('live_render_track', () => {
      throw new Error('socket hung up');
    });
    const result = await guarded({}, bridge);
    expect(result.isError).toBe(true);
    expect(code(result)).toBe('SDK_REJECTED');
    expect(text(result)).toContain('Unexpected failure in live_render_track');
    expect(text(result)).toContain('socket hung up');
    expect(text(result)).toContain('Retry once');
  });

  it('maps a thrown non-Error value to SDK_REJECTED via String()', async () => {
    const guarded = safeHandle('live_set_tempo', () => {
      // A non-Error throw (e.g. a string) must still be caught and shaped. The
      // bare-string throw is the behaviour under test, hence the scoped disable.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'raw string failure';
    });
    const result = await guarded({}, bridge);
    expect(result.isError).toBe(true);
    expect(code(result)).toBe('SDK_REJECTED');
    expect(text(result)).toContain('raw string failure');
  });

  it('passes a successful result through unchanged', async () => {
    const passthrough = ok({ tempo: 120 }, 'Tempo set to 120 BPM.');
    const guarded = safeHandle('live_set_tempo', () => Promise.resolve(passthrough));
    const result = await guarded({}, bridge);
    expect(result.isError).toBeUndefined();
    expect(result).toBe(passthrough);
  });
});
