import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_JSON_FILE,
  LOOPBACK_HOST,
  MCP_PATH,
  checkBearer,
  checkHost,
  checkOrigin,
  cleanupPartialBridge,
  listenOnFreePort,
  readOrCreateAuth,
  writeBridgeJson,
  type AsyncClosable,
} from './bootstrap.js';

const tempDirectories: string[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'loophole-bootstrap-'));
  tempDirectories.push(directory);
  return directory;
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return address.port;
}

async function listenEphemeral(server: Server): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  return boundPort(server);
}

async function sendRequest(
  port: number,
  headers: IncomingHttpHeaders = {},
): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      {
        host: LOOPBACK_HOST,
        port,
        path: MCP_PATH,
        method: 'POST',
        headers: { Authorization: `Bearer ${'a'.repeat(64)}`, ...headers },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('loopback request gates', () => {
  it('accepts an authenticated native request for the bound loopback Host', async () => {
    const token = 'a'.repeat(64);
    let port = 0;
    const server = createServer((req, res) => {
      const accepted = checkHost(req, port) && checkOrigin(req, []) && checkBearer(req, token);
      res.writeHead(accepted ? 204 : 403).end();
    });
    port = await listenEphemeral(server);

    await expect(sendRequest(port)).resolves.toBe(204);
  });

  it('rejects an opaque Origin and an untrusted Host', async () => {
    const token = 'a'.repeat(64);
    let port = 0;
    const server = createServer((req, res) => {
      const accepted = checkHost(req, port) && checkOrigin(req, []) && checkBearer(req, token);
      res.writeHead(accepted ? 204 : 403).end();
    });
    port = await listenEphemeral(server);

    await expect(sendRequest(port, { Origin: 'null' })).resolves.toBe(403);
    await expect(sendRequest(port, { Host: `attacker.example:${String(port)}` })).resolves.toBe(
      403,
    );
  });

  it('rejects duplicate Authorization headers instead of selecting one', async () => {
    const token = 'a'.repeat(64);
    let port = 0;
    const server = createServer((req, res) => {
      const accepted = checkHost(req, port) && checkOrigin(req, []) && checkBearer(req, token);
      res.writeHead(accepted ? 204 : 401).end();
    });
    port = await listenEphemeral(server);

    await expect(
      sendRequest(port, { Authorization: [`Bearer ${token}`, `Bearer ${token}`] }),
    ).resolves.toBe(401);
  });
});

describe('token persistence', () => {
  it('rotates malformed legacy tokens and atomically persists a private discovery file', () => {
    const directory = makeTempDirectory();
    const destination = join(directory, BRIDGE_JSON_FILE);
    writeFileSync(destination, JSON.stringify({ token: 'legacy-base64-token' }), 'utf8');

    const first = readOrCreateAuth(directory);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.token).not.toBe('legacy-base64-token');

    const written = writeBridgeJson(directory, 8420, first.token);
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual(written);
    expect(readdirSync(directory)).toEqual([BRIDGE_JSON_FILE]);
    expect(readOrCreateAuth(directory).token).toBe(first.token);

    if (process.platform !== 'win32') {
      expect(statSync(destination).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to persist a token outside the strict 32-byte hex format', () => {
    const directory = makeTempDirectory();
    expect(() => writeBridgeJson(directory, 8420, 'not-a-token')).toThrow(
      'Refusing to persist an invalid bridge bearer token.',
    );
    expect(() => writeBridgeJson(directory, 0, 'a'.repeat(64))).toThrow(
      'Refusing to persist invalid bridge port 0.',
    );
  });
});

describe('port and partial-startup lifecycle', () => {
  it('releases temporary port listeners after an occupied-range rejection', async () => {
    const blocker = createServer();
    const port = await listenEphemeral(blocker);
    const candidate = createServer();
    openServers.push(candidate);
    const baselineListeningListeners = candidate.listenerCount('listening');

    await expect(listenOnFreePort(candidate, port, port)).rejects.toThrow('No free port');
    expect(candidate.listening).toBe(false);
    expect(candidate.listenerCount('listening')).toBe(baselineListeningListeners);
    expect(candidate.listenerCount('error')).toBe(0);
  });

  it('closes the listener and MCP-owned transport after partial startup', async () => {
    const server = createServer();
    await listenEphemeral(server);
    let mcpCloses = 0;
    let transportCloses = 0;
    const transport: AsyncClosable = {
      close: async () => {
        transportCloses += 1;
      },
    };
    const mcp: AsyncClosable = {
      close: async () => {
        mcpCloses += 1;
        await transport.close();
      },
    };

    await cleanupPartialBridge({ http: server, mcp, transport });

    expect(server.listening).toBe(false);
    expect(mcpCloses).toBe(1);
    expect(transportCloses).toBe(1);
  });

  it('falls back to closing the transport when MCP cleanup fails', async () => {
    let transportCloses = 0;
    const transport: AsyncClosable = {
      close: async () => {
        transportCloses += 1;
      },
    };
    const mcp: AsyncClosable = {
      close: async () => {
        throw new Error('mcp close failed');
      },
    };

    await expect(cleanupPartialBridge({ http: undefined, mcp, transport })).rejects.toThrow(
      'Failed to fully clean up partial bridge startup.',
    );
    expect(transportCloses).toBe(1);
  });
});
