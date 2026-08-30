/** SDK-free, fail-closed validation for extension modal payloads. */

import type { HumanizeOpts, SnapMode } from '@othmanadi/loophole-core';
import { parseModalResult } from './support.js';

const HUMANIZE_APPLY_KEYS = [
  'strength',
  'swing',
  'doTiming',
  'doVelocity',
  'doDuration',
  'living',
] as const;
const HUMANIZE_CANCEL_KEYS = ['strength'] as const;
const SCALE_LOCK_KEYS = ['mode'] as const;
const SESSION_TO_SONG_KEYS = ['sections'] as const;
const SECTION_KEYS = ['name', 'sceneIndex', 'bars'] as const;
const SECTION_WITH_COLOR_KEYS = ['name', 'sceneIndex', 'bars', 'color'] as const;
const SET_JANITOR_KEYS = ['chosenIssueIds'] as const;

/** A validated Session-to-Song row, copied away from the untrusted payload. */
export interface ValidatedSectionInput {
  readonly name: string;
  readonly sceneIndex: number;
  readonly bars: number;
  readonly color?: number;
}

/**
 * Require a normal object with exactly the expected own enumerable keys. Objects with
 * custom/null prototypes, access traps, inherited fields, arrays, and extra keys fail
 * closed. JSON.parse produces normal objects, so this does not reject shipped payloads.
 */
export function isExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) return false;
    const expected = new Set(expectedKeys);
    return keys.every(
      (key) =>
        typeof key === 'string' &&
        Object.prototype.propertyIsEnumerable.call(value, key) &&
        expected.has(key),
    );
  } catch {
    return false;
  }
}

/** Parse raw modal JSON, then keep it unknown until `validate` accepts it. */
export function parseValidatedModal<T>(
  raw: string,
  validate: (value: unknown) => T | null,
): T | null {
  return validate(parseModalResult(raw));
}

/**
 * Invoke `apply` only for a validated payload. Returning `false` proves cancel and
 * malformed results cannot reach a command handler or Live write.
 */
export async function dispatchValidatedModal<T>(
  raw: string,
  validate: (value: unknown) => T | null,
  apply: (value: T) => Promise<void>,
): Promise<boolean> {
  const value = parseValidatedModal(raw, validate);
  if (value === null) return false;
  await apply(value);
  return true;
}

/** Validate the exact shipped Humanize apply/cancel contract. */
export function validateHumanizeModal(value: unknown): HumanizeOpts | null {
  try {
    if (isExactPlainRecord(value, HUMANIZE_CANCEL_KEYS) && value.strength === null) {
      return null;
    }
    if (!isExactPlainRecord(value, HUMANIZE_APPLY_KEYS)) return null;
    const { strength, swing, doTiming, doVelocity, doDuration, living } = value;
    if (!isUnitInterval(strength) || !isUnitInterval(swing)) return null;
    if (
      typeof doTiming !== 'boolean' ||
      typeof doVelocity !== 'boolean' ||
      typeof doDuration !== 'boolean' ||
      typeof living !== 'boolean'
    ) {
      return null;
    }
    return { strength, swing, doTiming, doVelocity, doDuration, living };
  } catch {
    return null;
  }
}

/** Validate the exact shipped Scale Lock apply/cancel contract. */
export function validateScaleLockModal(value: unknown): SnapMode | null {
  try {
    if (!isExactPlainRecord(value, SCALE_LOCK_KEYS)) return null;
    const { mode } = value;
    if (mode === null) return null;
    if (mode !== 'up' && mode !== 'down' && mode !== 'nearest') return null;
    return mode;
  } catch {
    return null;
  }
}

/** Validate and copy the exact shipped Session-to-Song section-map contract. */
export function validateSessionToSongModal(
  value: unknown,
): readonly ValidatedSectionInput[] | null {
  try {
    if (!isExactPlainRecord(value, SESSION_TO_SONG_KEYS)) return null;
    if (value.sections === null) return null;
    if (!Array.isArray(value.sections)) return null;
    const sections: ValidatedSectionInput[] = [];
    for (const section of value.sections) {
      const hasColor = isExactPlainRecord(section, SECTION_WITH_COLOR_KEYS);
      if (!hasColor && !isExactPlainRecord(section, SECTION_KEYS)) return null;
      const { name, sceneIndex, bars } = section;
      if (
        typeof name !== 'string' ||
        typeof sceneIndex !== 'number' ||
        !Number.isSafeInteger(sceneIndex) ||
        sceneIndex < 0 ||
        typeof bars !== 'number' ||
        !Number.isFinite(bars) ||
        bars <= 0
      ) {
        return null;
      }
      if (hasColor) {
        const { color } = section;
        if (typeof color !== 'number' || !Number.isFinite(color)) return null;
        sections.push({ name, sceneIndex, bars, color });
      } else {
        sections.push({ name, sceneIndex, bars });
      }
    }
    return sections;
  } catch {
    return null;
  }
}

/** Validate and copy the exact shipped Set Janitor selection contract. */
export function validateSetJanitorModal(value: unknown): readonly string[] | null {
  try {
    if (!isExactPlainRecord(value, SET_JANITOR_KEYS)) return null;
    if (value.chosenIssueIds === null) return null;
    if (!Array.isArray(value.chosenIssueIds)) return null;
    if (!value.chosenIssueIds.every((issueId) => typeof issueId === 'string')) return null;
    return [...value.chosenIssueIds];
  } catch {
    return null;
  }
}

/**
 * Bind a Set Janitor selection to the exact issue IDs rendered for this invocation.
 * Forged IDs and duplicates fail closed instead of reaching the re-detecting handler.
 */
export function authorizeSetJanitorSelection(
  chosenIssueIds: readonly string[],
  renderedIssueIds: readonly string[],
): readonly string[] | null {
  const allowed = new Set(renderedIssueIds);
  const seen = new Set<string>();
  const authorized: string[] = [];
  for (const issueId of chosenIssueIds) {
    if (!allowed.has(issueId) || seen.has(issueId)) return null;
    seen.add(issueId);
    authorized.push(issueId);
  }
  return authorized;
}

/** Validate, authorize, and dispatch one Set Janitor modal result. */
export async function dispatchSetJanitorModal(
  raw: string,
  renderedIssueIds: readonly string[],
  apply: (chosenIssueIds: readonly string[]) => Promise<void>,
): Promise<boolean> {
  const chosen = parseValidatedModal(raw, validateSetJanitorModal);
  if (chosen === null || chosen.length === 0) return false;
  const authorized = authorizeSetJanitorSelection(chosen, renderedIssueIds);
  if (authorized === null) return false;
  await apply(authorized);
  return true;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
