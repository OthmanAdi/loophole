/**
 * The Loophole Bridge server version, reported to MCP clients in the
 * `initialize` handshake (`McpServer({ name, version })`).
 *
 * Kept as a hand-maintained constant rather than read from `package.json` at
 * runtime so the value survives bundling (the published bundle does not ship
 * `package.json` next to the entry) and so `verbatimModuleSyntax` / NodeNext do
 * not need a JSON import assertion. Bump it in lockstep with the package version.
 */
export const VERSION = '0.0.0';
