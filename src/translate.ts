// Anthropic <-> OpenAI translation (Chat Completions + Responses)
// + OpenAI -> Zen (for the OpenAI-compatible proxy endpoint)

export type AnthropicBlock = any;
export type AnthropicMsg = { role: string; content: any };
export type AnthropicReq = {
  model: string;
  max_tokens: number;
  system?: any;
  messages: AnthropicMsg[];
  tools?: any[];
  tool_choice?: any;
  thinking?: any;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  [k: string]: any;
};

function blocksOf(content: any): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function systemToString(system: any): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((b: any) => (typeof b === "string" ? b : b.text ?? "")).join("\n");
  }
  return "";
}

function imageToDataUrl(src: any): string | null {
  if (!src) return null;
  if (src.type === "base64") {
    return `data:${src.media_type};base64,${src.data}`;
  }
  if (src.type === "url") return src.url;
  return null;
}

// ---- Anthropic -> OpenAI Chat ----
function blockToChatPart(b: any): any | null {
  if (!b || typeof b === "string") return { type: "text", text: typeof b === "string" ? b : "" };
  if (b.type === "text") return { type: "text", text: b.text ?? "" };
  if (b.type === "image") {
    const src = b.source;
    if (src?.type === "file") {
      // Chat image_url has no file_id slot — keep a pointer, don't drop silently.
      return { type: "text", text: `[image file_id ${src.file_id}: re-upload required]` };
    }
    const url = imageToDataUrl(src);
    if (url) return { type: "image_url", image_url: { url, detail: "auto" } };
    return null;
  }
  if (b.type === "document") return documentToChatPart(b);
  return null; // thinking, tool_result (handled by caller), unknown
}

