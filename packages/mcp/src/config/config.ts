/**
 * Reusable library configuration defaults in a small, Zod-validated plain object.
 *
 * This is config ONLY. It carries reusable loopback and port-probe defaults plus
 * the output character limit, and it validates them. It does NOT open a socket,
 * import `node:http`, or read the filesystem: the shipped transport, auth, and
 * `bridge.json` discovery are the extension shell's concern. Result helpers read
 * the character limit here; other consumers may validate their own transport
 * configuration against the exported schema.
 */

import { z } from 'zod';

/** Recommended first port for a consumer-provided loopback listener. */
export const PORT_RANGE_START = 8420;
/** Recommended last port for a consumer-provided loopback listener. */
export const PORT_RANGE_END = 8429;
/** Safe default host for a consumer-provided listener; never `0.0.0.0`. */
export const DEFAULT_HOST = '127.0.0.1';
/** Hard cap on a tool/resource text payload, in characters. */
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
      .describe('Safe loopback bind default for a consumer-provided listener.'),
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
 * Pass nothing to get the library defaults. A consumer that owns a transport
 * may override individual fields; unknown keys and out-of-range values throw a
 * `ZodError`. The shipped extension shell enforces its own fixed listener values.
 */
export function loadConfig(overrides?: unknown): Config {
  return ConfigSchema.parse(overrides ?? {});
}

/** Precomputed library defaults for consumers that want the complete validated object. */
export const defaultConfig: Config = loadConfig();
