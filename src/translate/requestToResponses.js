// Translates an OpenAI Chat Completions request body into an OpenAI Responses
// API request body. This is the shape-conversion half of the bridge: it knows
// nothing about HTTP, retries, or SSE — just object-to-object mapping — so it
// can be unit tested in isolation.

/**
 * @param {Array<object>} messages Chat Completions `messages` array.
 * @returns {Array<object>} Responses API `input` array.
 */
export function messagesToInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: stringifyToolOutput(m.content),
      });
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const text = extractText(m.content);
      if (text) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? "{}",
        });
      }
      continue;
    }

    const role = m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
    input.push({ role, content: contentPartsFor(role, m.content) });
  }
  return input;
}

function stringifyToolOutput(content) {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content);
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "string" || c?.type === "text")
      .map((c) => (typeof c === "string" ? c : c.text ?? ""))
      .join("");
  }
  return "";
}

/**
 * Converts a Chat Completions `content` field (string, or an array of
 * text/image parts) into Responses API content parts. Images are preserved
 * (as `input_image`) rather than silently dropped, since coding agents
 * routinely attach screenshots.
 */
function contentPartsFor(role, content) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: textType, text: "" }];
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: textType, text: part });
    } else if (part?.type === "text") {
      parts.push({ type: textType, text: part.text ?? "" });
    } else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }
  return parts.length ? parts : [{ type: textType, text: "" }];
}

/**
 * @param {Array<object>|undefined} tools Chat Completions `tools` array.
 * @returns {Array<object>|undefined} Responses API `tools` array.
 */
export function toolsToResponsesTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => {
    const out = {
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    };
    if (typeof t.function.strict === "boolean") out.strict = t.function.strict;
    return out;
  });
}

function toolChoiceFor(toolChoice) {
  if (!toolChoice || toolChoice === "auto") return undefined;
  if (toolChoice === "required") return "required";
  if (toolChoice === "none") return "none";
  if (typeof toolChoice === "object" && toolChoice.function?.name) {
    return { type: "function", name: toolChoice.function.name };
  }
  return undefined;
}

/**
 * @param {object} chatBody A Chat Completions request body.
 * @param {{ defaultReasoningEffort?: string }} [opts]
 * @returns {object} A Responses API request body.
 */
export function buildResponsesBody(chatBody, opts = {}) {
  const defaultEffort = opts.defaultReasoningEffort ?? "high";

  const body = {
    model: chatBody.model,
    input: messagesToInput(chatBody.messages),
    stream: !!chatBody.stream,
  };

  const tools = toolsToResponsesTools(chatBody.tools);
  if (tools) body.tools = tools;

  const toolChoice = toolChoiceFor(chatBody.tool_choice);
  if (toolChoice) body.tool_choice = toolChoice;

  if (typeof chatBody.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = chatBody.parallel_tool_calls;
  }

  const effort = String(chatBody.reasoning_effort || defaultEffort || "").toLowerCase();
  if (effort && effort !== "none") body.reasoning = { effort };

  const maxOut = chatBody.max_output_tokens ?? chatBody.max_completion_tokens ?? chatBody.max_tokens;
  if (maxOut) body.max_output_tokens = maxOut;

  if (chatBody.temperature !== undefined) body.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) body.top_p = chatBody.top_p;

  return body;
}
