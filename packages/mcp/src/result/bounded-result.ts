/**
 * Build MCP result envelopes that are always JSON-serializable and never exceed
 * the configured limit once encoded as UTF-8 JSON. Normal payloads retain their
 * original shape. Oversized or non-JSON payloads keep a deterministic prefix and
 * receive `structuredContent._meta.loopholeResult` metadata describing the loss.
 */

import { CHARACTER_LIMIT } from '../config/config.js';
import { truncate } from './truncate.js';

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface BoundedResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface NormalizationStats {
  circularReferences: number;
  depthLimitHits: number;
  inaccessibleValues: number;
  omittedCollectionItems: number;
  shortenedStrings: number;
  unsupportedValues: number;
}

interface ResultMetadata {
  readonly truncated: boolean;
  readonly reasons: readonly string[];
  readonly limitBytes: number;
  readonly serializedBytesBeforeLimit?: number;
  readonly circularReferences?: number;
  readonly depthLimitHits?: number;
  readonly inaccessibleValues?: number;
  readonly omittedCollectionItems?: number;
  readonly shortenedStrings?: number;
  readonly unsupportedValues?: number;
}

const MAX_DEPTH = 32;
const MAX_COLLECTION_ITEMS = 512;
const MAX_NORMALIZED_STRING_CHARACTERS = CHARACTER_LIMIT;
const TRUNCATED_TEXT_LIMIT = 2_000;
const META_KEY = '_meta';
const META_NAMESPACE = 'loopholeResult';

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function serializedByteLength(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

function newStats(): NormalizationStats {
  return {
    circularReferences: 0,
    depthLimitHits: 0,
    inaccessibleValues: 0,
    omittedCollectionItems: 0,
    shortenedStrings: 0,
    unsupportedValues: 0,
  };
}

function normalizeString(value: string, stats: NormalizationStats): string {
  if (value.length <= MAX_NORMALIZED_STRING_CHARACTERS) {
    return value;
  }
  stats.shortenedStrings += 1;
  return `${value.slice(0, MAX_NORMALIZED_STRING_CHARACTERS)}[string shortened]`;
}

function setJsonProperty(
  target: { [key: string]: JsonValue },
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalize(
  value: unknown,
  stats: NormalizationStats,
  ancestors: WeakSet<object>,
  depth: number,
): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? normalizeString(value, stats) : value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value;
    }
    stats.unsupportedValues += 1;
    return null;
  }
  if (typeof value === 'bigint') {
    stats.unsupportedValues += 1;
    return `${String(value)}n`;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    stats.unsupportedValues += 1;
    return `[unsupported ${typeof value}]`;
  }

  if (depth >= MAX_DEPTH) {
    stats.depthLimitHits += 1;
    return '[depth limit reached]';
  }
  if (ancestors.has(value)) {
    stats.circularReferences += 1;
    return '[circular reference]';
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_COLLECTION_ITEMS);
      const result: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        try {
          result.push(normalize(value[index], stats, ancestors, depth + 1));
        } catch {
          stats.inaccessibleValues += 1;
          result.push('[inaccessible value]');
        }
      }
      if (value.length > length) {
        stats.omittedCollectionItems += value.length - length;
      }
      return result;
    }

    let keys: string[];
    try {
      keys = Object.keys(value).sort();
    } catch {
      stats.inaccessibleValues += 1;
      return '[inaccessible object]';
    }

    const result: { [key: string]: JsonValue } = {};
    const selectedKeys = keys.slice(0, MAX_COLLECTION_ITEMS);
    if (keys.length > selectedKeys.length) {
      stats.omittedCollectionItems += keys.length - selectedKeys.length;
    }
    for (const key of selectedKeys) {
      try {
        setJsonProperty(
          result,
          key,
          normalize((value as Record<string, unknown>)[key], stats, ancestors, depth + 1),
        );
      } catch {
        stats.inaccessibleValues += 1;
        setJsonProperty(result, key, '[inaccessible value]');
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function hasNormalizationLoss(stats: NormalizationStats): boolean {
  return Object.values(stats).some((count) => count > 0);
}

function metadataFor(
  stats: NormalizationStats,
  sizeTruncated: boolean,
  serializedBytesBeforeLimit?: number,
): ResultMetadata {
  const reasons: string[] = [];
  if (sizeTruncated) reasons.push('serialized_size_limit');
  if (stats.circularReferences > 0) reasons.push('circular_reference');
  if (stats.depthLimitHits > 0) reasons.push('depth_limit');
  if (stats.inaccessibleValues > 0) reasons.push('inaccessible_value');
  if (stats.omittedCollectionItems > 0) reasons.push('collection_limit');
  if (stats.shortenedStrings > 0) reasons.push('string_limit');
  if (stats.unsupportedValues > 0) reasons.push('non_json_value');

  return {
    truncated: true,
    reasons,
    limitBytes: CHARACTER_LIMIT,
    ...(serializedBytesBeforeLimit === undefined ? {} : { serializedBytesBeforeLimit }),
    ...(stats.circularReferences === 0 ? {} : { circularReferences: stats.circularReferences }),
    ...(stats.depthLimitHits === 0 ? {} : { depthLimitHits: stats.depthLimitHits }),
    ...(stats.inaccessibleValues === 0 ? {} : { inaccessibleValues: stats.inaccessibleValues }),
    ...(stats.omittedCollectionItems === 0
      ? {}
      : { omittedCollectionItems: stats.omittedCollectionItems }),
    ...(stats.shortenedStrings === 0 ? {} : { shortenedStrings: stats.shortenedStrings }),
    ...(stats.unsupportedValues === 0 ? {} : { unsupportedValues: stats.unsupportedValues }),
  };
}

function asStructured(value: JsonValue): { [key: string]: JsonValue } {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value;
  }
  return { value };
}

function attachMetadata(
  structured: { [key: string]: JsonValue },
  metadata: ResultMetadata,
): { [key: string]: JsonValue } {
  const existingMeta = structured[META_KEY];
  const mergedMeta =
    typeof existingMeta === 'object' && existingMeta !== null && !Array.isArray(existingMeta)
      ? { ...existingMeta, [META_NAMESPACE]: metadata as unknown as JsonValue }
      : {
          ...(existingMeta === undefined ? {} : { payloadMeta: existingMeta }),
          [META_NAMESPACE]: metadata as unknown as JsonValue,
        };
  return { ...structured, [META_KEY]: mergedMeta };
}

function previewString(value: string, maxBytes: number): string | null {
  if (serializedByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  let best: string | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, midpoint)}[truncated]`;
    if (serializedByteLength(candidate) <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function previewValue(value: JsonValue, maxBytes: number, depth = 0): JsonValue | undefined {
  if (maxBytes <= 0) return undefined;
  if (typeof value === 'string') return previewString(value, maxBytes) ?? undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return serializedByteLength(value) <= maxBytes ? value : undefined;
  }
  if (depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    if (serializedByteLength(out) > maxBytes) return undefined;
    for (const item of value) {
      const currentBytes = serializedByteLength(out);
      const itemPreview = previewValue(item, Math.max(0, maxBytes - currentBytes - 1), depth + 1);
      if (itemPreview === undefined) break;
      const candidate = [...out, itemPreview];
      if (serializedByteLength(candidate) > maxBytes) break;
      out.push(itemPreview);
    }
    return out;
  }

  const out: { [key: string]: JsonValue } = {};
  if (serializedByteLength(out) > maxBytes) return undefined;
  for (const key of Object.keys(value).sort()) {
    const currentBytes = serializedByteLength(out);
    const keyOverhead = serializedByteLength({ [key]: null }) - serializedByteLength(null);
    const itemPreview = previewValue(
      value[key] as JsonValue,
      Math.max(0, maxBytes - currentBytes - keyOverhead),
      depth + 1,
    );
    if (itemPreview === undefined) break;
    const candidate = { ...out, [key]: itemPreview };
    if (serializedByteLength(candidate) > maxBytes) break;
    setJsonProperty(out, key, itemPreview);
  }
  return out;
}

function resultEnvelope(
  text: string,
  structuredContent: Record<string, unknown> | undefined,
  isError: boolean,
): BoundedResult {
  return {
    content: [{ type: 'text', text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(isError ? { isError: true } : {}),
  };
}

function fitStructuredResult(
  text: string,
  structured: { [key: string]: JsonValue },
  metadata: ResultMetadata,
  isError: boolean,
): BoundedResult {
  const boundedText = truncate(text, TRUNCATED_TEXT_LIMIT);
  const minimalStructured = attachMetadata({}, metadata);
  let minimalResult = resultEnvelope(boundedText, minimalStructured, isError);

  if (serializedByteLength(minimalResult) > CHARACTER_LIMIT) {
    minimalResult = resultEnvelope('', minimalStructured, isError);
  }

  let low = 2;
  let high = CHARACTER_LIMIT;
  let best = minimalResult;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const preview = previewValue(structured, midpoint);
    const previewObject =
      typeof preview === 'object' && preview !== null && !Array.isArray(preview) ? preview : {};
    const candidate = resultEnvelope(boundedText, attachMetadata(previewObject, metadata), isError);
    if (serializedByteLength(candidate) <= CHARACTER_LIMIT) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function boundedSuccess(data: unknown, summary?: string): BoundedResult {
  const stats = newStats();
  const normalized = normalize(data, stats, new WeakSet<object>(), 0);
  const structured = asStructured(normalized);
  const text = truncate(summary ?? JSON.stringify(normalized));
  const normalizationLoss = hasNormalizationLoss(stats);
  const initialStructured = normalizationLoss
    ? attachMetadata(structured, metadataFor(stats, false))
    : structured;
  const initialResult = resultEnvelope(text, initialStructured, false);
  const initialBytes = serializedByteLength(initialResult);

  if (initialBytes <= CHARACTER_LIMIT) return initialResult;

  return fitStructuredResult(text, structured, metadataFor(stats, true, initialBytes), false);
}

export function boundedError(message: string, hint?: string, code?: string): BoundedResult {
  const text = hint ? `${message}\nRecovery: ${hint}` : message;
  const structured = code === undefined ? undefined : { code };
  const initialResult = resultEnvelope(truncate(text), structured, true);
  const initialBytes = serializedByteLength(initialResult);
  if (initialBytes <= CHARACTER_LIMIT) return initialResult;

  const metadata = metadataFor(newStats(), true, initialBytes);
  return fitStructuredResult(text, structured ?? {}, metadata, true);
}
