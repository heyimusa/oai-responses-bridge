import http from "node:http";
import { writeFileSync } from "node:fs";
import { buildResponsesBody } from "./translate/requestToResponses.js";
import { StreamTranslator } from "./translate/streamTranslator.js";
import { responsesJsonToChatCompletion } from "./translate/nonStreaming.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function backoffMs(attempt) {
  return Math.min(2000, 250 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeJsonError(res, status, message) {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify({ error: { message } }));
}

/**
 * @param {import('./config.js').loadConfig extends (...args: any) => infer R ? R : never} cfg
 * @param {ReturnType<typeof import('./logger.js').createLogger>} logger
 */
export function createServer(cfg, logger) {
  const reasoningModels = new Set(cfg.reasoningModels);

  async function upstreamResponsesRequest(body) {
    return fetch(`${cfg.upstreamBaseUrl}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  }

  async function handleReasoningStreaming(chatBody, res) {
    const wantUsage = !!chatBody.stream_options?.include_usage;
    let headersSent = false;
    let done = false;

    const translator = new StreamTranslator(chatBody.model, {
      emit: (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
      onDone: () => {
        done = true;
        res.write("data: [DONE]\n\n");
        res.end();
      },
      wantUsage,
      onSwallowedError: (message) =>
        logger.warn("swallowed known LiteLLM relay defect (trailing error after full output):", message),
    });

    let lastError = null;
    for (let attempt = 1; attempt <= cfg.maxUpstreamAttempts && !done; attempt++) {
      try {
        const upstreamBody = buildResponsesBody(chatBody, { defaultReasoningEffort: cfg.defaultReasoningEffort });
        if (process.env.ORB_DEBUG_DUMP) {
          try {
            writeFileSync("/tmp/orb-debug-lastbody.json", JSON.stringify(upstreamBody, null, 2));
          } catch {}
        }
        const r = await upstreamResponsesRequest(upstreamBody);

        if (!r.ok) {
          const text = await safeText(r);
          if (!RETRYABLE_STATUS.has(r.status)) {
            logger.warn("non-retryable upstream status", r.status, "for", chatBody.model);
            writeJsonError(res, r.status, `upstream ${r.status}: ${truncate(text)}`);
            return;
          }
          lastError = `upstream ${r.status}`;
          logger.warn("retryable upstream status", r.status, "attempt", attempt, "of", cfg.maxUpstreamAttempts);
          await sleep(backoffMs(attempt));
          continue;
        }

        if (!headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          headersSent = true;
        }

        await pumpSse(r.body, (evt) => translator.handleEvent(evt));
        translator.handleStreamEndedWithoutTerminalEvent();
        if (done) return;
        lastError = "upstream stream ended with no output";
        logger.warn(
          "upstream closed the stream with no recognized output event, attempt",
          attempt,
          "of",
          cfg.maxUpstreamAttempts,
          "model=",
          chatBody.model,
          "effort=",
          chatBody.reasoning_effort || cfg.defaultReasoningEffort
        );
      } catch (e) {
        lastError = String(e);
        logger.warn("upstream request failed, attempt", attempt, "of", cfg.maxUpstreamAttempts, lastError);
        await sleep(backoffMs(attempt));
      }
    }

    if (!done) {
      if (!headersSent) {
        writeJsonError(res, 502, `bridge: upstream failed after ${cfg.maxUpstreamAttempts} attempts: ${lastError}`);
      } else {
        translator.finish(null, lastError || "upstream failed after retries");
      }
    }
  }

  async function handleReasoningNonStreaming(chatBody, res) {
    const upstreamBody = buildResponsesBody(chatBody, { defaultReasoningEffort: cfg.defaultReasoningEffort });
    let lastError = null;

    for (let attempt = 1; attempt <= cfg.maxUpstreamAttempts; attempt++) {
      try {
        const r = await upstreamResponsesRequest(upstreamBody);
        const json = await r.json();
        if (!r.ok) {
          if (!RETRYABLE_STATUS.has(r.status)) {
            writeJsonError(res, r.status, json?.error?.message || `upstream ${r.status}`);
            return;
          }
          lastError = json;
          await sleep(backoffMs(attempt));
          continue;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responsesJsonToChatCompletion(json, chatBody.model)));
        return;
      } catch (e) {
        lastError = String(e);
        await sleep(backoffMs(attempt));
      }
    }
    writeJsonError(res, 502, `bridge: upstream failed after ${cfg.maxUpstreamAttempts} attempts: ${JSON.stringify(lastError)}`);
  }

  async function handlePassthrough(rawBody, res) {
    const r = await fetch(`${cfg.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: rawBody,
    });
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
    if (!r.body) {
      res.end(await r.text());
      return;
    }
    for await (const chunk of r.body) res.write(chunk);
    res.end();
  }

  async function handleModelsList(res) {
    const r = await fetch(`${cfg.upstreamBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
    res.end(await r.text());
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            upstream: cfg.upstreamBaseUrl,
            reasoningModels: [...reasoningModels],
          })
        );
        return;
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        await handleModelsList(res);
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const raw = await readBody(req);
        let chatBody;
        try {
          chatBody = JSON.parse(raw);
        } catch {
          writeJsonError(res, 400, "invalid JSON body");
          return;
        }

        if (chatBody.n && chatBody.n > 1) {
          writeJsonError(res, 400, "bridge: n > 1 is not supported");
          return;
        }

        if (reasoningModels.has(chatBody.model)) {
          logger.info("responses-bridge:", chatBody.model, "stream=", !!chatBody.stream);
          if (chatBody.stream) await handleReasoningStreaming(chatBody, res);
          else await handleReasoningNonStreaming(chatBody, res);
        } else {
          logger.debug("passthrough chat/completions:", chatBody.model);
          await handlePassthrough(raw, res);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    } catch (e) {
      logger.error("unhandled request error:", e?.stack || e);
      if (!res.headersSent) writeJsonError(res, 500, "internal bridge error");
      else res.end();
    }
  });

  return server;
}

/** Reads an SSE body stream and calls `onEvent` for each parsed `data:` frame (skips `[DONE]`). */
async function pumpSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // ignore malformed frame
      }
    }
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s, n = 500) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
