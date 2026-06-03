/**
 * Typed error model for the bridge.
 *
 * Every failure the bridge raises is a {@link BridgeError} carrying a stable
 * {@link BridgeErrorCode} and a recovery hint. The tool layer (the Loophole Bridge)
 * maps these to MCP `{ isError: true }` results with the hint inlined, so the model
 * can self-correct in one turn rather than seeing an opaque stack trace.
 *
 * The codes mirror the predictable SDK failure modes called out in API_REFERENCE.md
 * (a handle throws if its object was deleted or is the wrong type) plus the input /
 * rejection / unsupported cases the bridge enforces itself.
 */

/**
 * Stable, machine-checkable error codes.
 *
 * - `STALE_REFERENCE`: an id pointed at an object that no longer exists (deleted,
 *   or never existed). Recovery: re-list and use a fresh id.
 * - `WRONG_TYPE`: an id resolved to the wrong object kind for the operation
 *   (e.g. a `setNotes` on an audio clip). Recovery: use an id from the matching
 *   list/read call.
 * - `BAD_INPUT`: an argument was out of range or malformed before any SDK call
 *   (e.g. a non-positive clip duration, a transaction callback that returned a
 *   non-Promise). Recovery: fix the argument.
 * - `SDK_REJECTED`: the host (or, in the fake, the modeled host rule) rejected an
 *   otherwise well-formed mutation (e.g. an unknown built-in device name).
 *   Recovery: adjust to what the SDK allows.
 * - `UNSUPPORTED`: the operation is not available on this API version / object.
 *   Recovery: avoid it; it is a documented gap, not a transient failure.
 */
export type BridgeErrorCode =
  | 'STALE_REFERENCE'
  | 'WRONG_TYPE'
  | 'BAD_INPUT'
  | 'SDK_REJECTED'
  | 'UNSUPPORTED';

/** Default recovery hints per code, used when a call site does not supply one. */
const DEFAULT_HINTS: Record<BridgeErrorCode, string> = {
  STALE_REFERENCE:
    'That object no longer exists in the Set. Re-list tracks/clips and use a fresh id.',
  WRONG_TYPE:
    'That id is the wrong object type for this operation. Use an id from the matching list/read call.',
  BAD_INPUT: 'An argument was out of range or malformed. Fix it and retry.',
  SDK_REJECTED: 'Live rejected the change. Adjust the request to what the API allows.',
  UNSUPPORTED:
    'This operation is not supported on the current API version. It is a documented gap, not a transient error.',
};

/**
 * The single error type the bridge raises. Carries the {@link BridgeErrorCode}, a
 * recovery hint, and an optional offending id / cause for diagnostics.
 */
export class BridgeError extends Error {
  override readonly name = 'BridgeError';
  readonly code: BridgeErrorCode;
  /** Actionable hint for the caller (and, downstream, for the model). */
  readonly hint: string;
  /** The path id involved, when the failure is about a specific object. */
  readonly subjectId?: string;

  constructor(
    code: BridgeErrorCode,
    message: string,
    options?: { hint?: string; subjectId?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.hint = options?.hint ?? DEFAULT_HINTS[code];
    if (options?.subjectId !== undefined) {
      this.subjectId = options.subjectId;
    }
  }
}

/** Type guard: is `value` a {@link BridgeError}? */
export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

/** Narrow to a {@link BridgeError} with a specific {@link BridgeErrorCode}. */
export function isBridgeErrorOfCode(value: unknown, code: BridgeErrorCode): value is BridgeError {
  return isBridgeError(value) && value.code === code;
}

// --- constructor helpers (so call sites stay one line and consistent) ---

/** An id pointed at a deleted or unknown object. */
export function staleReference(subjectId: string, detail?: string): BridgeError {
  return new BridgeError(
    'STALE_REFERENCE',
    detail ?? `Object "${subjectId}" no longer exists in the Set.`,
    { subjectId },
  );
}

/** An id resolved to the wrong object kind for this operation. */
export function wrongType(subjectId: string, expected: string, detail?: string): BridgeError {
  return new BridgeError('WRONG_TYPE', detail ?? `Object "${subjectId}" is not a ${expected}.`, {
    subjectId,
    hint: `Expected a ${expected}. Use an id from the matching list/read call.`,
  });
}

/** An argument was out of range or malformed before any SDK call. */
export function badInput(message: string, hint?: string): BridgeError {
  return new BridgeError('BAD_INPUT', message, hint === undefined ? undefined : { hint });
}

/** The host rejected an otherwise well-formed mutation. */
export function sdkRejected(message: string, hint?: string): BridgeError {
  return new BridgeError('SDK_REJECTED', message, hint === undefined ? undefined : { hint });
}

/** The operation is not available on this API version / object. */
export function unsupported(message: string, hint?: string): BridgeError {
  return new BridgeError('UNSUPPORTED', message, hint === undefined ? undefined : { hint });
}
