/**
 * Loophole extension entry point: `activate()`.
 *
 * This is the SDK wiring shell (03_EXTENSIONS_SPEC §0 layer 3 / 02_BRIDGE_SPEC §1.3).
 * It is the file Live calls when the extension loads. It:
 *
 *  1. initializes the SDK (`initialize(activation, "1.0.0")`),
 *  2. constructs the one SDK-touching object, {@link AbletonLiveBridge}, from the
 *     resulting context (the only object that holds a `Handle` / calls the SDK),
 *  3. builds the transport-agnostic MCP server via `buildServer(bridge)` from the
 *     published `@othmanadi/ableton-mcp`, and connects it to a stateless
 *     `StreamableHTTPServerTransport`,
 *  4. starts a `node:http` listener bound to `127.0.0.1` on the first free port in
 *     `8420..8429`, gating every request on the Origin allow list (403) and the bearer
 *     token (401) BEFORE handing it to `transport.handleRequest`, at the `/mcp` path,
 *  5. writes `bridge.json` (`{ port, token, transport, url }`) into the extension's
 *     `storageDirectory` for the `/setup` skill to read, and
 *  6. registers all five context-menu commands, each wired to its pure-core handler.
 *
 * Per 02_BRIDGE_SPEC §1.1 everything started here lives for the whole Live session: the
 * server, the transport, the queue inside the bridge, and the HTTP listener.
 *
 * This file imports `@ableton-extensions/sdk` (via `initialize`) and the SDK-facing
 * command modules + adapter, so it is EXCLUDED from the committed CI tsconfig (it cannot
 * typecheck without the SDK present) and is typechecked LOCALLY against the real
 * extracted v1.0.0-beta.0 types through `tsconfig.live.json`.
 *
 * RING-3 PENDING (no Ableton here; none of this has run in real Live): the loopback
 * bind, the Origin/bearer rejection on a live MCP client, the one-undo behavior of each
 * command, and the `.ablx` install + hot-load flow are verified only by the manual
 * `E2E_CHECKLIST.md`. Every SDK call is typed against the genuine `.d.mts`.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { initialize, type ActivationContext } from '@ableton-extensions/sdk';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildServer } from '@othmanadi/ableton-mcp';
import { AbletonLiveBridge } from './adapter/live-bridge.ableton.js';
import {
  checkBearer,
  checkOrigin,
  isMcpPath,
  listenOnFreePort,
  readOrCreateAuth,
  writeBridgeJson,
} from './adapter/bootstrap.js';
import { register as registerScaleLock } from './commands/scale-lock.command.js';
import { register as registerHumanize } from './commands/humanize.command.js';
import { register as registerGainStageDoctor } from './commands/gain-stage-doctor.command.js';
import { register as registerSessionToSong } from './commands/session-to-song.command.js';
import { register as registerSetJanitor } from './commands/set-janitor.command.js';

/** The API version this extension pins everywhere (matches the adapter's `V`). */
const API_VERSION = '1.0.0';

/** HTTP status codes the gates and listener return. */
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

/**
 * Live calls this when the extension loads. It wires the in-process Loophole Bridge and
 * all five context-menu commands, then returns (the server + listener keep running for
 * the whole session). Any startup failure is logged to stderr (teed to
 * `ExtensionHost.txt`) rather than thrown, so a port/storage problem disables the
 * bridge without crashing the host; the context-menu commands are registered first so
 * they work even if the MCP bridge could not bind.
 */
export function activate(activation: ActivationContext): void {
  const context = initialize(activation, API_VERSION);
  const bridge = new AbletonLiveBridge(context);

  // Register the five context-menu commands first (they do not depend on the MCP
  // transport, so the extensions work even if the bridge fails to bind a port).
  registerScaleLock(context, bridge);
  registerHumanize(context, bridge);
  registerGainStageDoctor(context, bridge);
  registerSessionToSong(context, bridge);
  registerSetJanitor(context, bridge);

  // Start the in-process Streamable HTTP MCP server (02_BRIDGE_SPEC §1.3). Fire and
  // forget: `activate` is synchronous (the SDK's contract), the bind is async, and any
  // startup failure is logged inside, so the context-menu commands above keep working.
  void startBridgeServer(context, bridge);
}

/**
 * Build the MCP server, connect it to a stateless Streamable HTTP transport, bind a
 * loopback `node:http` listener on the first free port, gate every request, and persist
 * `bridge.json`. Failures are logged and swallowed (the commands above still work).
 */
async function startBridgeServer(
  context: ReturnType<typeof initialize<typeof API_VERSION>>,
  bridge: AbletonLiveBridge,
): Promise<void> {
  try {
    const server = buildServer(bridge);
    // Stateless mode (one Live session = one logical MCP session, 02_BRIDGE_SPEC §1.3):
    // per the SDK docstring, OMITTING `sessionIdGenerator` disables session management,
    // identical to the docstring's `sessionIdGenerator: undefined`. We omit it rather
    // than pass `undefined` because the SDK types the field as optional-not-`| undefined`
    // and our `exactOptionalPropertyTypes` rejects an explicit `undefined`.
    const transport = new StreamableHTTPServerTransport({});
    // Wire the McpServer to the transport once, at boot. `StreamableHTTPServerTransport`
    // IS a `Transport`, but it declares `onclose`/`onerror`/`onmessage` as accessor pairs
    // typed `(() => void) | undefined`, which under `exactOptionalPropertyTypes` are not
    // assignable to `Transport`'s optional `onclose?: () => void` form. This is a
    // third-party `.d.ts` ergonomics gap (the SDK's own `StdioServerTransport` uses plain
    // optionals and connects with no cast), not a real incompatibility, so we widen to the
    // `Transport` interface the method expects at this one boundary.
    await server.connect(transport as Transport);

    const { token, allowedOrigins } = readOrCreateAuth(context.environment.storageDirectory);

    const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      // §2: loopback is enforced by the bind; check the path, then Origin, then bearer,
      // BEFORE handing the request to the transport. Never read the body here (the
      // transport parses it); only the headers are inspected.
      if (!isMcpPath(req)) {
        res.writeHead(HTTP_NOT_FOUND).end();
        return;
      }
      if (!checkOrigin(req, allowedOrigins)) {
        res.writeHead(HTTP_FORBIDDEN).end();
        return;
      }
      if (!checkBearer(req, token)) {
        res.writeHead(HTTP_UNAUTHORIZED).end();
        return;
      }
      void transport.handleRequest(req, res).catch((error: unknown) => {
        console.error('[loophole] transport.handleRequest failed:', error);
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });

    // The long-lived error handler (kept after the bind; listenOnFreePort attaches and
    // removes its own temporary one-shot handlers during probing).
    http.on('error', (error: unknown) => {
      console.error('[loophole] bridge HTTP listener error:', error);
    });

    // Bind to the first free port in 8420..8429 (race-free: we report the port we hold).
    const port = await listenOnFreePort(http);

    const storage = context.environment.storageDirectory;
    if (storage !== undefined) {
      const written = writeBridgeJson(storage, port, token);
      console.error(`[loophole] bridge listening on ${written.url}`);
    }
  } catch (error) {
    console.error('[loophole] failed to start the MCP bridge (commands still work):', error);
  }
}

export type { ActivationContext };
