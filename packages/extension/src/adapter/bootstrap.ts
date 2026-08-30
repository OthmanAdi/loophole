/**
 * Transport bootstrap for the in-process Loophole Bridge: port probing, the bearer
 * token + Origin allow list, the `bridge.json` discovery file, and the request
 * gates the `node:http` listener applies before handing a request to the MCP
 * transport.
 *
 * This module imports `node:` built-ins (`crypto`, `fs`, `path`, and the `http`
 * `Server` type) and the core error helpers, but NOT `@ableton-extensions/sdk`: it is
 * plain transport plumbing.
 * It lives under `adapter/` only because it is consumed exclusively by the SDK-facing
 * {@link import("../extension.js")} bootstrap and shares that file's local-only,
 * CI-excluded typecheck lane. The `storageDirectory` it is handed comes from the SDK's
 * {@link Environment.storageDirectory}, which is the one SDK-derived input.
 *
 * Ableton runtime verification is NOT_RUN here: the loopback bind on a real host, the
 * Origin/bearer rejection on a real MCP client, and the `bridge.json` round-trip
 * through `/setup` remain manual checks in `E2E_CHECKLIST.md`. The shapes and Node
 * calls are typed against `@types/node`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import { sdkRejected } from '@othmanadi/loophole-core';

/** The loopback host the bridge always binds; it never exposes `0.0.0.0`. */
export const LOOPBACK_HOST = '127.0.0.1';

/** The MCP endpoint path every request must hit. */
export const MCP_PATH = '/mcp';

/** First port of the bounded `8420..8429` probe range. */
export const PORT_RANGE_START = 8420;

/** Last port of the probe range (inclusive). */
export const PORT_RANGE_END = 8429;

/** Token length in bytes before lowercase hexadecimal encoding. */
const TOKEN_BYTES = 32;

/** Persisted tokens are exactly 32 random bytes encoded as 64 lowercase hex digits. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

/** The discovery file name written into the extension's `storageDirectory`. */
export const BRIDGE_JSON_FILE = 'bridge.json';

/**
 * The exact `bridge.json` shape the `/setup` skill reads. This is the richer discovery
 * shape, not the bare `{ port, token }`: `transport` is always `"http"` and `url` is
 * pre-composed so `/setup` can emit the client config with zero guessing.
 */
export interface BridgeJson {
  /** The loopback port the listener bound (one of {@link PORT_RANGE_START}..{@link PORT_RANGE_END}). */
  readonly port: number;
  /** The bearer token every request must carry (64 lowercase hex digits, 32 bytes). */
  readonly token: string;
  /** Always `"http"` for this transport. */
  readonly transport: 'http';
  /** The full endpoint URL, e.g. `http://127.0.0.1:8420/mcp`. */
  readonly url: string;
}

/** The auth material the listener enforces: the bearer token + the Origin allow list. */
export interface AuthState {
  /** The bearer token (read from / freshly written to `bridge.json`). */
  readonly token: string;
  /**
   * Web origins explicitly allowed. Empty by default: native MCP
   * clients send no `Origin` and pass; any browser `Origin` is rejected unless listed.
   */
  readonly allowedOrigins: readonly string[];
}

/** A resource whose asynchronous `close` releases bridge startup state. */
export interface AsyncClosable {
  close(): Promise<void>;
}

/** Resources that can exist when bridge startup aborts part-way through. */
export interface PartialBridgeResources {
  readonly http: Server | undefined;
  readonly mcp: AsyncClosable | undefined;
  readonly transport: AsyncClosable | undefined;
}

/**
 * Bind `server` to the first free port in `[start, end]` on {@link LOOPBACK_HOST},
 * trying each in turn and advancing past an `EADDRINUSE` to the next. Resolves with the
 * port that bound; rejects only when the whole range is occupied.
 *
 * This is the ONE port routine (the earlier synchronous net-probe was both racy and
 * deadlock-prone: a busy-wait blocks the very libuv callbacks that report the bind
 * result). Binding the real http server directly is correct and race-free — the port we
 * report is the port we actually hold. It is async, so `activate()` calls it via a
 * fire-and-forget `void` (the SDK's `activate` is synchronous and does not await).
 *
 * @param server the `node:http` server to bind (already constructed with its handler).
 * @param start first port to try (default {@link PORT_RANGE_START}).
 * @param end last port to try, inclusive (default {@link PORT_RANGE_END}).
 * @returns the bound port.
 * @throws BridgeError `SDK_REJECTED` if no port in the range is free.
 */
