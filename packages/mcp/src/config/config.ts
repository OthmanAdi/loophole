/**
 * The bridge's runtime configuration: a small, Zod-validated, plain object.
 *
 * This is config ONLY. It carries the loopback host, the port-probe range, and
 * the output character limit, and it validates them. It does NOT open a socket,
 * import `node:http`, or read the filesystem: the transport, auth, and
 * `bridge.json` discovery are the extension shell's concern in a later wave
 * (02_BRIDGE_SPEC §1.3, §2). The values here are the contract those later
 * pieces, and the result helpers, read from.
 */

import { z } from 'zod';

/** Lowest port the bridge probes for its loopback listener (02_BRIDGE_SPEC §1.2). */
export const PORT_RANGE_START = 8420;
/** Highest port the bridge probes for its loopback listener. */
export const PORT_RANGE_END = 8429;
/** The loopback host the bridge binds to; never `0.0.0.0` (02_BRIDGE_SPEC §2). */
export const DEFAULT_HOST = '127.0.0.1';
/** Hard cap on a tool/resource text payload, in characters (02_BRIDGE_SPEC §8). */
export const CHARACTER_LIMIT = 25_000;

/**
 * The config schema. `.strict()` rejects unknown keys so a typo in a future
 * config source fails loudly rather than being silently ignored.
 */
export const ConfigSchema = z
  .object({
    host: z
      .literal('127.0.0.1')
      .default(DEFAULT_HOST)
      .describe('Loopback bind address. Locked to 127.0.0.1: the bridge is never on the LAN.'),
    portRangeStart: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(PORT_RANGE_START)
      .describe('First port to probe for the loopback listener.'),
    portRangeEnd: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(PORT_RANGE_END)
      .describe('Last port to probe for the loopback listener.'),
    characterLimit: z
      .number()
      .int()
      .positive()
      .default(CHARACTER_LIMIT)
      .describe('Maximum characters in a single tool/resource text payload before truncation.'),
  })
  .strict()
  .refine((c) => c.portRangeEnd >= c.portRangeStart, {
    message: 'portRangeEnd must be greater than or equal to portRangeStart',
  });

/** The validated, fully-populated config object. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Validate (and default) a partial config into a complete {@link Config}.
 *
 * Pass nothing to get the locked defaults (the common case: the bridge ships
 * with a fixed loopback posture). Pass a partial to override individual fields;
 * unknown keys and out-of-range values throw a `ZodError`.
 */
export function loadConfig(overrides?: unknown): Config {
  return ConfigSchema.parse(overrides ?? {});
}

/** The default config, used by the result helpers' character cap. */
export const defaultConfig: Config = loadConfig();
