/**
 * Tool 11 — `live_insert_device` (write).
 *
 * Add a built-in Live device (a Reverb, an EQ Eight) onto a track at a position
 * in its device chain. One queued transaction = one undo. Built-in devices only;
 * an unknown name is rejected (`SDK_REJECTED`). The result lists the device's
 * parameter references so the model can address them with live_set_param.
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { TrackReference } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    trackId: TrackReference,
    deviceName: z
      .string()
      .min(1)
      .describe(
        "Exact built-in Live device name, e.g. 'Reverb'. Built-in devices only; third-party / VST not supported.",
      ),
    index: z.number().finite().int().min(0).describe("Insert position in the track's device chain"),
  })
  .strict();

export const insertDeviceTool = defineTool({
  name: 'live_insert_device',
  title: 'Insert device',
  description:
    'Insert a built-in Live device (e.g. Reverb, EQ Eight) onto a current track reference at a chain index. One ' +
    'undo step. Built-in devices only; third-party / VST is not supported and an unknown name is ' +
    'rejected. Returns the new device reference and its parameter references, ready for live_set_param.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    // Not idempotent: each call inserts another instance of the device.
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const trackId = args.trackId;
    const device = await bridge.insertDevice(trackId, args.deviceName, args.index);
    const data = {
      trackId,
      device: { id: device.id, name: device.name },
      params: device.parameters.map((p) => ({ id: p.id, name: p.name })),
    };
    return ok(
      data,
      `Inserted a device with ${String(device.parameters.length)} ` +
        `addressable parameter(s). Set one with live_set_param.`,
    );
  },
});
