// End-to-end test: a fake "upstream" (standing in for LiteLLM / Azure OpenAI)
// plus the real bridge server, wired together over real HTTP sockets on
// ephemeral loopback ports. Exercises the full request/response path,
// including the known-defect workaround and retry/no-retry classification.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
}

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startMockUpstream() {
  const attempts = new Map();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};

    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] }));
      return;
    }

    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-passthrough",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "passthrough ok" }, finish_reason: "stop" }],
        })
      );
      return;
    }

    assert.equal(req.url, "/v1/responses");

    switch (body.model) {
      case "test-nonstream-ok":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp_1",
            output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })
        );
        return;

      case "test-stream-tool-call":
        assert.deepEqual(body.reasoning, { effort: "high" }, "default effort should apply");
        assert.equal(body.tools[0].name, "get_weather");
        sse(res, [
          { type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "call_1", name: "get_weather" } },
          { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"city":"Jakarta"}' },
          { type: "response.output_item.done" },
          { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
        ]);
        return;

      case "test-trailing-relay-defect":
        sse(res, [
          { type: "response.output_text.delta", delta: "already delivered" },
          { type: "error", message: "litellm.APIError: Response API in-stream error" },
        ]);
        return;

      case "test-non-retryable-400":
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported" } }));
        return;

      case "test-retry-then-ok": {
        const n = (attempts.get("retry-then-ok") || 0) + 1;
        attempts.set("retry-then-ok", n);
        if (n < 2) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp_retry",
            output: [{ type: "message", content: [{ type: "output_text", text: "recovered" }] }],
            usage: {},
          })
        );
        return;
      }

      default:
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unhandled test model ${body.model}` } }));
    }
  });

  const port = await listen(server);
  return { server, port, attempts };
}

async function startBridge(upstreamPort) {
  const cfg = loadConfig({
    argv: [],
    env: {
      PATH: process.env.PATH,
      ORB_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ORB_API_KEY: "sk-test-not-real",
      ORB_REASONING_MODELS:
        "test-nonstream-ok,test-stream-tool-call,test-trailing-relay-defect,test-non-retryable-400,test-retry-then-ok",
      ORB_MAX_UPSTREAM_ATTEMPTS: "3",
    },
  });
  const logger = createLogger("error"); // keep test output quiet
  const server = createServer(cfg, logger);
  const port = await listen(server);
  return { server, port };
}

async function parseSse(res) {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((l) => l.slice(5).trim())
    .filter((d) => d !== "[DONE]" && d !== "")
    .map((d) => JSON.parse(d));
}

test("integration: full stack", async (t) => {
  const upstream = await startMockUpstream();
  const bridge = await startBridge(upstream.port);
  const base = `http://127.0.0.1:${bridge.port}`;

  t.after(() => {
    upstream.server.close();
    bridge.server.close();
  });

  await t.test("GET /healthz reports upstream and routed models", async () => {
    const res = await fetch(`${base}/healthz`);
    const json = await res.json();
    assert.equal(json.status, "ok");
    assert.ok(json.reasoningModels.includes("test-stream-tool-call"));
  });

  await t.test("non-streaming reasoning model round trip", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-nonstream-ok", messages: [{ role: "user", content: "hi" }] }),
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "OK");
  });

  await t.test("streaming reasoning model with a tool call round trip", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-stream-tool-call",
        stream: true,
        messages: [{ role: "user", content: "weather in jakarta" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      }),
    });
    const events = await parseSse(res);
    const argChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls);
    const assembledArgs = argChunks.map((e) => e.choices[0].delta.tool_calls[0].function?.arguments || "").join("");
    assert.equal(assembledArgs.includes("Jakarta"), true);
    assert.equal(events.at(-1).choices[0].finish_reason, "tool_calls");
  });

  await t.test("known relay defect: trailing bogus error after output is not surfaced", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-trailing-relay-defect", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const events = await parseSse(res);
    assert.equal(events[0].choices[0].delta.content, "already delivered");
    assert.equal(events.at(-1).choices[0].finish_reason, "stop");
    assert.equal(events.some((e) => e.error), false);
  });

  await t.test("non-retryable 400 surfaces immediately as an HTTP error, not a retry loop", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-non-retryable-400", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /reasoning_effort/);
  });

  await t.test("transient 503 is retried and eventually succeeds", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-retry-then-ok", messages: [{ role: "user", content: "hi" }] }),
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "recovered");
    assert.equal(upstream.attempts.get("retry-then-ok"), 2);
  });

  await t.test("non-reasoning model is passed through untouched", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "passthrough ok");
  });
});
