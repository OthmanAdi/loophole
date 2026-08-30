/**
 * Opaque, session-scoped references for objects exposed across the Loophole wire.
 *
 * Unlike the legacy positional path ids, these references contain no Live object
 * path or array index. A caller must resolve them through a session-owned registry,
 * which can reject references that are unknown, expired, or used as the wrong kind.
 * This module deliberately imports neither Node APIs nor either external SDK.
 */

/** Every object kind that may be represented by an opaque session reference. */
export type SessionReferenceKind =
  | 'track'
  | 'scene'
  | 'cue-point'
  | 'clip-slot'
  | 'clip'
  | 'device'
  | 'parameter';

const REFERENCE_TAGS = {
  track: 'trk',
  scene: 'scn',
  'cue-point': 'cue',
  'clip-slot': 'slot',
  clip: 'clip',
  device: 'dev',
  parameter: 'param',
} as const satisfies Readonly<Record<SessionReferenceKind, string>>;

type SessionReferenceTag = (typeof REFERENCE_TAGS)[SessionReferenceKind];

const KINDS_BY_TAG: Readonly<Record<SessionReferenceTag, SessionReferenceKind>> = {
  trk: 'track',
  scn: 'scene',
  cue: 'cue-point',
  slot: 'clip-slot',
  clip: 'clip',
  dev: 'device',
  param: 'parameter',
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const REFERENCE_PATTERN = /^lhref_(trk|scn|cue|slot|clip|dev|param)_([A-Za-z0-9_-]{16,128})$/;

declare const SESSION_REFERENCE_BRAND: unique symbol;

/** A validated opaque reference whose brand retains its object kind. */
export type SessionReference<K extends SessionReferenceKind = SessionReferenceKind> = string & {
  readonly [SESSION_REFERENCE_BRAND]: K;
};

export type TrackReference = SessionReference<'track'>;
export type SceneReference = SessionReference<'scene'>;
export type CuePointReference = SessionReference<'cue-point'>;
export type ClipSlotReference = SessionReference<'clip-slot'>;
export type ClipReference = SessionReference<'clip'>;
export type DeviceReference = SessionReference<'device'>;
export type ParameterReference = SessionReference<'parameter'>;

/** The validated parts of an opaque reference. */
export interface ParsedSessionReference<K extends SessionReferenceKind = SessionReferenceKind> {
  readonly reference: SessionReference<K>;
  readonly kind: K;
  readonly token: string;
}

/** Raised when code attempts to construct or parse a malformed reference. */
export class SessionReferenceParseError extends Error {
  override readonly name = 'SessionReferenceParseError';

  constructor(
    readonly input: string,
    detail: string,
  ) {
    super(`Invalid session reference "${input}": ${detail}`);
  }
}

/**
 * Construct a branded reference from a kind and an opaque base64url-style token.
 * Tokens are intentionally restricted so paths, indices, and delimiters cannot be
 * smuggled into the public reference form.
 */
export function makeSessionReference<K extends SessionReferenceKind>(
  kind: K,
  token: string,
): SessionReference<K> {
  const tag: string | undefined = REFERENCE_TAGS[kind];
  if (tag === undefined) {
    throw new SessionReferenceParseError(String(kind), 'unknown reference kind');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new SessionReferenceParseError(
      token,
      'token must contain 16 to 128 ASCII letters, digits, underscores, or hyphens',
    );
  }
  return `lhref_${tag}_${token}` as SessionReference<K>;
}

/** Parse and strictly validate a raw wire value. */
export function parseSessionReference(input: string): ParsedSessionReference {
  const match = REFERENCE_PATTERN.exec(input);
  if (match === null) {
    throw new SessionReferenceParseError(input, 'expected lhref_<tag>_<opaque-token>');
  }

  const tag = match[1] as SessionReferenceTag;
  const token = match[2];
  const kind = KINDS_BY_TAG[tag];
  if (token === undefined || kind === undefined) {
    throw new SessionReferenceParseError(input, 'unknown reference tag or missing token');
  }

  return {
    reference: input as SessionReference,
    kind,
    token,
  };
}

/** Return a parsed reference, or `null` for malformed and legacy values. */
export function tryParseSessionReference(input: string): ParsedSessionReference | null {
  try {
    return parseSessionReference(input);
  } catch {
    return null;
  }
}

/** True only for a valid opaque reference of the requested kind. */
export function isSessionReferenceOfKind<K extends SessionReferenceKind>(
  input: string,
  kind: K,
): input is SessionReference<K> {
  return tryParseSessionReference(input)?.kind === kind;
}

/** A token source can be injected to make issuance deterministic in tests. */
export type SessionReferenceTokenFactory = () => string;

interface WebCryptoLike {
  getRandomValues<T extends Uint8Array>(values: T): T;
}

function defaultTokenFactory(): string {
  const crypto = (globalThis as typeof globalThis & { crypto?: WebCryptoLike }).crypto;
  if (crypto === undefined) {
    throw new Error('Secure random token generation is unavailable; inject a tokenFactory');
  }

  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let token = '';
  for (const byte of bytes) {
    token += byte.toString(16).padStart(2, '0');
  }
  return token;
}

export interface SessionReferenceRegistryOptions {
  /** Maximum live references. The least recently used entry is evicted first. */
  readonly maxEntries?: number;
  /** Optional secure token source, primarily injected for deterministic tests. */
  readonly tokenFactory?: SessionReferenceTokenFactory;
  /** Maximum attempts to recover from duplicate tokens before throwing. */
  readonly maxTokenAttempts?: number;
  /**
   * Maximum references this registry session may ever issue. Retired references
   * remain reserved until the registry itself is discarded, preventing replay.
   */
  readonly maxIssuedReferences?: number;
}

export type SessionReferenceLookup<T, K extends SessionReferenceKind> =
  | {
      readonly status: 'found';
      readonly reference: SessionReference<K>;
      readonly kind: K;
      readonly value: T;
    }
  | {
      readonly status: 'unknown-or-expired';
    }
  | {
      readonly status: 'wrong-kind';
      readonly expectedKind: K;
      readonly actualKind: SessionReferenceKind;
    };

/** Raised when an injected token source repeatedly returns a live token. */
export class SessionReferenceCollisionError extends Error {
  override readonly name = 'SessionReferenceCollisionError';

  constructor(readonly attempts: number) {
    super(`Unable to issue a unique session reference after ${String(attempts)} attempts`);
  }
}

/** Raised when a registry reaches its configured lifetime issuance ceiling. */
export class SessionReferenceExhaustedError extends Error {
  override readonly name = 'SessionReferenceExhaustedError';

  constructor(readonly maxIssuedReferences: number) {
    super(
      `Session reference registry exhausted its lifetime limit of ${String(maxIssuedReferences)}`,
    );
  }
}

interface RegistryEntry<T> {
  readonly kind: SessionReferenceKind;
  value: T;
}

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_TOKEN_ATTEMPTS = 32;
const DEFAULT_MAX_ISSUED_REFERENCES = 1_048_576;

/**
 * A bounded, session-owned registry for opaque references.
 *
 * `Map` insertion order is used as an LRU queue. Successful reads and writes move
 * their entry to the newest position. Once the bound is reached, issuing another
 * reference evicts the oldest entry, which thereafter resolves as
 * `unknown-or-expired`.
 */
export class SessionReferenceRegistry<T> {
  readonly maxEntries: number;

  readonly #tokenFactory: SessionReferenceTokenFactory;
  readonly #maxTokenAttempts: number;
  readonly #maxIssuedReferences: number;
  readonly #entries = new Map<SessionReference, RegistryEntry<T>>();
  readonly #issuedReferences = new Set<SessionReference>();

  constructor(options: SessionReferenceRegistryOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
    this.#maxTokenAttempts = positiveInteger(
      options.maxTokenAttempts ?? DEFAULT_MAX_TOKEN_ATTEMPTS,
      'maxTokenAttempts',
    );
    this.#maxIssuedReferences = positiveInteger(
      options.maxIssuedReferences ?? DEFAULT_MAX_ISSUED_REFERENCES,
      'maxIssuedReferences',
    );
    if (this.#maxIssuedReferences < this.maxEntries) {
      throw new RangeError('maxIssuedReferences must be greater than or equal to maxEntries');
    }
    this.#tokenFactory = options.tokenFactory ?? defaultTokenFactory;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Issue a new reference and associate it with a registry-owned value. */
  issue<K extends SessionReferenceKind>(kind: K, value: T): SessionReference<K> {
    if (this.#issuedReferences.size >= this.#maxIssuedReferences) {
      throw new SessionReferenceExhaustedError(this.#maxIssuedReferences);
    }

    for (let attempt = 0; attempt < this.#maxTokenAttempts; attempt += 1) {
      const reference = makeSessionReference(kind, this.#tokenFactory());
      if (this.#issuedReferences.has(reference)) {
        continue;
      }

      this.#evictIfFull();
      this.#entries.set(reference, { kind, value });
      this.#issuedReferences.add(reference);
      return reference;
    }

    throw new SessionReferenceCollisionError(this.#maxTokenAttempts);
  }

  /** Resolve a reference, refreshing its LRU position only on a kind-safe hit. */
  resolve<K extends SessionReferenceKind>(
    reference: string,
    expectedKind: K,
  ): SessionReferenceLookup<T, K> {
    const parsed = tryParseSessionReference(reference);
    if (parsed === null) {
      return { status: 'unknown-or-expired' };
    }

    const entry = this.#entries.get(parsed.reference);
    if (entry === undefined) {
      return { status: 'unknown-or-expired' };
    }
    if (entry.kind !== expectedKind) {
      return { status: 'wrong-kind', expectedKind, actualKind: entry.kind };
    }

    this.#touch(parsed.reference, entry);
    return {
      status: 'found',
      reference: parsed.reference as SessionReference<K>,
      kind: expectedKind,
      value: entry.value,
    };
  }

  /** Replace a kind-safe entry's value without changing its public reference. */
  replace<K extends SessionReferenceKind>(
    reference: string,
    expectedKind: K,
    value: T,
  ): SessionReferenceLookup<T, K> {
    const lookup = this.resolve(reference, expectedKind);
    if (lookup.status !== 'found') {
      return lookup;
    }

    const entry = this.#entries.get(lookup.reference);
    if (entry === undefined) {
      return { status: 'unknown-or-expired' };
    }
    entry.value = value;
    this.#touch(lookup.reference, entry);
    return { ...lookup, value };
  }

  /** Derive and store a new value from a kind-safe entry's current value. */
  update<K extends SessionReferenceKind>(
    reference: string,
    expectedKind: K,
    updateValue: (current: T) => T,
  ): SessionReferenceLookup<T, K> {
    const lookup = this.resolve(reference, expectedKind);
    if (lookup.status !== 'found') {
      return lookup;
    }
    return this.replace(lookup.reference, expectedKind, updateValue(lookup.value));
  }

  /** Forget a live reference. Malformed and already-expired values return false. */
  forget(reference: string): boolean {
    const parsed = tryParseSessionReference(reference);
    return parsed === null ? false : this.#entries.delete(parsed.reference);
  }

  /**
   * Expire every live reference. Retired values stay reserved for the remainder of
   * this registry session and can never be issued again.
   */
  clear(): void {
    this.#entries.clear();
  }

  #touch(reference: SessionReference, entry: RegistryEntry<T>): void {
    this.#entries.delete(reference);
    this.#entries.set(reference, entry);
  }

  #evictIfFull(): void {
    if (this.#entries.size < this.maxEntries) {
      return;
    }
    const oldest = this.#entries.keys().next().value;
    if (oldest !== undefined) {
      this.#entries.delete(oldest);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