export async function listenOnFreePort(
  server: Server,
  start: number = PORT_RANGE_START,
  end: number = PORT_RANGE_END,
): Promise<number> {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end > 65_535 ||
    start > end
  ) {
    throw sdkRejected(
      `Invalid bridge port range ${String(start)}..${String(end)}.`,
      'Configure an ordered range of TCP ports between 1 and 65535.',
    );
  }
  for (let port = start; port <= end; port += 1) {
    const bound = await tryListen(server, port);
    if (bound) {
      return port;
    }
  }
  throw sdkRejected(
    `No free port in ${String(start)}..${String(end)} for the Loophole bridge.`,
    'Close the other Live instance or extension already using the range, then restart Live.',
  );
}

/**
 * Attempt to bind `server` to one `port` on {@link LOOPBACK_HOST}. Resolves `true` on
 * `listening`, `false` on an `EADDRINUSE` (so the caller tries the next port), and
 * rejects on any other listen error (a real fault, not a busy port). The temporary
 * `error` / `listening` handlers are removed before resolving so they do not leak onto
 * the long-lived server (which keeps its own `error` handler from the caller).
 */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

/**
 * Release every resource created before bridge startup failed. The MCP server owns
 * its connected transport, so a successful MCP close is sufficient. If that close
 * itself fails (or no MCP server was constructed), the transport is closed directly
 * as a fallback. Listener shutdown is attempted first so no new requests arrive while
 * the protocol is being torn down.
 */
