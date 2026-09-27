import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamTranslator } from "../src/translate/streamTranslator.js";

function harness(opts = {}) {
  const chunks = [];
  let done = false;
  const warnings = [];
  const translator = new StreamTranslator("gpt-6-sol", {
    emit: (c) => chunks.push(c),
    onDone: () => {
      done = true;
    },
    onSwallowedError: (msg) => warnings.push(msg),
    ...opts,
  });
  return { translator, chunks, warnings, isDone: () => done };
}

test("plain text: streams content deltas then finishes with stop", () => {
  const { translator, chunks, isDone } = harness();
  translator.handleEvent({ type: "response.output_text.delta", delta: "OK" });
  translator.handleEvent({ type: "response.output_text.delta", delta: " streaming" });
  translator.handleEvent({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 5 } } });

  assert.equal(isDone(), true);
  assert.equal(chunks[0].choices[0].delta.content, "OK");
  assert.equal(chunks[1].choices[0].delta.content, " streaming");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("single tool call: emits an indexed tool_calls delta sequence and finish_reason=tool_calls", () => {
  const { translator, chunks } = harness();
  translator.handleEvent({
    type: "response.output_item.added",
    item: { type: "function_call", id: "item_1", call_id: "call_abc", name: "get_weather" },
  });
  translator.handleEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"city":' });
  translator.handleEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", delta: '"Jakarta"}' });
  translator.handleEvent({ type: "response.output_item.done" });
  translator.handleEvent({ type: "response.completed", response: { usage: {} } });

  const toolChunks = chunks.filter((c) => c.choices[0].delta.tool_calls);
  assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].id, "call_abc");
  assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].function.name, "get_weather");
  assert.equal(toolChunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"city":');
  assert.equal(toolChunks[2].choices[0].delta.tool_calls[0].function.arguments, '"Jakarta"}');
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("parallel tool calls: each item gets its own stable index", () => {
  const { translator, chunks } = harness();
  translator.handleEvent({
    type: "response.output_item.added",
    item: { type: "function_call", id: "item_1", call_id: "call_1", name: "a" },
  });
  translator.handleEvent({
    type: "response.output_item.added",
    item: { type: "function_call", id: "item_2", call_id: "call_2", name: "b" },
  });
  translator.handleEvent({ type: "response.function_call_arguments.delta", item_id: "item_2", delta: "{}" });
  translator.handleEvent({ type: "response.function_call_arguments.delta", item_id: "item_1", delta: "{}" });
  translator.handleEvent({ type: "response.completed", response: { usage: {} } });

  const toolChunks = chunks.filter((c) => c.choices[0].delta.tool_calls);
  assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].index, 0); // item_1 added first
  assert.equal(toolChunks[1].choices[0].delta.tool_calls[0].index, 1); // item_2 added second
  assert.equal(toolChunks[2].choices[0].delta.tool_calls[0].index, 1); // item_2's arg delta
  assert.equal(toolChunks[3].choices[0].delta.tool_calls[0].index, 0); // item_1's arg delta
});

test("known LiteLLM defect: trailing error frame after real output is swallowed, not surfaced", () => {
  const { translator, chunks, warnings, isDone } = harness();
  translator.handleEvent({ type: "response.output_text.delta", delta: "all good" });
  translator.handleEvent({ type: "error", message: "litellm.APIError: Response API in-stream error" });

  assert.equal(isDone(), true);
  assert.equal(warnings.length, 1);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.equal(
    chunks.some((c) => c.error),
    false,
    "no error should reach the client once real content was streamed"
  );
});

test("genuine error with no prior output is surfaced to the client", () => {
  const { translator, chunks, isDone } = harness();
  translator.handleEvent({ type: "error", message: "rate limited" });

  assert.equal(isDone(), true);
  assert.equal(
    chunks.some((c) => c.error?.message === "rate limited"),
    true
  );
});

test("handleStreamEndedWithoutTerminalEvent: with output already seen, finishes cleanly", () => {
  const { translator, isDone } = harness();
  translator.handleEvent({ type: "response.output_text.delta", delta: "partial" });
  translator.handleStreamEndedWithoutTerminalEvent();
  assert.equal(isDone(), true);
});

test("handleStreamEndedWithoutTerminalEvent: with no output, stays unfinished so caller can retry", () => {
  const { translator, isDone } = harness();
  translator.handleStreamEndedWithoutTerminalEvent();
  assert.equal(isDone(), false);
});

test("wantUsage: emits a trailing usage-only chunk when requested", () => {
  const { chunks } = (() => {
    const h = harness({ wantUsage: true });
    h.translator.handleEvent({ type: "response.output_text.delta", delta: "hi" });
    h.translator.handleEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    });
    return h;
  })();
  const usageChunk = chunks.find((c) => c.usage);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
});
