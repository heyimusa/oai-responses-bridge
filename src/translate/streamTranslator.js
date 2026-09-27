// Consumes Responses API SSE events and emits Chat Completions-shaped stream
// chunks. Deliberately has no knowledge of HTTP or SSE wire framing — it takes
// parsed event objects in and hands parsed chunk objects out via callbacks —
// so the hard part (event translation, tool-call index bookkeeping, the
// trailing-error workaround) can be unit tested without a real socket.

let counter = 0;
function chunkId() {
  counter += 1;
  return `chatcmpl-bridge-${Date.now().toString(36)}-${counter}`;
}

/**
 * A single known LiteLLM proxy defect (as of 2026-09; see
 * https://github.com/BerriAI/litellm/pull/31786 and
 * https://github.com/duolahypercho/codex-router/issues/837): the Responses
 * API streaming relay can append a spurious `{"type":"error", ...}` frame
 * *after* the real output has already been fully delivered, instead of a
 * terminal `response.completed`. When that happens we already have
 * everything we need, so we treat it as a clean finish rather than
 * propagating a fake failure to the client.
 */
const RELAY_TRAILING_ERROR_MESSAGE = "Response API in-stream error";

export class StreamTranslator {
  /**
   * @param {string} model
   * @param {{ emit: (chunk: object) => void, onDone: () => void, wantUsage?: boolean, onSwallowedError?: (message: string) => void }} handlers
   */
  constructor(model, { emit, onDone, wantUsage = false, onSwallowedError }) {
    this.model = model;
    this.emit = emit;
    this.onDone = onDone;
    this.wantUsage = wantUsage;
    this.onSwallowedError = onSwallowedError || (() => {});

    this.id = chunkId();
    this.created = Math.floor(Date.now() / 1000);
    this.toolIndexByItemId = new Map();
    this.nextToolIndex = 0;
    this.sawAnyOutput = false;
    this.finished = false;
    this.finalUsage = null;
  }

  writeChunk(delta, finishReason = null) {
    this.emit({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  /** @param {object} evt A parsed Responses API SSE event. */
  handleEvent(evt) {
    if (this.finished) return;
    switch (evt.type) {
      case "response.output_text.delta":
        this.sawAnyOutput = true;
        this.writeChunk({ content: evt.delta });
        break;

      case "response.output_item.added":
        if (evt.item?.type === "function_call") {
          const index = this.nextToolIndex++;
          this.toolIndexByItemId.set(evt.item.id, index);
          this.writeChunk({
            tool_calls: [
              {
                index,
                id: evt.item.call_id,
                type: "function",
                function: { name: evt.item.name, arguments: "" },
              },
            ],
          });
        }
        break;

      case "response.function_call_arguments.delta": {
        this.sawAnyOutput = true;
        const index = this.toolIndexByItemId.get(evt.item_id);
        if (index !== undefined) {
          this.writeChunk({ tool_calls: [{ index, function: { arguments: evt.delta } }] });
        }
        break;
      }

      case "response.output_item.done":
        this.sawAnyOutput = true;
        break;

      case "response.completed":
        this.finalUsage = evt.response?.usage || null;
        this.finish("stop");
        break;

      case "response.failed":
        this.finish(this.sawAnyOutput ? "stop" : null, evt.response?.error?.message || "response.failed");
        break;

      case "error":
        if (this.sawAnyOutput) {
          this.onSwallowedError(evt.message || "unknown relay error");
          this.finish("stop");
        } else {
          this.finish(null, evt.message || RELAY_TRAILING_ERROR_MESSAGE);
        }
        break;
    }
  }

  /** Called by the caller when the upstream connection ends without a terminal event. */
  handleStreamEndedWithoutTerminalEvent() {
    if (this.finished) return;
    if (this.sawAnyOutput) this.finish("stop");
    // else: leave unfinished so the caller can retry the whole request.
  }

  finish(finishReason, errorMessage) {
    if (this.finished) return;
    this.finished = true;

    if (errorMessage && !this.sawAnyOutput) {
      this.writeChunk({}, "stop");
      this.emit({ error: { message: String(errorMessage) } });
      this.onDone();
      return;
    }

    const hadToolCalls = this.toolIndexByItemId.size > 0;
    this.writeChunk({}, hadToolCalls ? "tool_calls" : finishReason || "stop");

    if (this.wantUsage && this.finalUsage) {
      this.emit({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [],
        usage: {
          prompt_tokens: this.finalUsage.input_tokens ?? 0,
          completion_tokens: this.finalUsage.output_tokens ?? 0,
          total_tokens: this.finalUsage.total_tokens ?? 0,
        },
      });
    }

    this.onDone();
  }
}
