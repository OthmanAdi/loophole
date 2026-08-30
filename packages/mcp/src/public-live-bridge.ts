/**
 * The published bridge port deliberately erases core's nominal session-reference
 * brands to plain wire strings. References are opaque capabilities at runtime, but
 * their unique-symbol brands are package-local TypeScript implementation details.
 *
 * Keeping this port structural lets the extension's core-backed `AbletonLiveBridge`
 * satisfy the published package contract without asking consumers to install the
 * private core package or receiving a second, incompatible copy of its brands.
 */

import type { LiveBridge as CoreLiveBridge } from '@othmanadi/loophole-core';

type BivariantMethod<Args extends readonly unknown[], Result> = {
  method(...args: Args): Result;
}['method'];

type WireTuple<Values extends readonly unknown[]> = {
  [Index in keyof Values]: WireValue<Values[Index]>;
};

type WireValue<Value> = Value extends (...args: infer Args) => infer Result
  ? BivariantMethod<WireTuple<Args>, WireValue<Result>>
  : Value extends Promise<infer Result>
    ? Promise<WireValue<Result>>
    : Value extends readonly (infer Item)[]
      ? readonly WireValue<Item>[]
      : Value extends string
        ? string
        : Value extends object
          ? { [Key in keyof Value]: WireValue<Value[Key]> }
          : Value;

/**
 * Public, SDK-free bridge contract. Object references cross this boundary as opaque
 * strings; consumers must obtain them from the matching list/read response rather
 * than inventing values.
 */
export type LiveBridge = WireValue<CoreLiveBridge>;

/**
 * Internal adaptation point between the structural public contract and core's
 * nominal reference brands. Both describe the same runtime strings and methods.
 */
export function toCoreLiveBridge(bridge: LiveBridge): CoreLiveBridge {
  return bridge as CoreLiveBridge;
}
