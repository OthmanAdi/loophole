/**
 * Character-cap helper for tool and resource text payloads.
 *
 * Every text body the bridge returns is capped at `CHARACTER_LIMIT` characters
 * (02_BRIDGE_SPEC §8) so a large Set cannot flood the model's context. When a
 * body overflows, the bridge says so and tells the model how to narrow the read
 * (a `trackId`, a beat range, `live_find_track`) rather than silently returning
 * a partial dump.
 */

import { CHARACTER_LIMIT } from '../config/config.js';

/**
 * The notice appended when text is truncated. Phrased as guidance to the model:
 * the recovery path is to read a narrower slice, never to retry the same call.
 */
const TRUNCATION_NOTICE =
  '\n\n[output truncated: it exceeded the character limit. Read a narrower slice ' +
  '(one track, one clip, or a beat range) or use live_find_track to filter.]';

/**
 * Cap `text` at `limit` characters. If it fits, return it unchanged. If not,
 * keep a prefix that leaves room for the notice and append the notice, so the
 * total never exceeds `limit`.
 *
 * @param text  the candidate payload.
 * @param limit the hard character cap; defaults to {@link CHARACTER_LIMIT}.
 */
export function truncate(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  // Reserve space for the notice; if the limit is smaller than the notice
  // itself (a pathological config), fall back to a hard slice.
  const room = limit - TRUNCATION_NOTICE.length;
  if (room <= 0) {
    return text.slice(0, limit);
  }
  return text.slice(0, room) + TRUNCATION_NOTICE;
}
