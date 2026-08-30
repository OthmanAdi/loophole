/**
 * Ring 1 (unit) — the result helpers and the character cap (02_BRIDGE_SPEC §7, §8).
 *
 * Covers:
 *  - `truncate` exactly at the `CHARACTER_LIMIT = 25_000` boundary: a body at or
 *    below the cap is returned verbatim; a body over the cap is cut and the
 *    truncation notice is appended, with the total never exceeding the cap;
 *  - `ok` returns the human summary as text AND the typed payload as
 *    `structuredContent` (wrapping a bare array/scalar under `value`), capping the
 *    complete serialized envelope and reporting any structured truncation;
 *  - `err` returns `isError: true` with the message, an optional `Recovery:` line,
 *    and an optional `code` in `structuredContent`.
 */

import { describe, expect, it } from 'vitest';

import { serializedByteLength } from '../result/bounded-result.js';
import { truncate } from '../result/truncate.js';
import { ok, err } from '../result/ok.js';
import { CHARACTER_LIMIT } from '../config/config.js';

describe('ring 1: truncate at the 25k boundary', () => {
  it('exposes the documented 25_000 character limit', () => {
    expect(CHARACTER_LIMIT).toBe(25_000);
  });

  it('returns a body shorter than the cap unchanged', () => {
    const body = 'x'.repeat(CHARACTER_LIMIT - 1);
    expect(truncate(body)).toBe(body);
  });

  it('returns a body exactly at the cap unchanged (boundary: length === limit)', () => {
    const body = 'x'.repeat(CHARACTER_LIMIT);
    const out = truncate(body);
    expect(out).toBe(body);
    expect(out.length).toBe(CHARACTER_LIMIT);
  });

  it('truncates a body one character over the cap and appends the notice', () => {
    const body = 'x'.repeat(CHARACTER_LIMIT + 1);
    const out = truncate(body);
    expect(out).not.toBe(body);
    // The result never exceeds the cap, and it ends with the narrowing notice.
    expect(out.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(out).toContain('[output truncated');
    expect(out).toContain('live_find_track');
  });

  it('truncates a much larger body and stays within the cap', () => {
    const out = truncate('y'.repeat(CHARACTER_LIMIT * 4));
    expect(out.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(out).toContain('[output truncated');
  });

  it('honours an explicit smaller limit and still appends the notice when it fits', () => {
    // 300 leaves room for the 149-char notice, so the notice is appended.
    const out = truncate('z'.repeat(1000), 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain('[output truncated');
  });

  it('falls back to a hard slice when the limit is smaller than the notice', () => {
    // A pathological limit shorter than the ~149-char notice: no room to append
    // it, so the body is hard-sliced to the limit with no notice.
    const out = truncate('a'.repeat(50), 10);
    expect(out).toBe('a'.repeat(10));
    expect(out.length).toBe(10);
    expect(out).not.toContain('[output truncated');
  });
});

describe('ring 1: ok() shapes a success result', () => {
  it('uses the summary as text and the object payload as structuredContent', () => {
    const result = ok({ tempo: 120 }, 'Tempo set to 120 BPM.');
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('Tempo set to 120 BPM.');
    expect(result.structuredContent).toEqual({ tempo: 120 });
  });

  it('wraps a bare array payload under a value key (never a bare array on the wire)', () => {
    const result = ok([1, 2, 3], 'three');
    expect(result.structuredContent).toEqual({ value: [1, 2, 3] });
  });

  it('wraps a scalar payload under a value key', () => {
    const result = ok(42, 'forty-two');
    expect(result.structuredContent).toEqual({ value: 42 });
  });

  it('falls back to JSON of the payload when no summary is given', () => {
    const result = ok({ a: 1 });
    expect(result.content[0]?.text).toBe(JSON.stringify({ a: 1 }));
  });

  it('caps the summary text at the character limit', () => {
    const result = ok({ ok: true }, 'q'.repeat(CHARACTER_LIMIT + 100));
    expect((result.content[0]?.text.length ?? 0) <= CHARACTER_LIMIT).toBe(true);
    expect(result.content[0]?.text).toContain('[output truncated');
  });

  it('caps the complete serialized result and preserves a useful structured prefix', () => {
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      index,
      name: `item-${index}`,
      payload: 'x'.repeat(1_000),
    }));

    const result = ok({ items }, 'Large result');

    expect(serializedByteLength(result)).toBeLessThanOrEqual(CHARACTER_LIMIT);
    const boundedItems = result.structuredContent?.items as { index: number }[];
    expect(boundedItems.length).toBeGreaterThan(0);
    expect(boundedItems.length).toBeLessThan(items.length);
    expect(boundedItems[0]?.index).toBe(0);
    expect(result.structuredContent?._meta).toMatchObject({
      loopholeResult: {
        truncated: true,
        reasons: expect.arrayContaining(['serialized_size_limit', 'collection_limit']),
        limitBytes: CHARACTER_LIMIT,
      },
    });
  });

  it('normalizes circular references deterministically and reports the loss', () => {
    const payload: { name: string; self?: unknown } = { name: 'cycle' };
    payload.self = payload;

    const first = ok(payload);
    const second = ok(payload);

    expect(first).toEqual(second);
    expect(first.structuredContent?.self).toBe('[circular reference]');
    expect(first.structuredContent?._meta).toMatchObject({
      loopholeResult: {
        truncated: true,
        reasons: ['circular_reference'],
        circularReferences: 1,
      },
    });
    expect(serializedByteLength(first)).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it('bounds deeply nested values without overflowing the serializer', () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 100; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const result = ok(root, 'Deep result');

    expect(serializedByteLength(result)).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.structuredContent?._meta).toMatchObject({
      loopholeResult: {
        truncated: true,
        reasons: ['depth_limit'],
        depthLimitHits: 1,
      },
    });
  });

  it('turns non-JSON and inaccessible values into bounded markers', () => {
    const payload: Record<string, unknown> = {
      big: 9_007_199_254_740_993n,
      callback: () => 'not serializable',
      missing: undefined,
    };
    Object.defineProperty(payload, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('C:\\private\\Ableton\\internal.log');
      },
    });

    const result = ok(payload);

    expect(result.structuredContent).toMatchObject({
      big: '9007199254740993n',
      callback: '[unsupported function]',
      missing: '[unsupported undefined]',
      secret: '[inaccessible value]',
    });
    expect(JSON.stringify(result)).not.toContain('C:\\private\\Ableton');
    expect(result.structuredContent?._meta).toMatchObject({
      loopholeResult: {
        truncated: true,
        reasons: expect.arrayContaining(['inaccessible_value', 'non_json_value']),
      },
    });
  });

  it('preserves a __proto__ data key without mutating the result prototype', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<
      string,
      unknown
    >;

    const result = ok(payload, 'Prototype-safe result');

    expect(Object.hasOwn(result.structuredContent ?? {}, '__proto__')).toBe(true);
    expect(result.structuredContent?.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('ring 1: err() shapes an error result', () => {
  it('returns isError true with just the message when no hint or code', () => {
    const result = err('Something failed.');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Something failed.');
    expect(result.structuredContent).toBeUndefined();
  });

  it('appends the hint on a Recovery line', () => {
    const result = err('Bad id.', 'Re-list and use a fresh id.');
    expect(result.content[0]?.text).toBe('Bad id.\nRecovery: Re-list and use a fresh id.');
  });

  it('surfaces the code in structuredContent when given', () => {
    const result = err('Gone.', 'Re-list.', 'STALE_REFERENCE');
    expect(result.structuredContent).toEqual({ code: 'STALE_REFERENCE' });
    expect(result.isError).toBe(true);
  });

  it('caps the complete serialized error result even when JSON escaping expands the message', () => {
    const result = err('"\\'.repeat(CHARACTER_LIMIT), 'Retry.', 'SDK_REJECTED');

    expect(serializedByteLength(result)).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.structuredContent?.code).toBe('SDK_REJECTED');
    expect(result.structuredContent?._meta).toMatchObject({
      loopholeResult: {
        truncated: true,
        reasons: ['serialized_size_limit'],
      },
    });
  });
});
