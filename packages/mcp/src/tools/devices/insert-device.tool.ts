/**
 * Tool 11 — `live_insert_device` (write).
 *
 * Add a built-in Live device (a Reverb, an EQ Eight) onto a track at a position
 * in its device chain. One queued transaction = one undo. Built-in devices only;
 * an unknown name is rejected (`SDK_REJECTED`). The result lists the device's
 * parameter ids so the model can address them with live_set_param
 * (02_BRIDGE_SPEC §5 tool 11).
 */

import { z } from 'zod';

import { makePathId } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { TrackId } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    trackId: TrackId,
    deviceName: z
      .string()
      .min(1)
      .describe(
        "Exact built-in Live device name, e.g. 'Reverb'. Built-in devices only; third-party / VST not supported.",
      ),
    index: z.number().int().min(0).describe("Insert position in the track's device chain"),
  })
  .strict();

export const insertDeviceTool = defineTool({
  name: 'live_insert_device',
  title: 'Insert device',
  description:
    'Insert a built-in Live device (e.g. Reverb, EQ Eight) onto a track at a chain index. One ' +
    'undo step. Built-in devices only; third-party / VST is not supported and an unknown name is ' +
    'rejected. Returns the new device id and its parameter ids, ready for live_set_param.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Not idempotent: each call inserts another instance of the device.
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const trackId = makePathId(args.trackId);
    const device = await bridge.insertDevice(trackId, args.deviceName, args.index);
    const data = {
      trackId,
      device: { id: device.id, name: device.name },
      params: device.parameters.map((p) => ({ id: p.id, name: p.name })),
    };
    return ok(
      data,
      `Inserted ${device.name} (${device.id}) with ${String(device.parameters.length)} ` +
        `addressable parameter(s). Set one with live_set_param.`,
    );
  },
});