export async function cleanupPartialBridge(resources: PartialBridgeResources): Promise<void> {
  const failures: unknown[] = [];

  if (resources.http?.listening === true) {
    try {
      await closeHttpServer(resources.http);
    } catch (error) {
      failures.push(error);
    }
  }

  let mcpClosed = false;
  if (resources.mcp !== undefined) {
    try {
      await resources.mcp.close();
      mcpClosed = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!mcpClosed && resources.transport !== undefined) {
    try {
      await resources.transport.close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to fully clean up partial bridge startup.');
  }
}

/** Close a listening Node HTTP server and await release of the bound port. */
function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

/**
 * Read the bearer token from an existing `bridge.json` in `storageDirectory`, or mint a
 * fresh one (32 bytes, lowercase hex) on first run. The human pastes the token into their
 * client config once; reusing it across sessions keeps that config stable.
 * The Origin allow list is empty by default (native clients pass,
 * web origins are rejected).
 *
 * @param storageDirectory the SDK's per-extension {@link Environment.storageDirectory}.
 *   When the host reports it as `undefined` (it is optional in the SDK), this throws,
 *   because there is nowhere durable to keep the token.
 * @throws BridgeError `SDK_REJECTED` if `storageDirectory` is missing.
 */
export function readOrCreateAuth(storageDirectory: string | undefined): AuthState {
  if (storageDirectory === undefined || storageDirectory.length === 0) {
    throw sdkRejected(
      'No storageDirectory from the Extension Host: cannot persist the bridge token.',
      'This is a host limitation; the bridge cannot start without a storage directory.',
    );
  }
  const existing = tryReadToken(storageDirectory);
  const token = existing ?? mintToken();
  return { token, allowedOrigins: [] };
}

/** Mint a fresh lowercase-hex bearer token with {@link TOKEN_BYTES} bytes of entropy. */
function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Read the `token` field from an existing `bridge.json`, or `null` if the file is
 * absent or unparseable. A corrupt file falls through to a fresh token rather than
 * wedging boot.
 */
function tryReadToken(storageDirectory: string): string | null {
  try {
    const raw = readFileSync(join(storageDirectory, BRIDGE_JSON_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'token' in parsed &&
      typeof parsed.token === 'string' &&
      TOKEN_PATTERN.test(parsed.token)
    ) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the `bridge.json` discovery file into `storageDirectory` with the full shape
 * the `/setup` skill consumes. Creates the directory if it
 * does not exist. Returns the written object so the caller can log the chosen port.
 *
 * @param storageDirectory the SDK's per-extension `storageDirectory`.
 * @param port the bound loopback port from {@link probePort}.
 * @param token the bearer token from {@link readOrCreateAuth}.
 */
export function writeBridgeJson(storageDirectory: string, port: number, token: string): BridgeJson {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw sdkRejected(
      `Refusing to persist invalid bridge port ${String(port)}.`,
      'Restart the extension so it can select a valid loopback port.',
    );
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw sdkRejected(
      'Refusing to persist an invalid bridge bearer token.',
      'Restart the extension so it can rotate the token.',
    );
  }
  const bridge: BridgeJson = {
    port,
    token,
    transport: 'http',
    url: `http://${LOOPBACK_HOST}:${String(port)}${MCP_PATH}`,
  };
  mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
  bestEffortPrivateMode(storageDirectory, 0o700);

  const destination = join(storageDirectory, BRIDGE_JSON_FILE);
  const temporary = join(
    storageDirectory,
    `.${BRIDGE_JSON_FILE}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(bridge, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    bestEffortPrivateMode(temporary, 0o600);
    renameSync(temporary, destination);
    bestEffortPrivateMode(destination, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error;
  }
  return bridge;
}

/** Apply a private POSIX mode where the platform supports it. */
function bestEffortPrivateMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows does not implement POSIX ACL bits; the host profile ACL remains in force.
  }
}

/**
 * The Origin gate, which protects against DNS rebinding. A request with NO
 * `Origin` header passes (native MCP clients send none). An opaque `null` origin is
 * rejected because it cannot identify its caller. A concrete loopback origin passes;
 * any other web origin must be on `allowedOrigins` or it is rejected (the listener
 * returns 403). This runs BEFORE the bearer check and BEFORE
 * `transport.handleRequest`.
 *
 * @returns `true` if the request may proceed past the Origin gate.
 */
export function checkOrigin(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = uniqueHeaderValue(req, 'origin');
  if (origin === undefined) {
    // Native app, no browser Origin: allowed.
    return true;
  }
  if (origin === null || origin === 'null') {
    return false;
  }
  if (isLoopbackOrigin(origin)) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/** True for an `http(s)://localhost` / `127.0.0.1` / `[::1]` origin (any port). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== origin
    ) {
      return false;
    }
    const { hostname } = parsed;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Validate the HTTP `Host` header against the exact endpoint held by this listener.
 * The allow list is deliberately fixed to the IPv4 loopback bind and `localhost`, at
 * the selected port; external names, alternate ports, duplicates, and missing hosts
 * are rejected to prevent DNS rebinding.
 */
export function checkHost(req: IncomingMessage, port: number): boolean {
  const host = uniqueHeaderValue(req, 'host');
  if (host === undefined || host === null || host.includes(',')) {
    return false;
  }
  const normalized = host.toLowerCase();
  return (
    normalized === `${LOOPBACK_HOST}:${String(port)}` || normalized === `localhost:${String(port)}`
  );
}

/**
 * The bearer gate. The request must carry
 * `Authorization: Bearer <token>` exactly matching `token`, or the listener returns
 * 401. Runs AFTER {@link checkOrigin} and BEFORE `transport.handleRequest`. The token
 * is never echoed anywhere the model can see it.
 *
 * @returns `true` if the bearer token matches.
 */
export function checkBearer(req: IncomingMessage, token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) {
    return false;
  }
  const header = uniqueHeaderValue(req, 'authorization');
  if (header === undefined || header === null || header.includes(',')) {
    return false;
  }
  const match = /^Bearer ([0-9a-f]{64})$/u.exec(header);
  if (match === null) {
    return false;
  }
  const presented = match[1] ?? '';
  return timingSafeEqualString(presented, token);
}

/**
 * True if the request targets the MCP endpoint path (`/mcp`), ignoring any query
 * string. The listener returns 404 for anything else so a stray probe to `/` does not
 * reach the transport.
 */
export function isMcpPath(req: IncomingMessage): boolean {
  const url = req.url ?? '';
  const pathOnly = url.split('?', 1)[0] ?? '';
  return pathOnly === MCP_PATH || pathOnly === `${MCP_PATH}/`;
}

/**
 * Return one unambiguous header value. `null` means the wire carried duplicates or a
 * multi-value representation; security gates reject that instead of choosing one.
 * `rawHeaders` is authoritative because Node may collapse or discard duplicates in
 * `headers` before application code sees them.
 */
function uniqueHeaderValue(req: IncomingMessage, name: string): string | null | undefined {
  const rawValues: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) {
      rawValues.push(req.rawHeaders[index + 1] ?? '');
    }
  }
  if (rawValues.length > 1) {
    return null;
  }
  if (rawValues.length === 1) {
    return rawValues[0];
  }

  const value = req.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.length === 1 ? (value[0] ?? '') : null;
  }
  return value;
}

/**
 * Constant-time-ish string compare for the bearer token, so a wrong token cannot be
 * recovered by timing the 401. Compares full length regardless of where the first
 * mismatch is. (`node:crypto.timingSafeEqual` needs equal-length Buffers; this guards
 * the length difference itself without leaking it through an early return.)
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
