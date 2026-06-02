// Loophole extension entry point. PLACEHOLDER for wave W0.
//
// The real activate() lands in wave W1 (Scale Lock): it will call
// initialize(activation, "1.0.0") from @ableton-extensions/sdk, construct the
// AbletonLiveBridge adapter (the only file that imports the SDK), start the
// in-process Streamable HTTP MCP server bound to 127.0.0.1, and register the
// context-menu action. None of that exists yet; this file only has to compile
// standalone so the W0 skeleton typechecks without the vendored SDK .tgz.
//
// Deliberately NO `import` from "@ableton-extensions/sdk" in W0: no vendored
// package exists, so importing it would break the standalone typecheck.

/**
 * The shape Live calls into. Mirrors the SDK's `activate(activation)` signature
 * loosely so the W1 implementation can drop in without churning callers. Typed
 * as `unknown` for now because the real ActivationContext type ships with the
 * vendored SDK in W1 (no `any`, per the strict-TS contract).
 */
export type ActivationContext = unknown;

/**
 * No-op activation. Returns nothing and touches no Live state.
 * Replaced by the real bridge bootstrap in wave W1.
 */
export function activate(_activation: ActivationContext): void {
  // Intentionally empty: wired in wave W1.
}
