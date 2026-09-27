# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-09-27

### Added
- `ORB_DEBUG_DUMP` env var: writes the exact outgoing Responses API request
  body to `/tmp/orb-debug-lastbody.json` before each reasoning-model call.
  Documented with an explicit warning that it captures real conversation
  content and should not be left on.

### Fixed
- The retry loop now logs (`warn`) when an upstream stream ends without a
  recognized terminal event, instead of retrying silently. Added an
  integration test covering this exact shape.

### Documentation
- Added a "note on in-stream error that isn't infrastructure flakiness":
  root-caused a real production case where every attempt for one specific
  conversation turn failed with `Response API in-stream error` — not
  transient flakiness, but Azure content-safety rejecting that turn's
  content. Confirmed by swapping only that turn's content for something
  neutral (identical size/shape) and observing an immediate clean success.

## [0.1.0] - 2026-09-27

Initial release. Extracted and hardened from a working proxy used in
production to unblock `gpt-6-sol` / `gpt-5.6-terra` tool-calling through a
LiteLLM gateway.

### Added
- Chat Completions → Responses API request translation (`src/translate/requestToResponses.js`).
- Responses API SSE → Chat Completions chunk streaming translation, including
  parallel tool-call index tracking (`src/translate/streamTranslator.js`).
- Non-streaming response translation (`src/translate/nonStreaming.js`).
- Passthrough for non-reasoning models.
- Config loader with CLI flag / env var / config file / default precedence,
  including `apiKeyEnv` indirection (`src/config.js`).
- Retry with backoff for transient (429/5xx/network) upstream failures;
  immediate surfacing of non-retryable 4xx errors.
- Workaround for a known LiteLLM Responses-relay defect that appends a
  spurious trailing error frame after a fully-delivered stream.
- `GET /healthz`.
- Graceful shutdown on `SIGTERM`/`SIGINT`.
- Test suite (39 tests): unit, config-precedence, and full-stack integration
  tests, plus a static regression guard against logging secrets.
- systemd `--user` unit template and install script.
