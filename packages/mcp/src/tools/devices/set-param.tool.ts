/**
 * Tool 10 — `live_set_param` (write).
 *
 * Set one device parameter (a filter cutoff, a send level) to a value within the
 * parameter's own min..max. One queued transaction = one undo. The model obtains
 * a parameter reference from the `ableton://track/{reference}` resource or from
 * live_insert_device's output (02_BRIDGE_SPEC §5 tool 10).
 */

import { z } from 'zod';

import { defineTool } from '../registry.js';
import { ok } from '../../result/ok.js';
import { ParameterReference } from '../../schemas/primitives.js';

const inputSchema = z
  .object({
    paramId: ParameterReference,
    value: z
      .number()
      .finite()
      .describe("Target value; must fall within the parameter's own min..max"),
  })
  .strict();

export const setParamTool = defineTool({
  name: 'live_set_param',
  title: 'Set device parameter',
  description:
    "Set one device parameter reference to a value (which must fall within the parameter's own min..max). " +
    'One undo step. Get a parameter reference from the matching ableton://track resource or from ' +
    'live_insert_device. Returns the parameter reference, value written, and its min / max.',
  inputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handle: async (args, bridge) => {
    const param = await bridge.setParam(args.paramId, args.value);
    return ok(
      param,
      `Set the referenced parameter to ${String(param.value)} (range ${String(param.min)}..${String(param.max)}).`,
    );
  },
});