export function anthropicToChat(req: AnthropicReq, baseModel: string, effort?: string) {
  const messages: any[] = [];
  const sys = systemToString(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of req.messages) {
    const blocks = blocksOf(m.content);
    if (m.role === "user") {
      // Group tool_results into consecutive tool messages: leading text goes
      // out first, trailing text last. Interleaving user messages between tool
      // messages breaks the assistant(tool_calls)->tool pairing on strict
      // providers, so tools are never split by user content here.
      const leading: any[] = [];
      const toolsOut: any[] = [];
      const trailing: any[] = [];
      let seenTool = false;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          seenTool = true;
          toolsOut.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: flattenToolResult(b.content, b.is_error),
          });
        } else {
          const part = blockToChatPart(b);
          if (!part) continue;
          (seenTool ? trailing : leading).push(part);
        }
      }
      const pushUser = (parts: any[]) => {
        if (!parts.length) return;
        messages.push({
          role: "user",
          content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
        });
      };
      pushUser(leading);
      messages.push(...toolsOut);
      pushUser(trailing);
      if (!blocks.length) messages.push({ role: "user", content: "" });
    } else {
      // assistant: text + tool_use (+ drop thinking)
      const contentParts: any[] = [];
      const toolCalls: any[] = [];
      for (const b of blocks) {
        if (b.type === "text") contentParts.push({ type: "text", text: b.text ?? "" });
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === "image") {
          const url = imageToDataUrl(b.source);
          if (url) contentParts.push({ type: "image_url", image_url: { url } });
        }
        // thinking / redacted_thinking dropped (no upstream equivalent for chat)
      }
      const hasText = contentParts.length > 0;
      messages.push({
        role: "assistant",
        content: !hasText && toolCalls.length ? null : contentParts.length === 1 && contentParts[0].type === "text"
          ? contentParts[0].text
          : contentParts.length ? contentParts : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  const tools = toOpenAITools(req.tools, false);

  let tool_choice: any;
  const tc = req.tool_choice;
  if (tc) {
    if (tc.type === "auto") tool_choice = "auto";
    else if (tc.type === "any") tool_choice = "required";
    else if (tc.type === "none") tool_choice = "none";
    else if (tc.type === "tool") tool_choice = { type: "function", function: { name: tc.name } };
  }

  const body: any = {
    model: baseModel,
    messages,
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {}),
    ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
    ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  if (effort) {
    body.reasoning_effort = effort;
    body.reasoning = { effort };
  }
  return body;
}

export function flattenToolResult(content: any, isError?: boolean): string {
  const blocks = blocksOf(content);
  const prefix = isError ? "Error:\n" : "";
  if (!blocks.length) return prefix + (typeof content === "string" ? content : "");
  const texts = blocks.map((b: any) => {
    if (typeof b === "string") return b;
    if (b.type === "text") return b.text ?? "";
    if (b.type === "image") return "[image in tool_result: omitted]";
    if (b.type === "document") return "[document in tool_result: omitted]";
    return JSON.stringify(b);
  });
  return prefix + texts.join("\n");
}

export function documentToChatPart(b: any) {
  try {
    const src = b.source;
    if (src?.type === "base64") {
      const mime = src.media_type ?? "application/pdf";
      const dataUrl = `data:${mime};base64,${src.data}`;
      return { type: "file", file: { filename: b.title ?? b.name ?? "document.pdf", file_data: dataUrl } };
    }
    if (src?.type === "file") {
      // Files-API reference: OpenAI chat file part accepts file_id.
      return { type: "file", file: { filename: b.title ?? "document.pdf", file_id: src.file_id } };
    }
    // URL sources can't go in file_data (base64 only) — keep a text pointer
    // so the model still sees the reference instead of silently dropping it.
    if (src?.type === "url") return { type: "text", text: `[document: ${src.url}]` };
    if (src?.type === "text") return { type: "text", text: src.data ?? "" };
  } catch { /* fall through */ }
  return null;
}

function documentToResponsesPart(b: any): any | null {
  const src = b.source;
  if (src?.type === "base64") {
    return {
      type: "input_file",
      filename: b.title ?? "document.pdf",
      file_data: `data:${src.media_type ?? "application/pdf"};base64,${src.data}`,
    };
  }
  if (src?.type === "file") {
    return { type: "input_file", file_id: src.file_id };
  }
  if (src?.type === "url") return { type: "input_text", text: `[document: ${src.url}]` };
  if (src?.type === "text") return { type: "input_text", text: src.data ?? "" };
  return null;
}

function imageToResponsesPart(src: any): any | null {
  if (src?.type === "base64") {
    return { type: "input_image", image_url: `data:${src.media_type};base64,${src.data}`, detail: "auto" };
  }
  if (src?.type === "url") {
    return { type: "input_image", image_url: src.url, detail: "auto" };
  }
  if (src?.type === "file") {
    return { type: "input_image", file_id: src.file_id, detail: "auto" };
  }
  return null;
}

// Only custom function tools translate to OpenAI. Server-side tool types
// (computer, web_search, bash_code_execution, …) have no OpenAI equivalent
// and are dropped — callers should prefer the messages-passthrough route
// for models that support them natively.
export function toOpenAITools(tools: any[] | undefined, responsesStyle: boolean) {
  const custom = (tools ?? []).filter((t: any) => {
    const ty = t.type ?? "tool";
    return (ty === "tool" || ty === "function") && typeof t.name === "string" && t.name;
  });
  return custom.map((t: any) =>
    responsesStyle
      ? {
        type: "function",
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? t.parameters ?? { type: "object", properties: {} },
      }
      : {
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema ?? t.parameters ?? { type: "object", properties: {} },
        },
      },
  );
}

// ---- Anthropic -> OpenAI Responses (input items) ----
export function anthropicToResponses(req: AnthropicReq, baseModel: string, effort?: string) {
  const input: any[] = [];
  const sys = systemToString(req.system);
  if (sys) input.push({ role: "system", content: [{ type: "input_text", text: sys }] });

  for (const m of req.messages) {
    const blocks = blocksOf(m.content);
    if (m.role === "user") {
      const content: any[] = [];
      const flushUser = () => {
        if (content.length) input.push({ role: "user", content: content.splice(0) });
      };
      for (const b of blocks) {
        if (b.type === "text") content.push({ type: "input_text", text: b.text ?? "" });
        else if (b.type === "image") {
          const part = imageToResponsesPart(b.source);
          if (part) content.push(part);
        } else if (b.type === "document") {
          const part = documentToResponsesPart(b);
          if (part) content.push(part);
        } else if (b.type === "tool_result") {
          flushUser();
          input.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: flattenToolResult(b.content, b.is_error),
          });
        }
      }
      flushUser();
      if (!blocks.length) input.push({ role: "user", content: [{ type: "input_text", text: "" }] });
    } else {
      for (const b of blocks) {
        if (b.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: b.text ?? "" }] });
        else if (b.type === "tool_use") {
          input.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      if (!blocks.length) input.push({ role: "assistant", content: [{ type: "output_text", text: "" }] });
    }
  }

  const tools = toOpenAITools(req.tools, true);
  let tool_choice: any;
  const tc = req.tool_choice;
  if (tc) {
    if (tc.type === "auto") tool_choice = "auto";
    else if (tc.type === "any") tool_choice = "required";
    else if (tc.type === "none") tool_choice = "none";
    else if (tc.type === "tool") tool_choice = { type: "function", name: tc.name };
  }

  const body: any = {
    model: baseModel,
    input,
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {}),
    ...(req.max_tokens ? { max_output_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stream ? { stream: true } : {}),
  };
  if (effort) {
    body.reasoning = { effort };
    body.reasoning_effort = effort;
  }
  return body;
}

