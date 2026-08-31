# Loophole extension verification checklist

This checklist separates evidence that can be produced without Ableton from evidence that
requires the licensed SDK, a packaged `.ablx`, or a running Live instance. Do not mark a gate
complete because an earlier gate passed. Record the exact commit, commands, machine, Live
build, and artifacts for every completed run.

## Recorded gate status

| Gate            | Current status        | Required evidence                                                                                                                         |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CI_SAFE`       | [x] `PASS_AT_86EAE1C` | Frozen install, typecheck, lint, format check, build, tests, and packed MCP consumer proof on the commit being evaluated.                 |
| `SDK_TYPECHECK` | [x] `PASS_AT_86EAE1C` | Genuine licensee-local SDK declarations, exact SDK version and hashes, and a clean `tsconfig.live.json` typecheck transcript.             |
| `PACKAGE_ABLX`  | [ ] `NOT_RUN`         | Successful `package:live` transcript, `.ablx` filename, size, SHA-256, manifest contents, SDK/CLI versions, and clean source-tree status. |
| `LIVE_RUNTIME`  | [ ] `NOT_RUN_NO_LIVE` | Package load, menus, bridge discovery, authenticated client read/write, undo history, and complete logs from the exact Live run.          |

The two passes above are bounded to source commit
`86eae1c5f9f3047c416f71b15292a00aee3fa0fa` and the receipts below. The current
environment has neither a resolvable Extensions CLI nor an Ableton Live installation.
`PACKAGE_ABLX` and `LIVE_RUNTIME` have not been run.

## Recorded receipts for `86eae1c`

### `CI_SAFE`

- Clean no-hardlink verification passed the frozen script-free install, recursive typecheck,
  lint, formatting, 632 coverage tests (core 302, MCP 205, extension 125), recursive build,
  packed MCP consumer smoke with 12 tools, and production dependency audits.
- GitHub CI run `33304814551`, security run `33304814550`, and docs tools drift run
  `33304814555` all completed successfully on the same exact commit.
- This proves the SDK-free contracts and distribution checks only. It does not prove the
  licensed adapter bundle or Live behavior.

### `SDK_TYPECHECK`

- Command: `pnpm exec tsc -p packages/extension/tsconfig.live.json --noEmit`
- Result: exit code `0`, with a clean source tree before and after.
- Toolchain: TypeScript `5.9.3`, pnpm `10.13.1`, Node `24.12.0`.
- Licensee-owned SDK metadata: `@ableton-extensions/sdk@1.0.0-beta.0`.
- SDK archive SHA-256:
  `A10EC4D85D1B3AF32DE924FF77454B05BF3CFD5A0BFCD3B8A6C2BD74069D7A6C`.
- Exact mapped declaration SHA-256:
  `3653B5E139C4D2FFD2BCA3A1DD5127E3300A8C4C4FBF0CDF890C0DBA5AAC0D44`.

The SDK archive came from the licensee's local Ableton beta bundle; the hash identifies the
exact input but is not a vendor-signature claim. No SDK declaration or documentation content is
reproduced here. Node `24.12.0` is below this package's `>=24.14.1` packaging/runtime floor, so
this receipt proves declaration compatibility only. Re-run under a compliant Node version before
packaging or Live testing.

## Gate 1: `CI_SAFE`

Run from the repository root on the commit under evaluation:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm build
pnpm --filter @othmanadi/ableton-mcp test:artifact
```

Record the commit SHA, Node and pnpm versions, exit codes, and test totals. This gate proves
the SDK-free contracts only. It does not prove the adapter, package, or Live runtime.

## Gate 2: `SDK_TYPECHECK`

On a licensed machine, install the SDK and CLI from that user's Ableton Beta Program
downloads, create the gitignored `packages/extension/tsconfig.live.json`, and run:

```bash
pnpm exec tsc -p packages/extension/tsconfig.live.json --noEmit
```

Record the exact SDK archive version and hash, CLI version, Node version, command output, and
commit SHA. Do not copy SDK source or declarations into an issue, log bundle, or commit.

## Gate 3: `PACKAGE_ABLX`

Run:

