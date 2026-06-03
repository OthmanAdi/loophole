/**
 * Transport bootstrap for the in-process Loophole Bridge: port probing, the bearer
 * token + Origin allow list, the `bridge.json` discovery file, and the two request
 * gates the `node:http` listener applies before handing a request to the MCP
 * transport (02_BRIDGE_SPEC §1.3 + §2; ARCHITECTURE_DECISIONS §4).
 *
 * This module imports `node:` built-ins (`crypto`, `fs`, `path`, and the `http`
 * `Server` type) and the core error helpers, but NOT `@ableton-extensions/sdk`: it is
 * plain transport plumbing.
 * It lives under `adapter/` only because it is consumed exclusively by the SDK-facing
 * {@link import("../extension.js")} bootstrap and shares that file's local-only,
 * CI-excluded typecheck lane. The `storageDirectory` it is handed comes from the SDK's
 * {@link Environment.storageDirectory}, which is the one SDK-derived input.
 *
 * RING-3 PENDING (no Ableton here; none of this is Live-proven): the loopback bind on
 * a real host, the Origin/bearer rejection on a real MCP client, and the round-trip of
 * `bridge.json` through the W7 `/setup` skill are verified only by the manual
 * `E2E_CHECKLIST.md`. The shapes and the Node calls are typed against `@types/node`.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import { sdkRejected } from '@othmanadi/loophole-core';

/** The loopback host the bridge always binds (never `0.0.0.0`; 02_BRIDGE_SPEC §2). */
export const LOOPBACK_HOST = '127.0.0.1';

/** The MCP endpoint path every request must hit (02_BRIDGE_SPEC §1.3). */
export const MCP_PATH = '/mcp';

/** First port of the probe range (02_BRIDGE_SPEC §1.2 / §1.3: `8420..8429`). */
export const PORT_RANGE_START = 8420;

/** Last port of the probe range (inclusive). */
export const PORT_RANGE_END = 8429;

/** Token length in bytes before base64url encoding (02_BRIDGE_SPEC §2: ≥ 16 bytes). */
const TOKEN_BYTES = 32;

/** The discovery file name written into the extension's `storageDirectory`. */
export const BRIDGE_JSON_FILE = 'bridge.json';

/**
 * The exact `bridge.json` shape the W7 `/setup` skill reads (ARCHITECTURE_DECISIONS
 * §4, the richer shape, NOT the bare `{ port, token }`). `transport` is always
 * `"http"` and `url` is pre-composed so `/setup` can emit the client config with zero
 * guessing.
 */
export interface BridgeJson {
  /** The loopback port the listener bound (one of {@link PORT_RANGE_START}..{@link PORT_RANGE_END}). */
  readonly port: number;
  /** The bearer token every request must carry (base64url, ≥ 16 bytes of entropy). */
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
   * Web origins explicitly allowed. Empty by default (02_BRIDGE_SPEC §2): native MCP
   * clients send no `Origin` and pass; any browser `Origin` is rejected unless listed.
   */
  readonly allowedOrigins: readonly string[];
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
 * Read the bearer token from an existing `bridge.json` in `storageDirectory`, or mint a
 * fresh one (≥ 16 bytes, base64url) on first run. The human pastes the token into their
 * client config once; reusing it across sessions keeps that config stable
 * (02_BRIDGE_SPEC §2). The Origin allow list is empty by default (native clients pass,
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

/** Mint a fresh base64url bearer token with {@link TOKEN_BYTES} bytes of entropy. */
function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
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
      typeof (parsed as { token: unknown }).token === 'string' &&
      (parsed as { token: string }).token.length > 0
    ) {
      return (parsed as { token: string }).token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the `bridge.json` discovery file into `storageDirectory` with the full shape
 * the `/setup` skill consumes (ARCHITECTURE_DECISIONS §4). Creates the directory if it
 * does not exist. Returns the written object so the caller can log the chosen port.
 *
 * @param storageDirectory the SDK's per-extension `storageDirectory`.
 * @param port the bound loopback port from {@link probePort}.
 * @param token the bearer token from {@link readOrCreateAuth}.
 */
export function writeBridgeJson(storageDirectory: string, port: number, token: string): BridgeJson {
  const bridge: BridgeJson = {
    port,
    token,
    transport: 'http',
    url: `http://${LOOPBACK_HOST}:${String(port)}${MCP_PATH}`,
  };
  mkdirSync(storageDirectory, { recursive: true });
  writeFileSync(join(storageDirectory, BRIDGE_JSON_FILE), `${JSON.stringify(bridge, null, 2)}\n`, {
    encoding: 'utf8',
  });
  return bridge;
}

/**
 * The Origin gate (02_BRIDGE_SPEC §2, the DNS-rebinding guard). A request with NO
 * `Origin` header passes (native MCP clients send none). A request whose `Origin` is a
 * `null`/loopback origin passes. Any other web origin must be on `allowedOrigins` or it
 * is rejected (the listener returns 403). This runs BEFORE the bearer check and BEFORE
 * `transport.handleRequest`.
 *
 * @returns `true` if the request may proceed past the Origin gate.
 */
export function checkOrigin(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin === undefined) {
    // Native app, no browser Origin: allowed.
    return true;
  }
  if (origin === 'null' || isLoopbackOrigin(origin)) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/** True for an `http(s)://localhost` / `127.0.0.1` / `[::1]` origin (any port). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
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
 * The bearer gate (02_BRIDGE_SPEC §2). The request must carry
 * `Authorization: Bearer <token>` exactly matching `token`, or the listener returns
 * 401. Runs AFTER {@link checkOrigin} and BEFORE `transport.handleRequest`. The token
 * is never echoed anywhere the model can see it.
 *
 * @returns `true` if the bearer token matches.
 */
export function checkBearer(req: IncomingMessage, token: string): boolean {
  const header = headerValue(req.headers.authorization);
  if (header === undefined) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return false;
  }
  const presented = header.slice(prefix.length).trim();
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
 * Normalize a Node header value (which may be `string | string[] | undefined`) to a
 * single string, or `undefined` when absent. A repeated header takes its first value.
 */
function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value as string;
}

/**
 * Constant-time-ish string compare for the bearer token, so a wrong token cannot be
 * recovered by timing the 401. Compares full length regardless of where the first
 * mismatch is. (`node:crypto.timingSafeEqual` needs equal-length Buffers; this guards
 * the length difference itself without leaking it through an early return.)
 */
function timingSafeEqualString(a: string, b: string): boolean {
  let mismatch = a.length === b.length ? 0 : 1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    // charCodeAt past the end is NaN; XOR-ing with a sentinel keeps the loop constant.
    const ca = i < a.length ? a.charCodeAt(i) : -1;
    const cb = i < b.length ? b.charCodeAt(i) : -1;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}