// ---- OpenAI Chat response -> Anthropic ----
let msgCounter = 0;
export function newAnthropicId() {
  msgCounter += 1;
  return `msg_proxy_${Date.now().toString(36)}${msgCounter}`;
}

export function chatToAnthropic(data: any, baseModel: string) {
  const choice = data?.choices?.[0];
  const msg = choice?.message ?? {};
  const content: any[] = [];
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p.type === "text") content.push({ type: "text", text: p.text ?? "" });
      else if (p.type === "image_url") content.push({ type: "text", text: `[image: ${p.image_url?.url ?? ""}]` });
    }
  }
  if (!content.length && !(msg.tool_calls?.length)) {
    if (typeof msg.refusal === "string" && msg.refusal) content.push({ type: "text", text: msg.refusal });
    else content.push({ type: "text", text: "" });
  }
  for (const tc of msg.tool_calls ?? []) {
    let input: any = {};
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { input = { _raw: tc.function?.arguments ?? "" }; }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input });
  }
  if (msg.reasoning_content) {
    content.unshift({ type: "thinking", thinking: String(msg.reasoning_content).slice(0, 4000) });
  }
  let stop_reason: string | null = "end_turn";
  const fr = choice?.finish_reason;
  if (fr === "tool_calls" || fr === "function_call") stop_reason = "tool_use";
  else if (fr === "length") stop_reason = "max_tokens";
  else if (fr === "content_filter") stop_reason = "refusal";
  else if (fr === "stop") stop_reason = "end_turn";
  return {
    id: data?.id ? `msg_${data.id}` : newAnthropicId(),
    type: "message",
    role: "assistant",
    model: baseModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- OpenAI Responses -> Anthropic ----
export function responsesToAnthropic(data: any, baseModel: string) {
  const content: any[] = [];
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text") content.push({ type: "text", text: c.text ?? "" });
        else if (c.type === "refusal") content.push({ type: "text", text: c.refusal ?? "" });
      }
    } else if (item.type === "function_call") {
      let input: any = {};
      try { input = JSON.parse(item.arguments ?? "{}"); } catch { input = { _raw: item.arguments ?? "" }; }
      content.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name ?? "", input });
    } else if (item.type === "reasoning") {
      const t = item.summary?.map?.((s: any) => s.text ?? "").join("\n") ?? item.content ?? "";
      if (t) content.unshift({ type: "thinking", thinking: String(t).slice(0, 4000) });
    }
  }
  if (!content.length) content.push({ type: "text", text: data?.output_text ?? "" });
  const hasTool = content.some((c) => c.type === "tool_use");
  return {
    id: data?.id ? `msg_${data.id}` : newAnthropicId(),
    type: "message",
    role: "assistant",
    model: baseModel,
    content,
    stop_reason: hasTool ? "tool_use" : data?.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.input_tokens ?? 0,
      output_tokens: data?.usage?.output_tokens ?? 0,
    },
  };
}

// ---- OpenAI Responses -> OpenAI Chat (non-streaming) ----
export function responsesToOpenAIChat(data: any, baseModel: string) {
  const output = Array.isArray(data?.output) ? data.output : [];
  let textContent = "";
  const toolCalls: any[] = [];
  let reasoning_content: string | undefined;

  for (const item of output) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text") textContent += c.text ?? "";
        else if (c.type === "refusal") textContent += c.refusal ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${Date.now()}`,
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "{}",
        },
      });
    } else if (item.type === "reasoning") {
      reasoning_content = item.summary?.map?.((s: any) => s.text ?? "").join("\n") ?? item.content ?? "";
    }
  }

  if (!textContent && !toolCalls.length) textContent = data?.output_text ?? "";

  const hasTool = toolCalls.length > 0;
  let finish_reason = "stop";
  if (hasTool) finish_reason = "tool_calls";
  else if (data?.status === "incomplete") finish_reason = "length";

  const message: any = {
    role: "assistant",
    content: textContent || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning_content ? { reasoning_content } : {}),
  };

  return {
    id: data?.id ?? `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: baseModel,
    choices: [{ index: 0, message, finish_reason }],
    usage: {
      prompt_tokens: data?.usage?.input_tokens ?? 0,
      completion_tokens: data?.usage?.output_tokens ?? 0,
      total_tokens: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0),
    },
  };
}

