/**
 * Ring 1 (unit) — the Zod-validated runtime config (02_BRIDGE_SPEC §1.2, §2).
 *
 * The config is the contract the transport/auth layer (a later wave) and the
 * result helpers read from. The claims pinned here:
 *  - the locked defaults are the documented loopback posture (127.0.0.1, the
 *    8420..8429 probe range, the 25k character limit);
 *  - the host is locked to `127.0.0.1` (never the LAN) and any other host is
 *    rejected;
 *  - an unknown key is rejected (`.strict()`), so a typo fails loudly;
 *  - the `portRangeEnd >= portRangeStart` refinement holds.
 */

import { describe, expect, it } from 'vitest';

import {
  CHARACTER_LIMIT,
  DEFAULT_HOST,
  PORT_RANGE_END,
  PORT_RANGE_START,
  defaultConfig,
  loadConfig,
} from '../config/config.js';

describe('ring 1: loadConfig defaults and validation', () => {
  it('produces the locked loopback defaults when given nothing', () => {
    const config = loadConfig();
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.host).toBe('127.0.0.1');
    expect(config.portRangeStart).toBe(PORT_RANGE_START);
    expect(config.portRangeEnd).toBe(PORT_RANGE_END);
    expect(config.characterLimit).toBe(CHARACTER_LIMIT);
  });

  it('exposes the same defaults via the precomputed defaultConfig', () => {
    expect(defaultConfig).toEqual(loadConfig());
  });

  it('accepts an in-range override', () => {
    const config = loadConfig({ portRangeStart: 9000, portRangeEnd: 9009 });
    expect(config.portRangeStart).toBe(9000);
    expect(config.portRangeEnd).toBe(9009);
  });

  it('rejects a non-loopback host (the bridge is never on the LAN)', () => {
    expect(() => loadConfig({ host: '0.0.0.0' })).toThrow();
  });

  it('rejects an unknown key (strict)', () => {
    expect(() => loadConfig({ bind: 'lan' })).toThrow();
  });

  it('rejects a port below the 1024 floor', () => {
    expect(() => loadConfig({ portRangeStart: 80 })).toThrow();
  });

  it('rejects a port range where end is below start (refine)', () => {
    expect(() => loadConfig({ portRangeStart: 8429, portRangeEnd: 8420 })).toThrow();
  });

  it('rejects a non-positive character limit', () => {
    expect(() => loadConfig({ characterLimit: 0 })).toThrow();
  });
});
