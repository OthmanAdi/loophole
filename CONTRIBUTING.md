# Contributing to Loophole

Thanks for looking at the internals. This file is the load-bearing one: it states the single rule that keeps the codebase testable and the practical steps to run, change, and submit code. Read the [README](README.md) first for the architecture overview.

Loophole is pre-release and built in the open against the Ableton Extensions SDK public beta. Expect the surface to move while the SDK is in beta.

## The one rule: everything Ableton goes through `LiveBridge`

The whole project hangs on one seam. `LiveBridge` is a plain TypeScript interface (DTOs in, DTOs out, opaque string ids, no Ableton types). Two things implement it:

- `AbletonLiveBridge` (in `packages/extension`) wraps the real SDK. It is **the only file in the repo that imports `@ableton-extensions/sdk`.** It contains almost no logic, just translation.
- `FakeLiveBridge` (a shipped export of `@othmanadi/ableton-mcp`, used for testing the server without Ableton) is an in-memory model of a Live Set that reproduces the SDK contract: sync getters, async mutators, read-map-assign for notes, pitch clamped to 0..127, a deleted handle throws, and `withinTransaction` takes a synchronous callback.

Two corollaries, both enforced in review:

1. No file outside the adapter may import `@ableton-extensions/sdk`. No `Handle`, no `bigint` object reference, no `instanceof MidiClip` outside the adapter.
2. Logic lives in tested modules. The SDK adapter only translates, which is why it is excluded from coverage (it is the one file that genuinely cannot run in CI). If you find yourself writing a branch inside the adapter, the logic probably belongs in a tested module.

The dependency direction is: `transport` imports `tools` imports `domain` (the `LiveBridge` interface). The domain depends on nothing. If a change breaks that direction, the layering is gone and the change needs rework.

## You do not need a Live license to contribute

This is the point most Ableton tooling gets wrong. Because all Ableton access is behind `FakeLiveBridge` in tests, the entire server is exercised on Linux, in milliseconds, with no Ableton install and no license. You only need Live for the manual ring 3 smoke pass, and only when you change behavior that actually runs inside Live.

## Test rings

There are three rings. Most assertions live in ring 1. Rings 1 and 2 run in CI on every push and need no Live.

| Ring           | Needs Live?  | What it proves                                                                          | How                                               |
| -------------- | ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1. Unit        | no           | Tool handler logic, Zod input validation, pure music transforms                         | `vitest`                                          |
| 2. Integration | no           | Full client to server to tool to `FakeLiveBridge` round-trip over the real MCP protocol | `vitest` + `InMemoryTransport.createLinkedPair()` |
| 3. Smoke       | yes (manual) | The real `.ablx` in Live actually moves notes, and one undo reverts                     | tagged checklist, run by hand before a release    |

### Running locally

The repo uses pnpm workspaces. From the repo root:

```bash
pnpm install --ignore-scripts   # supply-chain hardening; see SECURITY.md
pnpm typecheck                  # tsc --noEmit across all packages (hard gate)
pnpm lint                       # eslint across all packages
pnpm test                       # vitest, rings 1 and 2
pnpm build                      # build all packages
pnpm format:check               # prettier --check .
```

Run `pnpm format` to fix formatting before you push.

### Keeping the fake faithful

`FakeLiveBridge` is a model of the beta API, and that makes it a liability when Ableton changes the SDK. When you add a tool that uses a new SDK capability:

1. Add the method to the `LiveBridge` interface (DTOs only, never an SDK type).
2. Implement it in `FakeLiveBridge` so it matches the documented SDK contract (sync vs async, undo behavior, validation, deleted-handle throw).
3. Implement the matching translation in `AbletonLiveBridge`.
4. Add a contract test that runs the same assertion against the fake that the ring 3 checklist runs against real Live, so the fake cannot drift silently.

If the SDK contract is unclear, state your assumption in the PR rather than guessing quietly.

## Code standards

- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, NodeNext. `tsc --noEmit` is a hard gate.
- **No `any`.** External or unknown data is `unknown`, narrowed by a Zod parse or a type guard.
- **Tools never throw to the protocol.** A failure returns a normal result with `isError: true` and a recovery hint, so the model can self-correct.
- **Log to stderr, never stdout.** On a stdio transport, stdout is the protocol channel. `no-console` is on; route logging through the logger.
- **Schema-first.** Every tool input is a Zod object with `.strict()` and a `.describe()` on each field. The schema is the validation, the JSON Schema the client sees, and the static type, all at once.

## Commits and pull requests

- Branch off `main`; do not commit to `main` directly. Open a pull request.
- Keep a PR scoped to one change. Smaller diffs get reviewed faster.
- **Do not add `Co-Authored-By` trailers.** Contributors are credited in the CHANGELOG Thanks section and `CONTRIBUTORS.md`, not in commit trailers.
- Prose in PR descriptions, issues, and changelog entries: plain and matter-of-fact, no marketing language, no dash used as a pause (use a comma, a colon, parentheses, or rewrite the sentence).
- A PR is ready when: tests cover the change, typecheck and lint are green, the smoke checklist is run if you changed in-Live behavior, and docs are updated if you changed the tool surface.

## Questions

Open a GitHub Discussion for design questions, or use the Ableton Discord `#extensions` channels for SDK questions. Use issues for bugs and concrete feature requests (the templates capture the environment details we need).
