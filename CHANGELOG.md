# Changelog

## 1.0.0 - 2026-09-17

### Fixed

- **Default health-check run latency: 417s -> 81s.** The default `expertQuery` was narrowed from a
  fixed `publication-date >= 20260101` window (42,134 matching notices) to a self-refreshing
  rolling window, `publication-date >= today(-14) AND classification-cpv = 72*` (2,332 matching
  notices), using TED's own server-side `today([+-]N)` date function so the default never goes
  stale and needs no manual date bump. Fewer matching notices means fewer sequential TED API pages
  a default/unattended run (including Apify's own daily automated health-check) has to walk, which
  is what was pushing a real run past Apify's 300-second default health-check window.
- **`test/` referenced a legacy, non-existent glob.** `tsconfig.json`'s `exclude` array carried a
  stray `test/**/*` entry left over from before the test suite existed, alongside the real
  `tests/**/*` pattern the actual test files lived under - a latent misconfiguration that only
  became correct by accident once the directory was later renamed to `test/` (see below).

### Added

- **A real Vitest test suite where previously there were none.** 143 tests across
  `deltaEngine`, `tedClient`, `routes`, `state`, `main` and `webhookNotifier`, covering
  canonicalization/fingerprinting and the delta classification state machine, real-shaped mocked
  TED HTTP responses (including retry/backoff and error classification), `INCREMENTAL` /
  `VALIDATE_QUERY` / `BACKFILL` orchestration and PPE event billing, and KV-store state
  round-tripping. Measured with `@vitest/coverage-v8`: 98.59% statement coverage.
