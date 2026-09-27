# oai-responses-bridge

A small, dependency-free local proxy that lets **Chat-Completions-only clients**
use **OpenAI/Azure reasoning models with function tools** — by transparently
translating to and from the **Responses API** underneath.

```
 coding agent (OpenCode, Kimi Code, Cline, Aider, ...)
        │  POST /v1/chat/completions   (the only wire format most clients speak)
        ▼
 oai-responses-bridge  (this project — runs on localhost)
        │  POST /v1/responses          (what reasoning models require for tool use)
        ▼
 your gateway (LiteLLM / Azure OpenAI / OpenAI) or any Responses-API backend
```

## The problem this solves

As of late 2026, Azure's/OpenAI's reasoning model family (`gpt-5.6-*`,
`gpt-6-*`, and others) rejects function-tool calls on `/v1/chat/completions`
once reasoning is involved:

```
BadRequestError - Function tools with reasoning_effort are not supported for
gpt-6-sol in /v1/chat/completions. To use function tools, use /v1/responses
or set reasoning_effort to 'none'.
```

Most coding-agent CLIs (and most OpenAI-compatible SDK adapters) still only
speak the Chat Completions wire format — Responses API support is either
missing or, where present, incompletely wired for third-party/custom
providers. That leaves two bad options: disable reasoning (`reasoning_effort:
none`) and lose the reason you picked the model, or don't use tools at all.

This project is a third option: a tiny local translation layer, so your
existing client and gateway don't need to change.

