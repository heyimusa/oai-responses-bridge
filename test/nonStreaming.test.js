import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesJsonToChatCompletion } from "../src/translate/nonStreaming.js";

test("text-only response maps to a plain assistant message", () => {
  const out = responsesJsonToChatCompletion(
    {
      id: "resp_1",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
    "gpt-6-sol"
  );
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "OK");
  assert.equal(out.choices[0].message.tool_calls, undefined);
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
});

test("function_call output maps to tool_calls with finish_reason=tool_calls", () => {
  const out = responsesJsonToChatCompletion(
    {
      id: "resp_2",
      output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Jakarta"}' }],
      usage: {},
    },
    "gpt-6-sol"
  );
  assert.equal(out.choices[0].message.content, null);
  assert.deepEqual(out.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } },
  ]);
  assert.equal(out.choices[0].finish_reason, "tool_calls");
});