```bash
pnpm --filter @othmanadi/loophole-extension run package:live
```

Record all of the following:

- command transcript and exit code;
- produced filename, byte size, and SHA-256;
- packaged manifest fields and entry-point path;
- SDK and Extensions CLI versions;
- `git status --short`, proving no SDK archive, declaration, token, or generated package was staged.

Do not publish the artifact as part of this gate. Package creation and release publication are
different actions.

## Gate 4: `LIVE_RUNTIME`

### Package load and issue #1 diagnostics

Issue [#1](https://github.com/OthmanAdi/loophole/issues/1) reported that the `.ablx` did not
load on Live 12.4.5b4 for macOS and that no `bridge.json` appeared. Retest the package on the
current available beta. If the reporter build is still available, run it as a separate case.
Never treat a current-beta pass as proof that the reported b4 case did not occur.

For each attempt, record:

1. OS version and architecture, exact Live edition/build/channel, default or custom template,
   Set used, `.ablx` SHA-256, manifest version, and install path.
2. Whether the extension appears in Settings, whether activation is attempted, whether all
   five menu actions appear, and whether `bridge.json` is created.
3. The complete logs copied immediately after that exact attempt:
   - Windows Extension Host log:
     `%APPDATA%\Ableton\Live x.x.x\Preferences\ExtensionHost.txt`
   - macOS Extension Host log:
     `/Users/[username]/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt`
   - Windows Live log:
     `%APPDATA%\Ableton\Live x.x.x\Preferences\Log.txt`
   - macOS Live log:
     `/Users/[username]/Library/Preferences/Ableton/Live x.x.x/Log.txt`
4. SHA-256 hashes for both copied logs. Preserve timestamps, Extension Host console output,
   activation lines, and complete uncaught exception stacks. Redact only secrets such as the
   bearer token. Do not submit a filtered excerpt or screenshot as the sole evidence.
5. A second run with a new empty Set based on Live's default template. This distinguishes
   package activation from a Set or template-specific failure.

### Bridge and client contract

- Confirm the listener is bound only to `127.0.0.1`.
- Confirm an unauthenticated request is rejected.
- Read `bridge.json`, merge the emitted client block into one MCP client, and restart or reload
  that client as required.
- Call `live_get_song_overview` and confirm the real Set data is returned.
- Confirm returned object references are opaque, type-tagged session references. Pass one
  returned value through unchanged. After a structural edit, re-list and use the new value.
- Confirm a stale or wrong-kind reference fails safely and does not target a different object.

### Kit actions and undo receipts

Use a disposable Set and save a separate copy before destructive cases.

- Scale Lock: confirm selected MIDI notes change as previewed, then record the actual undo entry.
- Humanize: confirm timing, velocity, and probability stay within the shown limits, then record
  the actual undo entry.
- Gain Stage Doctor: use audio plus silent tracks. Confirm analysis is read-only, the review shows
  measurements and marks silence, cancel writes nothing, and explicit Apply skips silent rows.
  Submit a stale, out-of-range, or non-finite reviewed plan through a controlled harness and
  confirm it fails before any mixer write. Compare applied values with Live's displayed values.
- Set Janitor: verify deselected fixes do not run. Confirm the bundled command reports no color
  issue because it supplies no complete verified palette. In a controlled core caller, verify
  palette detection/recoloring occurs only when the same verified palette is supplied. Confirm
  selected value changes share one undo entry and each opted-in structural deletion adds one.
- Session-to-Song success: verify three receipt cases separately. A no-op reports 0 intended undo
  entries; a cue-only build reports 2; a build that clears, creates physical clips, and populates
  them reports 3. Confirm the physical repetition and cue counts, then compare the reported count
  with Live's actual undo history.
- Session-to-Song recovery: with controlled failures, verify create failure after clear reports
  `undoStepsToRestore: 1`, and population failure after clear plus create reports
  `undoStepsToRestore: 2`. Apply exactly that many Undo commands, confirm the pre-run Set is
  restored, then re-list and run a fresh preflight before retry.

For every case, record expected result, actual result, timestamp, relevant log range, and whether
the Set returned to its saved state. A checkbox without this evidence is not a pass.
