/**
 * Tool 10 — `live_set_param` (write).
 *
 * Set one device parameter (a filter cutoff, a send level) to a value within the
 * parameter's own min..max. One queued transaction = one undo. The model obtains
 * a parameter id from the `ableton://track/{i}` resource or from
 * live_insert_device's output (02_BRIDGE_SPEC §5 tool 10).
 */

import { z } from 'zod';

import { makePathId } from '@othmanadi/loophole-core';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { ParamId } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    paramId: ParamId,
    value: z.number().describe("Target value; must fall within the parameter's own min..max"),
  })
  .strict();

export const setParamTool = defineTool({
  name: 'live_set_param',
  title: 'Set device parameter',
  description:
    "Set one device parameter to a value (which must fall within the parameter's own min..max). " +
    'One undo step. Get a parameter id from the ableton://track/{i} resource or from ' +
    'live_insert_device. Returns the parameter name, the value written, and its min / max.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const param = await bridge.setParam(makePathId(args.paramId), args.value);
    return ok(
      param,
      `Set ${param.name} to ${String(param.value)} (range ${String(param.min)}..${String(param.max)}).`,
    );
  },
});