// ---- Anthropic Messages -> OpenAI Chat (non-streaming) ----
export function messagesToOpenAIChat(data: any, baseModel: string) {
  const content = Array.isArray(data?.content) ? data.content : [];
  let textContent = "";
  const toolCalls: any[] = [];
  let reasoning_content: string | undefined;

  for (const block of content) {
    if (block.type === "text") textContent += block.text ?? "";
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `call_${Date.now()}`,
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === "thinking") {
      reasoning_content = block.thinking ?? "";
    }
  }

  const hasTool = toolCalls.length > 0;
  let finish_reason = "stop";
  if (hasTool) finish_reason = "tool_calls";
  else if (data?.stop_reason === "max_tokens") finish_reason = "length";

  const message: any = {
    role: "assistant",
    content: textContent || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(reasoning_content ? { reasoning_content } : {}),
  };

  return {
    id: data?.id ?? `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: baseModel,
    choices: [{ index: 0, message, finish_reason }],
    usage: {
      prompt_tokens: data?.usage?.input_tokens ?? 0,
      completion_tokens: data?.usage?.output_tokens ?? 0,
      total_tokens: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0),
    },
  };
}

// ---- OpenAI Chat request -> Zen format ----
// Accepts an OpenAI-format chat request and routes it to the correct Zen endpoint

export type OpenAIChatReq = {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: any;
  n?: number;
  [k: string]: any;
};

/**
 * For "chat"-kind upstream: the OpenAI request is already in the right format.
 * Just normalize and pass through.
 */
export function openaiChatToChatBody(req: OpenAIChatReq, baseModel: string, effort?: string) {
  const body: any = {
    model: baseModel,
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
    ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}),
    ...(req.max_completion_tokens ? { max_tokens: req.max_completion_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop ? { stop: req.stop } : {}),
    ...(req.stream ? { stream: true, stream_options: req.stream_options ?? { include_usage: true } } : {}),
  };
  if (effort) {
    body.reasoning_effort = effort;
    body.reasoning = { effort };
  }
  return body;
}

/**
 * For "responses"-kind upstream: convert OpenAI chat messages → Responses input items.
 */
export function openaiChatToResponsesBody(req: OpenAIChatReq, baseModel: string, effort?: string) {
  const input: any[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : "");
      if (text) input.push({ role: "system", content: [{ type: "input_text", text }] });
    } else if (m.role === "user") {
      const contentParts: any[] = [];
      if (typeof m.content === "string") {
        contentParts.push({ type: "input_text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text") contentParts.push({ type: "input_text", text: p.text ?? "" });
          else if (p.type === "image_url") contentParts.push({ type: "input_image", image_url: p.image_url?.url ?? "", detail: p.image_url?.detail ?? "auto" });
          else if (p.type === "file") {
            if (p.file?.file_data) contentParts.push({ type: "input_file", filename: p.file.filename ?? "file", file_data: p.file.file_data });
            else if (p.file?.file_id) contentParts.push({ type: "input_file", file_id: p.file.file_id });
          }
        }
      }
      if (contentParts.length) input.push({ role: "user", content: contentParts });
      else input.push({ role: "user", content: [{ type: "input_text", text: "" }] });
    } else if (m.role === "assistant") {
      // Text content
      if (typeof m.content === "string" && m.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      // Tool calls
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "{}",
        });
      }
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
    }
  }

  // Convert OpenAI tools to responses format
  const tools = (req.tools ?? []).map((t: any) => ({
    type: "function",
    name: t.function?.name ?? t.name ?? "",
    description: t.function?.description ?? t.description ?? "",
    parameters: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
  }));

  let tool_choice: any;
  if (req.tool_choice !== undefined) {
    if (typeof req.tool_choice === "string") {
      tool_choice = req.tool_choice; // "auto", "none", "required"
    } else if (req.tool_choice?.type === "function") {
      tool_choice = { type: "function", name: req.tool_choice.function?.name };
    }
  }

  const body: any = {
    model: baseModel,
    input,
    ...(tools.length ? { tools, ...(tool_choice !== undefined ? { tool_choice } : {}) } : {}),
    ...(req.max_tokens || req.max_completion_tokens ? { max_output_tokens: req.max_tokens ?? req.max_completion_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stream ? { stream: true } : {}),
  };
  if (effort) {
    body.reasoning = { effort };
    body.reasoning_effort = effort;
  }
  return body;
}

/**
 * For "messages"-kind upstream: convert OpenAI chat messages → Anthropic messages format.
 */
export function openaiChatToMessagesBody(req: OpenAIChatReq, baseModel: string, effort?: string) {
  let system: string | undefined;
  const messages: any[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : "");
      system = system ? system + "\n" + text : text;
    } else if (m.role === "user") {
      const blocks: any[] = [];
      if (typeof m.content === "string") {
        blocks.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text") blocks.push({ type: "text", text: p.text ?? "" });
          else if (p.type === "image_url") {
            const url = p.image_url?.url ?? "";
            if (url.startsWith("data:")) {
              // Parse data URL into base64 source
              const match = url.match(/^data:(.*?);base64,(.*)$/);
              if (match) {
                blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
              }
            } else {
              blocks.push({ type: "image", source: { type: "url", url } });
            }
          }
        }
      }
      if (blocks.length) messages.push({ role: "user", content: blocks });
      else messages.push({ role: "user", content: [{ type: "text", text: "" }] });
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (typeof m.content === "string" && m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        let input: any = {};
        try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { input = { _raw: tc.function?.arguments ?? "" }; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
      else messages.push({ role: "assistant", content: [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      // Tool results need to be merged into the preceding user message or
      // create a new user message with tool_result blocks
      const lastMsg = messages[messages.length - 1];
      const resultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      };
      if (lastMsg?.role === "user") {
        // Append tool_result to existing user message
        if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(resultBlock);
        } else {
          lastMsg.content = [lastMsg.content, resultBlock];
        }
      } else {
        messages.push({ role: "user", content: [resultBlock] });
      }
    }
  }

  // Convert tools to Anthropic format
  const tools = (req.tools ?? []).map((t: any) => ({
    name: t.function?.name ?? t.name ?? "",
    description: t.function?.description ?? t.description ?? "",
    input_schema: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
  }));

  let tool_choice: any;
  if (req.tool_choice !== undefined) {
    if (typeof req.tool_choice === "string") {
      if (req.tool_choice === "auto") tool_choice = { type: "auto" };
      else if (req.tool_choice === "none") tool_choice = { type: "none" };
      else if (req.tool_choice === "required") tool_choice = { type: "any" };
    } else if (req.tool_choice?.type === "function") {
      tool_choice = { type: "tool", name: req.tool_choice.function?.name };
    }
  }

  const maxTokens = req.max_tokens ?? req.max_completion_tokens ?? 4096;

  const body: any = {
    model: baseModel,
    messages,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop ? { stop_sequences: Array.isArray(req.stop) ? req.stop : [req.stop] } : {}),
    ...(req.stream ? { stream: true } : {}),
  };
  return body;
}

export function estimateTokens(req: AnthropicReq): number {
  const messages = Array.isArray((req as any)?.messages) ? (req as any).messages : [];
  let chars = 0;
  chars += systemToString((req as any)?.system).length;
  for (const m of messages) {
    const blocks = blocksOf(m.content);
    for (const b of blocks) {
      if (typeof b === "string") chars += b.length;
      else if (b.type === "text") chars += (b.text ?? "").length;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length + (b.name ?? "").length;
      else if (b.type === "tool_result") chars += flattenToolResult(b.content, b.is_error).length;
      else if (b.type === "image" || b.type === "document") {
        // base64 payloads are real tokens on the wire — count them instead of
        // using a flat guess; remote URLs keep a small placeholder estimate.
        const src = b.source ?? {};
        if (src.type === "base64" && typeof src.data === "string") chars += src.data.length;
        else chars += 1500;
      } else chars += 200;
    }
  }
  for (const t of (req as any)?.tools ?? []) chars += JSON.stringify(t).length;
  return Math.ceil(chars / 4);
}
