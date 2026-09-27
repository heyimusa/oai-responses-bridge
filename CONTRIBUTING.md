# Contributing

Thanks for considering a contribution.

## Setup

No install step is required today — the project has zero runtime
dependencies. Node.js 18.17+ is all you need:

```bash
git clone https://github.com/heyimusa/oai-responses-bridge.git
cd oai-responses-bridge
npm test
```

## Guidelines

- Keep the zero-runtime-dependency property unless there's a strong reason
  to break it — this is a small proxy that people will run as a background
  service; a large dependency tree is a liability here.
- Add a test for any behavior change. `test/integration.test.js` is the
  right place for anything that spans request → translation → response;
  `test/streamTranslator.test.js` / `test/requestToResponses.test.js` for
  pure translation logic.
- Never log request/response bodies or the `Authorization` header.
  `test/noSecretsInLogs.test.js` enforces this statically — if it fails on
  your change, that's the test working as intended, not a false positive to
  route around.
- If you're fixing a translation edge case you hit against a real gateway,
  please link the upstream issue/error message in the commit message or PR
  description if you can — it helps future readers confirm the fix still
  matches reality as these APIs evolve.

## Reporting a translation bug

Include:
1. The Chat Completions request body you sent (redact anything sensitive).
2. The exact upstream error, or the malformed output you observed.
3. Which upstream you're behind (LiteLLm, Azure OpenAI direct, OpenAI direct,
   other) and, if known, its version.
