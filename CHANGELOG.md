# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- W0 repo skeleton: pnpm monorepo, strict TypeScript base, ESLint plus Prettier, Vitest.
- The `LiveBridge` port and its in-memory `FakeLiveBridge`, exported from `@othmanadi/ableton-mcp` so the server is testable without Ableton Live.
- Serializable DTOs, stable path-id scheme, typed error model, and pure note transforms (`clampPitch`, `transposeNotes`, `humanizeTiming`).
- Contract tests pinning the SDK semantics the fake reproduces (pitch clamp, stale-id throw, one transaction equals one undo).
- CI workflow running typecheck, lint, format check, tests with coverage, and build on Node 22 and 24.

### Thanks

- Contributors are credited here and in `CONTRIBUTORS.md`, not in commit trailers.