This is a known, widely-hit issue — not specific to any one client or
gateway. See e.g. [BerriAI/litellm#31786](https://github.com/BerriAI/litellm/pull/31786),
[duolahypercho/codex-router#837](https://github.com/duolahypercho/codex-router/issues/837),
and the dozens of similar reports across LibreChat, Cline, OpenCode, and
others filed the same week this project was written.

## What it does

- Routes requests for models you name as "reasoning models" through
  `/v1/responses`, translating messages, tools, tool results, and (for
  streaming) individual SSE events back into Chat Completions' wire shape —
  including tool-call argument deltas, indexed correctly for parallel tool
  calls.
- Passes every other model straight through to `/v1/chat/completions`
  untouched.
- Classifies upstream failures: a real `4xx` (bad request, auth, etc.) is
  surfaced immediately; a transient `429`/`5xx`/network error is retried with
  backoff.
- Works around a known LiteLLM Responses-relay defect where a spurious
  trailing `error` SSE frame is appended *after* a fully-delivered response
  ([litellm#31786](https://github.com/BerriAI/litellm/pull/31786),
  [codex-router#837](https://github.com/duolahypercho/codex-router/issues/837)):
  if real output already arrived, the bridge finishes the stream cleanly
  instead of surfacing a false failure.
- Holds your upstream API key in one place, read from an environment
  variable or a permission-restricted config file. The client (OpenCode,
  Kimi Code, etc.) only ever talks to `localhost` and never needs the real
  key.

## What it does not do (yet)

- Multiple upstreams in one process (one bridge instance = one upstream
  base URL; run more than one instance on different ports if you need more).
- `n > 1` (multiple choices per request) — rejected with a clear 400.
- Structured outputs / `response_format: json_schema` translation.
- Non-text, non-image message parts (audio, files).

Contributions welcome for any of the above — see [Contributing](#contributing).

## Install

```bash
npm install -g oai-responses-bridge
```

Or run it straight from a clone without installing globally:

```bash
git clone https://github.com/heyimusa/oai-responses-bridge.git
cd oai-responses-bridge && npm install --omit=dev  # no-op today: zero runtime deps
node bin/oai-responses-bridge.js --help
```

Requires Node.js 18.17+ (uses the global `fetch` and `node:test`).

## Quickstart

```bash
export ORB_API_KEY=sk-...                 # your upstream (LiteLLM/Azure/OpenAI) key
oai-responses-bridge \
  --upstream https://litellm.example.com/v1 \
  --reasoning-models gpt-6-sol,gpt-6-luna,gpt-5.6-terra
```

Then point your client's OpenAI-compatible provider at
`http://127.0.0.1:4801/v1` with any placeholder API key — the bridge is the
only thing that needs the real one.

### OpenCode

```jsonc
// ~/.config/opencode/opencode.json
{
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:4801/v1", "apiKey": "local-bridge-no-secret-needed" },
      "models": {
        "gpt-6-sol": { "name": "GPT-6 Sol" },
        "gpt-5.6-terra": { "name": "GPT-5.6 Terra" }
      }
    }
  }
}
```

See [`examples/opencode.json`](./examples/opencode.json) and
[`examples/kimi-code-config.toml`](./examples/kimi-code-config.toml) for
complete, working configs.

## Configuration reference

Precedence, highest wins: **CLI flags > environment variables > config file >
defaults.**

| CLI flag | Env var | Config file key | Default | Description |
|---|---|---|---|---|
| `--port` | `ORB_PORT` | `port` | `4801` | Listen port |
| `--host` | `ORB_HOST` | `host` | `127.0.0.1` | Listen address |
| `--upstream` | `ORB_UPSTREAM_BASE_URL` | `upstreamBaseUrl` | *(required)* | Upstream base URL, e.g. `https://litellm.example.com/v1` |
| `--api-key` | `ORB_API_KEY` | `apiKey` | *(required unless `apiKeyEnv`/`ORB_API_KEY_ENV` set)* | Upstream API key. Prefer the `*-env` variant — this one is visible in `ps`. |
| `--api-key-env` | `ORB_API_KEY_ENV` | `apiKeyEnv` | — | Name of an env var to read the upstream key from at startup |
| `--reasoning-models` | `ORB_REASONING_MODELS` | `reasoningModels` | *(required, comma-separated)* | Model ids to route via `/v1/responses` |
| `--effort` | `ORB_DEFAULT_REASONING_EFFORT` | `defaultReasoningEffort` | `high` | Default `reasoning.effort` when the client doesn't specify one |
| `--max-upstream-attempts` | `ORB_MAX_UPSTREAM_ATTEMPTS` | `maxUpstreamAttempts` | `4` | Retry attempts for transient (429/5xx/network) upstream failures |
| `--log-level` | `ORB_LOG_LEVEL` | `logLevel` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `--config <path>` | `ORB_CONFIG` | — | — | JSON file holding any of the keys above |

`GET /healthz` reports upstream and the configured reasoning-model list.

## Security notes

- The bridge is the only process that needs the real upstream API key.
  Prefer `--api-key-env` / `ORB_API_KEY_ENV` over `--api-key` / `ORB_API_KEY`
  so the secret isn't visible in `ps`/process listings.
- If you do use a config file, keep it `chmod 600`. `deploy/systemd/` assumes
  this.
- Default bind address is `127.0.0.1`. Only change `--host` if you understand
  the exposure (e.g. binding `0.0.0.0` hands anyone who can reach the port
  free use of your upstream key).
- `test/noSecretsInLogs.test.js` statically scans every source file so a
  future change can't reintroduce a logging call that mentions `apiKey` or
  `Authorization` — this project exists partly *because* a secret nearly
  ended up somewhere it shouldn't have during development. Logging levels
  are for request shapes (model, stream boolean, status codes) — never
  bodies or headers.

## Running as a persistent service (systemd --user)

```bash
cp deploy/systemd/oai-responses-bridge.service.template \
   ~/.config/systemd/user/oai-responses-bridge.service
# edit the ExecStart/Environment lines for your paths and upstream, then:
systemctl --user daemon-reload
systemctl --user enable --now oai-responses-bridge.service
```

See [`deploy/systemd/install-systemd-user.sh`](./deploy/systemd/install-systemd-user.sh)
for a scripted version of the above.

## Development

```bash
npm test        # node --test test/*.test.js  (39 tests: unit + integration, no network)
```

The test suite has three layers:
- Pure unit tests for the two translation directions
  (`test/requestToResponses.test.js`, `test/nonStreaming.test.js`,
  `test/streamTranslator.test.js`) — including the parallel-tool-call
  indexing and the relay-defect workaround.
- Config precedence tests (`test/config.test.js`).
- A full integration test (`test/integration.test.js`) that spins up a fake
  upstream and the real bridge server on loopback ports and exercises the
  whole stack over real HTTP, including retry/no-retry classification.

No test hits the network or requires real credentials.

## Contributing

Issues and PRs welcome. Please add a test for any behavior change — see
`test/` for the existing patterns. Run `npm test` before opening a PR.

## License

MIT — see [LICENSE](./LICENSE).
