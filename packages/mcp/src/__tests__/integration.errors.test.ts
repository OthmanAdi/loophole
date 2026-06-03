/**
 * Ring 2 (integration) — the error model over the MCP wire (02_BRIDGE_SPEC §7, §8).
 *
 * The rule the model needs: a tool NEVER throws to the protocol. Every failure is
 * a normal tool result with `isError: true` and a recovery hint, so `callTool`
 * always RESOLVES (never rejects). The two error surfaces are told apart by the
 * structured `code`:
 *  - a BRIDGE error (a well-formed id that is stale / wrong-type, or a value out of
 *    a parameter's range) carries `structuredContent.code` = STALE_REFERENCE /
 *    WRONG_TYPE / BAD_INPUT, mapped from the thrown `BridgeError` by `safeHandle`;
 *  - a Zod/schema rejection (caught by the SDK before the handler) is still
 *    `isError: true`, but carries NO bridge `code` (it is an "input validation"
 *    result). We assert it stays a clean result, never a throw.
 *
 * A failed mutation must commit NO undo step (the transaction count stays put).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { callTool, connect, resultCode, resultText, type Connected } from './harness.js';

describe('ring 2: error paths over MCP (clean results, never a throw)', () => {
  let live: FakeLiveBridge;
  let conn: Connected;

  beforeEach(async () => {
    live = FakeLiveBridge.seeded();
    conn = await connect(live);
  });
  afterEach(async () => {
    await conn.close();
  });

  it('a stale clip id resolves to isError with STALE_REFERENCE (not a thrown JSON-RPC error)', async () => {
    // callTool RESOLVES; the error is in the result, not thrown.
    const res = await callTool(conn.client, 'live_set_notes', {
      clipId: 'track:9/clipslot:9/clip',
      notes: [],
    });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('STALE_REFERENCE');
    // The serialized result contains the code string (the §8 assertion).
    expect(JSON.stringify(res)).toContain('STALE_REFERENCE');
    // The recovery hint reaches the model.
    expect(resultText(res)).toContain('Recovery');
    // A failed write commits no undo step.
    expect(live.transactionCount).toBe(0);
  });

  it('a wrong-type id (audio clip into set_notes) resolves to WRONG_TYPE', async () => {
    // track:2/clip:0 is the Vocals AUDIO arrangement clip.
    const res = await callTool(conn.client, 'live_set_notes', {
      clipId: 'track:2/clip:0',
      notes: [{ pitch: 60, startTime: 0, duration: 1 }],
    });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('WRONG_TYPE');
    expect(JSON.stringify(res)).toContain('WRONG_TYPE');
    expect(live.transactionCount).toBe(0);
  });

  it('an out-of-range value (passes Zod, rejected by the bridge) resolves to BAD_INPUT', async () => {
    // EQ Eight "1 Frequency A" on Vocals has range 20..20000; 999999 is out of range.
    // The Zod schema accepts any number, so this is a BRIDGE BAD_INPUT, not a Zod reject.
    const res = await callTool(conn.client, 'live_set_param', {
      paramId: 'track:2/device:0/param:0',
      value: 999999,
    });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('BAD_INPUT');
    expect(JSON.stringify(res)).toContain('BAD_INPUT');
    // The message echoes the offending value / range for the model.
    expect(resultText(res)).toContain('999999');
    expect(live.transactionCount).toBe(0);
  });

  it('an unknown built-in device name resolves to SDK_REJECTED', async () => {
    const res = await callTool(conn.client, 'live_insert_device', {
      trackId: 'track:0',
      deviceName: 'TotallyNotARealDevice',
      index: 0,
    });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('SDK_REJECTED');
    expect(live.transactionCount).toBe(0);
  });

  it('creating a MIDI clip in an occupied slot resolves to SDK_REJECTED', async () => {
    // Drums (track:0) slot 0 is occupied by "Beat".
    const res = await callTool(conn.client, 'live_create_midi_clip', {
      slotId: 'track:0/clipslot:0',
      lengthBeats: 4,
    });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('SDK_REJECTED');
    expect(live.transactionCount).toBe(0);
  });

  it('a stale track id on a read tool resolves to STALE_REFERENCE', async () => {
    const res = await callTool(conn.client, 'live_list_clips', { trackId: 'track:99' });
    expect(res.isError).toBe(true);
    expect(resultCode(res)).toBe('STALE_REFERENCE');
  });

  it('a Zod-invalid argument is a clean isError result, not a throw and not a bridge code', async () => {
    // `bpm: "fast"` fails the schema; the SDK turns it into an isError result
    // BEFORE the handler runs, so there is no BridgeError code on it.
    const res = await callTool(conn.client, 'live_set_tempo', { bpm: 'fast' });
    expect(res.isError).toBe(true);
    // It is a validation result, not a bridge error: no STALE/WRONG/BAD code.
    expect(resultCode(res)).toBeUndefined();
    // It mentions validation; we assert loosely (not the SDK's exact error string).
    expect(resultText(res)).toMatch(/validation|invalid/i);
    // No mutation happened.
    expect(live.transactionCount).toBe(0);
  });

  it('a malformed (unparseable) id resolves to a clean isError result, never a throw', async () => {
    // `track:-1` is not a buildable path id; makePathId throws inside the handler,
    // which safeHandle catches and returns as a clean error result.
    const res = await callTool(conn.client, 'live_list_clips', { trackId: 'track:-1' });
    expect(res.isError).toBe(true);
    expect(live.transactionCount).toBe(0);
  });
});
