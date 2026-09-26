/**
 * Extension Host sandbox shim. Keep this the first import of `extension.ts`.
 *
 * The Ableton Extension Host (Extension Host 1.0.0, checked on Live 12.4.5b11 through
 * 12.4.15b2) evaluates each extension bundle with `vm.runInContext` inside a context that
 * contains only: `require`, `module`, `__dirname`, `__filename`, a `console` with
 * debug/log/info/warn/error, the four timer functions, `process`, `fetch`, `AbortController`
 * and `Buffer`. Every other global that Node normally exposes is missing there: `Headers`,
 * `Request`, `Response`, `URL`, `TextEncoder`, `Event`, `EventTarget`, `AbortSignal`, the web
 * streams, `crypto`, `performance`, `queueMicrotask`, `structuredClone`, and `global` itself.
 *
 * The bundled MCP SDK and its HTTP layer touch some of those while the bundle is being
 * evaluated (`Object.setPrototypeOf(x.prototype, globalThis.Headers.prototype)` and
 * `global.Request`). Without this shim the bundle throws "Cannot read properties of undefined
 * (reading 'prototype')" during load, and because the host does not isolate load failures,
 * the whole Extension Host exits with code 1 and every installed extension disappears from
 * Live's context menus.
 *
 * `installSandboxGlobals` fills each missing global from Node's public modules, or reads it
 * from the main context's global object where a class is only reachable as a lazy getter
 * there (those getters are plain JS functions bound to the main context, so calling them is
 * safe). `DOMException` is derived from a thrown error instead, because reading its native
 * accessor from another context aborts the process. Under plain Node (vitest, the CLI dev
 * host) every global already exists, so the shim changes nothing.
 */

type Bag = Record<string, unknown>;

/** Resolves a module id the way `require` does. Failures are swallowed by the shim. */
export type ModuleLoader = (id: string) => unknown;

const WEB_STREAM_GLOBALS = [
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'ByteLengthQueuingStrategy',
  'CountQueuingStrategy',
  'TextEncoderStream',
  'TextDecoderStream',
  'CompressionStream',
  'DecompressionStream',
  'ReadableStreamDefaultReader',
  'ReadableStreamBYOBReader',
  'WritableStreamDefaultWriter',
] as const;

/** Only reachable through the main context's global object (lazy getters, no module export). */
const MAIN_CONTEXT_GLOBALS = [
  'Event',
  'EventTarget',
  'CustomEvent',
  'AbortSignal',
  'Headers',
  'Request',
  'Response',
  'FormData',
  'WebSocket',
  'EventSource',
  'MessageEvent',
  'CloseEvent',
  'ErrorEvent',
  'navigator',
] as const;

const CONSOLE_FALLBACKS = [
  'trace',
  'dir',
  'table',
  'time',
  'timeEnd',
  'timeLog',
  'group',
  'groupEnd',
  'count',
  'countReset',
] as const;

/**
 * Define every global the Extension Host sandbox lacks on `target`, without touching the
 * ones that already exist.
 *
 * @param target the sandbox's global object (`globalThis` inside the bundle).
 * @param loader the sandbox's `require`; used to reach Node's public modules.
 */
export function installSandboxGlobals(target: object, loader: ModuleLoader): void {
  const g = target as Bag;

  const define = (name: string, value: unknown): void => {
    if (value === undefined || name in g) return;
    try {
      Object.defineProperty(g, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // A frozen or read-only global: leave it alone.
    }
  };
  const load = (id: string): Bag => {
    try {
      const mod = loader(id);
      return (typeof mod === 'object' && mod !== null) || typeof mod === 'function'
        ? (mod as Bag)
        : {};
    } catch {
      return {};
    }
  };
  const pick = (source: Bag, names: readonly string[]): void => {
    for (const name of names) define(name, source[name]);
  };

  pick(load('node:url'), ['URL', 'URLSearchParams']);
  pick(load('node:util'), ['TextEncoder', 'TextDecoder']);
  pick(load('node:buffer'), ['Blob', 'File', 'atob', 'btoa']);
  pick(load('node:stream/web'), WEB_STREAM_GLOBALS);
  pick(load('node:timers'), ['setImmediate', 'clearImmediate']);
  pick(load('node:worker_threads'), ['MessageChannel', 'MessagePort', 'BroadcastChannel']);
  define('global', g);
  define('performance', load('node:perf_hooks').performance);
  define('crypto', load('node:crypto').webcrypto);
  define('queueMicrotask', (callback: () => void): void => {
    void Promise.resolve().then(callback);
  });
  define('structuredClone', (value: unknown): unknown => {
    const v8 = load('node:v8');
    const { serialize, deserialize } = v8;
    if (typeof serialize !== 'function' || typeof deserialize !== 'function') return value;
    return (deserialize as (data: unknown) => unknown)(
      (serialize as (data: unknown) => unknown)(value),
    );
  });

  const atob = g.atob;
  if (typeof atob === 'function') {
    try {
      (atob as (data: string) => string)('~');
    } catch (error) {
      define('DOMException', (error as { constructor?: unknown } | null)?.constructor);
    }
  }

  const runInThisContext = load('node:vm').runInThisContext;
  if (typeof runInThisContext === 'function') {
    try {
      const main = (runInThisContext as (code: string) => unknown)('globalThis');
      if (typeof main === 'object' && main !== null && main !== g)
        pick(main as Bag, MAIN_CONTEXT_GLOBALS);
    } catch {
      // Not running under `vm`: nothing to copy.
    }
  }

  // The host's console only has debug/log/info/warn/error. Give libraries the rest.
  const con = g.console;
  if (typeof con === 'object' && con !== null) {
    const c = con as Bag;
    const log = typeof c.log === 'function' ? (c.log as (...args: unknown[]) => void) : undefined;
    const error = typeof c.error === 'function' ? (c.error as (...args: unknown[]) => void) : log;
    if (typeof c.assert !== 'function' && error) {
      c.assert = (ok: unknown, ...args: unknown[]): void => {
        if (!ok) error('Assertion failed:', ...args);
      };
    }
    if (log) {
      for (const method of CONSOLE_FALLBACKS) {
        if (typeof c[method] !== 'function') {
          c[method] = (...args: unknown[]): void => {
            if (args.length > 0) log(...args);
          };
        }
      }
    }
  }
}

// Runs once when the bundle is evaluated. Inside the Extension Host sandbox `require` is a
// property of the context object, so it is reachable through `globalThis`; under plain Node
// ESM it is not, and the shim then has nothing to do anyway.
const hostRequire = (globalThis as Bag).require;
installSandboxGlobals(
  globalThis,
  typeof hostRequire === 'function' ? (hostRequire as ModuleLoader) : () => undefined,
);
