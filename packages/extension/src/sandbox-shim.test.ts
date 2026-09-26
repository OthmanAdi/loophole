import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { installSandboxGlobals } from './sandbox-shim.js';

const load = createRequire(import.meta.url);
const noop = (): void => undefined;

/**
 * Mirrors the context object the Ableton Extension Host 1.0.0 passes to `vm.createContext`
 * before it runs an extension bundle with `vm.runInContext`.
 */
function hostContext(): Record<string, unknown> {
  const context: Record<string, unknown> = {
    require: load,
    module: { exports: {} },
    __dirname: '',
    __filename: '',
    console: { debug: noop, log: noop, info: noop, warn: noop, error: noop },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    process,
    fetch,
    AbortController,
    Buffer,
  };
  createContext(context);
  return context;
}

const typeOf = (context: Record<string, unknown>, name: string): unknown =>
  runInContext(`typeof ${name}`, context);

describe('installSandboxGlobals', () => {
  it('starts from a host context that lacks the web globals the MCP stack reads at load time', () => {
    const context = hostContext();
    expect(typeOf(context, 'Headers')).toBe('undefined');
    expect(typeOf(context, 'URL')).toBe('undefined');
    expect(typeOf(context, 'Event')).toBe('undefined');
    expect(typeOf(context, 'global')).toBe('undefined');
  });

  it('fills the missing globals so the load-time prototype access no longer throws', () => {
    const context = hostContext();
    installSandboxGlobals(context, load);

    const expected = [
      'Headers',
      'Request',
      'Response',
      'URL',
      'URLSearchParams',
      'TextEncoder',
      'TextDecoder',
      'Event',
      'EventTarget',
      'AbortSignal',
      'ReadableStream',
      'TransformStream',
      'crypto',
      'performance',
      'queueMicrotask',
      'structuredClone',
      'DOMException',
      'global',
    ];
    for (const name of expected) {
      expect(typeOf(context, name), name).not.toBe('undefined');
    }

    // The two expressions that used to take the Extension Host down.
    expect(() => {
      runInContext(
        'Object.setPrototypeOf(class {}.prototype, Headers.prototype); global.Request',
        context,
      );
    }).not.toThrow();
    expect(runInContext('new URL("http://127.0.0.1:8420/mcp").port', context)).toBe('8420');
    expect(runInContext('class E extends Event {} new E("x").type', context)).toBe('x');
    expect(runInContext('new TextEncoder().encode("é").length', context)).toBe(2);
  });

  it('never overwrites a global that already exists', () => {
    const context = hostContext();
    const marker = Symbol('kept');
    context.URL = marker;
    installSandboxGlobals(context, load);
    expect(context.URL).toBe(marker);
    expect(context.fetch).toBe(fetch);
    expect(context.Buffer).toBe(Buffer);
  });

  it('adds the console methods the host leaves out and keeps the ones it provides', () => {
    const context = hostContext();
    const provided = context.console as Record<string, unknown>;
    const originalError = provided.error;
    installSandboxGlobals(context, load);
    expect(provided.error).toBe(originalError);
    expect(typeof provided.assert).toBe('function');
    expect(typeof provided.table).toBe('function');
    expect(() => {
      runInContext('console.assert(false, "x"); console.time("t"); console.timeEnd("t")', context);
    }).not.toThrow();
  });

  it('changes nothing on a normal Node global object', () => {
    const before = Object.getOwnPropertyNames(globalThis).length;
    installSandboxGlobals(globalThis, load);
    expect(Object.getOwnPropertyNames(globalThis).length).toBe(before);
    expect(globalThis.URL).toBe(URL);
  });

  it('swallows loader failures instead of throwing during bundle evaluation', () => {
    const context = hostContext();
    const failing = (): never => {
      throw new Error('module resolution blocked');
    };
    expect(() => installSandboxGlobals(context, failing)).not.toThrow();
    expect(typeOf(context, 'global')).toBe('object');
  });
});
