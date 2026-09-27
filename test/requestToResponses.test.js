import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messagesToInput,
  toolsToResponsesTools,
  buildResponsesBody,
} from "../src/translate/requestToResponses.js";

test("messagesToInput: plain user/system text", () => {
  const input = messagesToInput([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(input, [
    { role: "system", content: [{ type: "input_text", text: "be terse" }] },
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
});

test("messagesToInput: assistant message with tool_calls becomes function_call items", () => {
  const input = messagesToInput([
    {
      role: "assistant",
      content: "checking weather",
      tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }],
    },
  ]);
  assert.deepEqual(input, [
    { role: "assistant", content: [{ type: "output_text", text: "checking weather" }] },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Jakarta"}' },
  ]);
});

test("messagesToInput: assistant tool_calls with no text content emits no text part", () => {
  const input = messagesToInput([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "f", arguments: "{}" } }] },
  ]);
  assert.deepEqual(input, [{ type: "function_call", call_id: "call_1", name: "f", arguments: "{}" }]);
});

test("messagesToInput: tool role becomes function_call_output", () => {
  const input = messagesToInput([{ role: "tool", tool_call_id: "call_1", content: "22°C, cerah" }]);
  assert.deepEqual(input, [{ type: "function_call_output", call_id: "call_1", output: "22°C, cerah" }]);
});

test("messagesToInput: tool role with object content is JSON-stringified", () => {
  const input = messagesToInput([{ role: "tool", tool_call_id: "call_1", content: { temp: 22 } }]);
  assert.equal(input[0].output, '{"temp":22}');
});

test("messagesToInput: array content with text and image parts", () => {
  const input = messagesToInput([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    },
  ]);
  assert.deepEqual(input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "https://example.com/a.png" },
      ],
    },
  ]);
});

test("toolsToResponsesTools: flattens function schema and preserves strict flag", () => {
  const tools = toolsToResponsesTools([
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        strict: true,
      },
    },
  ]);
  assert.deepEqual(tools, [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      strict: true,
    },
  ]);
});

test("toolsToResponsesTools: undefined when no tools given", () => {
  assert.equal(toolsToResponsesTools(undefined), undefined);
  assert.equal(toolsToResponsesTools([]), undefined);
});

test("buildResponsesBody: applies default reasoning effort when request omits it", () => {
  const body = buildResponsesBody(
    { model: "gpt-6-sol", messages: [{ role: "user", content: "hi" }] },
    { defaultReasoningEffort: "high" }
  );
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("buildResponsesBody: 'none' effort omits the reasoning field entirely", () => {
  const body = buildResponsesBody(
    { model: "gpt-6-sol", messages: [], reasoning_effort: "none" },
    { defaultReasoningEffort: "high" }
  );
  assert.equal("reasoning" in body, false);
});

test("buildResponsesBody: explicit request effort overrides the default", () => {
  const body = buildResponsesBody(
    { model: "gpt-6-sol", messages: [], reasoning_effort: "low" },
    { defaultReasoningEffort: "high" }
  );
  assert.deepEqual(body.reasoning, { effort: "low" });
});

test("buildResponsesBody: maps tool_choice variants", () => {
  assert.equal(buildResponsesBody({ model: "m", messages: [], tool_choice: "required" }).tool_choice, "required");
  assert.equal(buildResponsesBody({ model: "m", messages: [], tool_choice: "none" }).tool_choice, "none");
  assert.deepEqual(
    buildResponsesBody({ model: "m", messages: [], tool_choice: { type: "function", function: { name: "f" } } })
      .tool_choice,
    { type: "function", name: "f" }
  );
  assert.equal("tool_choice" in buildResponsesBody({ model: "m", messages: [], tool_choice: "auto" }), false);
});

test("buildResponsesBody: carries stream flag and max_output_tokens through", () => {
  const body = buildResponsesBody({ model: "m", messages: [], stream: true, max_tokens: 512 });
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, 512);
});
