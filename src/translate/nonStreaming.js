// Translates a complete (non-streaming) Responses API response body into a
// Chat Completions response body.

/**
 * @param {object} responsesJson The parsed Responses API JSON response.
 * @param {string} model The model name to report back (echoes the request).
 * @returns {object} A Chat Completions `chat.completion` response body.
 */
export function responsesJsonToChatCompletion(responsesJson, model) {
  const toolCalls = [];
  let text = "";

  for (const item of responsesJson.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") text += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    }
  }

  return {
    id: responsesJson.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: responsesJson.usage?.input_tokens ?? 0,
      completion_tokens: responsesJson.usage?.output_tokens ?? 0,
      total_tokens: responsesJson.usage?.total_tokens ?? 0,
    },
  };
}
