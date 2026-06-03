## What this changes

A short description of the change and why. Link the issue it closes (`Closes #123`) if there is one.

## How it was tested

Which rings cover this, and what you ran. If you changed in-Live behavior, say whether you ran the ring 3 smoke checklist and against which Live build.

## Checklist

- [ ] Tests cover the change (ring 1 and/or ring 2; rings 1 and 2 need no Live).
- [ ] `pnpm typecheck` is green (`tsc --noEmit`, hard gate).
- [ ] `pnpm lint` is green.
- [ ] `pnpm format:check` passes (`pnpm format` to fix).
- [ ] The `LiveBridge` rule holds: `@ableton-extensions/sdk` is imported only by the adapter, the five command modules, and `activate()` (all excluded from the committed CI tsconfig); no `Handle`, `bigint` ref, or `instanceof MidiClip` leaked out of the adapter into `core` or `mcp`.
- [ ] If a new SDK capability is used: the `LiveBridge` interface, `FakeLiveBridge`, and `AbletonLiveBridge` all updated, with a contract test so the fake cannot drift.
- [ ] Docs updated if the tool surface or behavior changed.
- [ ] A changeset is added if this changes published behavior (`pnpm changeset`).
- [ ] If in-Live behavior changed: the ring 3 smoke checklist was run, and the tested Live build is noted above.

## Notes

Anything a reviewer should know: an assumption you made about the beta SDK contract, a follow-up you are deferring, a tradeoff.

---

Prose here and in the changelog is plain and matter-of-fact: no marketing language, no dash used as a pause. Do not add `Co-Authored-By` trailers; contributors are credited in the CHANGELOG and `CONTRIBUTORS.md`.
