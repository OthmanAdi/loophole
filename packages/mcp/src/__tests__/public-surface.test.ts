/**
 * Ring 2 (integration) — the published package surface (`src/index.ts`).
 *
 * `@othmanadi/ableton-mcp` exposes exactly `buildServer`, `VERSION`, and the
 * `LiveBridge` type re-export. A consumer (the extension shell, a standalone host)
 * imports from the barrel, not from `server.ts` directly, so this asserts the
 * public entry resolves and `buildServer` produces a connectable server from the
 * barrel export.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeLiveBridge } from '@othmanadi/loophole-core';

import { buildServer, VERSION } from '../index.js';

describe('ring 2: public package surface (index.ts)', () => {
  it('exports a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it('buildServer from the barrel produces a server that connects and lists 12 tools', async () => {
    const server = buildServer(FakeLiveBridge.seeded());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'surface-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(12);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
