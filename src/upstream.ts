import { ZEN_BASE, zenAuth, UPSTREAM_TIMEOUT_MS, RETRY_MAX_ATTEMPTS, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from "./config.ts";

export const UPSTREAM_TIMEOUT_SENTINEL = "upstream-timeout";

export function zenHeaders() {
  return {
    ...zenAuth(),
    "Content-Type": "application/json",
  };
}

export function zenUrl(kind: "chat" | "responses" | "messages"): string {
  if (kind === "chat") return `${ZEN_BASE}/chat/completions`;
  if (kind === "responses") return `${ZEN_BASE}/responses`;
  return `${ZEN_BASE}/messages`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryDelay(attempt: number, retryAfterHeader?: string | null): number {
  // Respect Retry-After header if present
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, RETRY_MAX_DELAY_MS);
  }
  // Exponential backoff with jitter
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function fetchZen(kind: "chat" | "responses" | "messages", body: any, stream: boolean) {
  // Non-streaming calls get a total timeout; streams are unbounded by design
  // (bytes flow continuously) and rely on the client disconnecting instead.
  const url = zenUrl(kind);
  const headers = zenHeaders();
  const bodyStr = JSON.stringify(body);

  let lastError: any = null;
  const maxAttempts = stream ? 1 : RETRY_MAX_ATTEMPTS; // Don't retry streams

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const init: RequestInit = {
      method: "POST",
      headers,
      body: bodyStr,
    };
    if (!stream && UPSTREAM_TIMEOUT_MS > 0) {
      init.signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    }
    try {
      const res = await fetch(url, init);
      // Don't retry on non-retryable errors
      if (res.ok || !isRetryable(res.status) || attempt === maxAttempts - 1) {
        return res;
      }
      // Retryable error — consume body to free connection, then wait
      const retryAfter = res.headers.get("retry-after");
      await res.text().catch(() => {}); // drain body
      const delay = retryDelay(attempt, retryAfter);
      console.log(`[upstream] ${kind} returned ${res.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(delay);
    } catch (e: any) {
      lastError = e;
      if (e?.name === "TimeoutError") {
        const err: any = new Error(`zen ${kind} timed out after ${UPSTREAM_TIMEOUT_MS}ms`);
        err.code = UPSTREAM_TIMEOUT_SENTINEL;
        throw err;
      }
      // Network errors can be retried
      if (attempt < maxAttempts - 1) {
        const delay = retryDelay(attempt);
        console.log(`[upstream] ${kind} network error: ${e?.message}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
  throw lastError ?? new Error(`exhausted ${maxAttempts} retry attempts`);
}

/** Parse an upstream body as JSON; callers get {data} or {text} for error paths. */
export async function readUpstreamBody(res: Response): Promise<{ data?: any; text: string }> {
  const text = await res.text().catch(() => "");
  if (!text) return { text: "" };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { text }; // HTML proxy errors, gateway pages, truncated bodies
  }
}

export type MappedError = { status: number; type: string; message: string; retryAfter?: string };

// -- OpenAI-format error helpers --
export function openaiError(status: number, type: string, message: string, code?: string) {
  return {
    error: {
      message,
      type,
      code: code ?? type,
      param: null,
    },
  };
}

export function anthropicError(type: string, message: string) {
  return {
    error: { type, message },
  };
}

/** Map Zen HTTP failures onto Anthropic-style errors. Never leaks the API key. */
export function mapUpstreamError(kind: string, status: number, text: string, retryAfter?: string | null): MappedError {
  const snippet = text.slice(0, 500);
  let upstreamType = "";
  try {
    const parsed = JSON.parse(text);
    upstreamType = parsed?.error?.type ?? parsed?.type ?? "";
  } catch { /* non-JSON body */ }
  if (upstreamType === "FreeTierError" || /free tier can only be used from within opencode/i.test(text)) {
    return {
      status: 403,
      type: "authentication_error",
      message: "Zen free tier is only served to the OpenCode client. Set OPENCODE_API_KEY (Console service key) on the proxy or use a paid model.",
    };
  }
  if (status === 401 || status === 403) {
    return { status: 500, type: "api_error", message: `proxy misconfigured: Zen rejected the Console key (zen ${kind} ${status}). Check OPENCODE_API_KEY.` };
  }
  if (status === 400) return { status: 400, type: "invalid_request_error", message: `zen ${kind} 400: ${snippet}` };
  if (status === 404) return { status: 404, type: "not_found_error", message: `zen ${kind} 404: ${snippet}` };
  if (status === 429) {
    return { status: 429, type: "rate_limit_error", message: `zen ${kind} rate-limited: ${snippet}`, retryAfter: retryAfter ?? undefined };
  }
  return { status: 502, type: "api_error", message: `zen ${kind} ${status}: ${snippet}` };
}

/** Map error to OpenAI error format */
export function mapUpstreamErrorOpenAI(kind: string, status: number, text: string, retryAfter?: string | null): MappedError & { openaiType: string; openaiCode: string } {
  const mapped = mapUpstreamError(kind, status, text, retryAfter);
  // Map Anthropic error types to OpenAI equivalents
  let openaiType = "server_error";
  let openaiCode = "internal_error";
  if (mapped.type === "invalid_request_error") { openaiType = "invalid_request_error"; openaiCode = "invalid_request"; }
  else if (mapped.type === "authentication_error") { openaiType = "invalid_request_error"; openaiCode = "invalid_api_key"; }
  else if (mapped.type === "rate_limit_error") { openaiType = "tokens"; openaiCode = "rate_limit_exceeded"; }
  else if (mapped.type === "not_found_error") { openaiType = "invalid_request_error"; openaiCode = "model_not_found"; }
  return { ...mapped, openaiType, openaiCode };
}

export function isTimeout(e: any): boolean {
  return e?.code === UPSTREAM_TIMEOUT_SENTINEL || e?.name === "TimeoutError";
}

export type ScannedUsage = { input_tokens: number; output_tokens: number; found: boolean };

/**
 * Pass-through wrapper for an Anthropic SSE stream that records the
 * input/output tokens from the terminal message_delta event. Lets streaming
 * responses log exact usage/cost instead of zeros.
 */
export function withUsageScan(source: ReadableStream<Uint8Array>, onDone: (usage: ScannedUsage, error?: string) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const usage: ScannedUsage = { input_tokens: 0, output_tokens: 0, found: false };
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          ctrl.enqueue(value);
          buf += dec.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const ev of events) {
            for (const line of ev.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                const json = JSON.parse(payload);
                const u = json?.usage;
                if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
                  if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
                  if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
                  usage.found = true;
                }
              } catch { /* ping / non-JSON keepalives */ }
            }
          }
        }
        onDone(usage);
        ctrl.close();
      } catch (e: any) {
        onDone(usage, String(e?.message ?? e));
        ctrl.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

/** Scan an OpenAI-format SSE stream for usage data */
export function withOpenAIUsageScan(source: ReadableStream<Uint8Array>, onDone: (usage: ScannedUsage, error?: string) => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const usage: ScannedUsage = { input_tokens: 0, output_tokens: 0, found: false };
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          ctrl.enqueue(value);
          buf += dec.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const ev of events) {
            for (const line of ev.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);
                const u = json?.usage;
                if (u) {
                  if (typeof u.prompt_tokens === "number") usage.input_tokens = u.prompt_tokens;
                  if (typeof u.completion_tokens === "number") usage.output_tokens = u.completion_tokens;
                  usage.found = true;
                }
              } catch { /* ignore */ }
            }
          }
        }
        onDone(usage);
        ctrl.close();
      } catch (e: any) {
        onDone(usage, String(e?.message ?? e));
        ctrl.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

export async function fetchZenModels(): Promise<any> {
  const init: RequestInit = { headers: { ...zenAuth() } };
  if (UPSTREAM_TIMEOUT_MS > 0) init.signal = AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT_MS, 30_000));
  const res = await fetch(`${ZEN_BASE}/models`, init);
  if (!res.ok) throw new Error(`zen models ${res.status}`);
  return res.json();
}

// ---------- streaming translators ----------

function sseSend(ctrl: ReadableStreamDefaultController, event: string, data: unknown) {
  ctrl.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function openaiSseSend(ctrl: ReadableStreamDefaultController, data: unknown) {
  ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
}

function openaiSseDone(ctrl: ReadableStreamDefaultController) {
  ctrl.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
}

async function* sseJsonLines(res: Response): AsyncGenerator<any> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n").filter((l) => l.startsWith("data:"));
      for (const l of lines) {
        const payload = l.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { yield JSON.parse(payload); } catch { /* ignore */ }
      }
    }
  }
}

// ---------- Anthropic-format streaming translators (existing) ----------

export function chatStreamToAnthropic(upstream: Response, baseModel: string, msgId: string): ReadableStream {
  return new ReadableStream({
    async start(ctrl) {
      let textOpen = false;
      let textIndex = 0;
      const toolBlocks = new Map<number, { id: string; name: string; json: string; started: boolean; index: number }>();
      let usage = { input_tokens: 0, output_tokens: 0 };
      let outputText = 0;
      sseSend(ctrl, "message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model: baseModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
      const openText = () => {
        if (!textOpen) {
          sseSend(ctrl, "content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
          textOpen = true;
        }
      };
      const closeText = () => {
        if (textOpen) {
          sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: textIndex });
          textIndex += 1;
          textOpen = false;
        }
      };
      try {
        for await (const chunk of sseJsonLines(upstream)) {
          if (chunk.usage) {
            usage = { input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens, output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens };
          }
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            openText();
            outputText += delta.content.length;
            sseSend(ctrl, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } });
          }
          if (delta.reasoning_content) {
            // surface reasoning as thinking is not streamable in Anthropic text; append as text prefix is confusing, so skip deltas
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            let b = toolBlocks.get(idx);
            if (!b) {
              b = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", json: "", started: false, index: -1 };
              toolBlocks.set(idx, b);
            }
            if (tc.id) b.id = tc.id;
            if (tc.function?.name) b.name = tc.function.name;
            if (tc.function?.arguments) b.json += tc.function.arguments;
            if (!b.started && b.name) {
              closeText();
              b.index = textIndex;
              textIndex += 1;
              sseSend(ctrl, "content_block_start", { type: "content_block_start", index: b.index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
              b.started = true;
            } else if (b.started && tc.function?.arguments) {
              sseSend(ctrl, "content_block_delta", { type: "content_block_delta", index: b.index, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
            }
          }
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) {
            closeText();
            for (const b of toolBlocks.values()) {
              if (b.started) sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: b.index });
            }
            const stopReason = fr === "tool_calls" ? "tool_use" : fr === "length" ? "max_tokens" : "end_turn";
            sseSend(ctrl, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
            sseSend(ctrl, "message_stop", { type: "message_stop" });
            (ctrl as any)._usage = usage;
            ctrl.close();
            return;
          }
        }
        closeText();
        for (const b of toolBlocks.values()) {
          if (b.started) sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: b.index });
        }
        sseSend(ctrl, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
        sseSend(ctrl, "message_stop", { type: "message_stop" });
        (ctrl as any)._usage = usage;
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}

export function responsesStreamToAnthropic(upstream: Response, baseModel: string, msgId: string): ReadableStream {
  return new ReadableStream({
    async start(ctrl) {
      let textOpen = false;
      let textIndex = 0;
      let toolIndex = -1;
      let toolId = "";
      let toolName = "";
      let toolStarted = false;
      let usage = { input_tokens: 0, output_tokens: 0 };
      sseSend(ctrl, "message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model: baseModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
      const openText = () => {
        if (!textOpen) {
          sseSend(ctrl, "content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
          textOpen = true;
        }
      };
      const closeText = () => {
        if (textOpen) {
          sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: textIndex });
          textIndex += 1;
          textOpen = false;
        }
      };
      try {
        for await (const ev of sseJsonLines(upstream)) {
          const t = ev.type ?? "";
          if (t === "response.output_text.delta" && ev.delta) {
            openText();
            sseSend(ctrl, "content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: ev.delta } });
          } else if ((t === "response.function_call_arguments.delta" || t === "response.output_item.delta") && (ev.delta || ev.arguments)) {
            const part = ev.delta ?? ev.arguments ?? "";
            if (!toolStarted) {
              closeText();
              toolIndex = textIndex;
              textIndex += 1;
              toolId = ev.call_id ?? ev.item?.call_id ?? `call_${Date.now()}`;
              toolName = ev.name ?? ev.item?.name ?? toolName;
              sseSend(ctrl, "content_block_start", { type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: toolId, name: toolName || "tool", input: {} } });
              toolStarted = true;
            }
            if (part) sseSend(ctrl, "content_block_delta", { type: "content_block_delta", index: toolIndex, delta: { type: "input_json_delta", partial_json: typeof part === "string" ? part : JSON.stringify(part) } });
          } else if (t === "response.output_item.added" || t === "response.function_call.added") {
            const item = ev.item ?? {};
            if (item.type === "function_call") {
              closeText();
              toolIndex = textIndex;
              textIndex += 1;
              toolId = item.call_id ?? item.id ?? toolId;
              toolName = item.name ?? toolName;
              sseSend(ctrl, "content_block_start", { type: "content_block_start", index: toolIndex, content_block: { type: "tool_use", id: toolId, name: toolName || "tool", input: {} } });
              toolStarted = true;
            }
          } else if (t === "response.completed" || t === "response.done") {
            const resp = ev.response ?? ev;
            usage = {
              input_tokens: resp?.usage?.input_tokens ?? usage.input_tokens,
              output_tokens: resp?.usage?.output_tokens ?? usage.output_tokens,
            };
            const hasTool = toolStarted;
            closeText();
            if (toolStarted) sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: toolIndex });
            sseSend(ctrl, "message_delta", { type: "message_delta", delta: { stop_reason: hasTool ? "tool_use" : "end_turn", stop_sequence: null }, usage });
            sseSend(ctrl, "message_stop", { type: "message_stop" });
            (ctrl as any)._usage = usage;
            ctrl.close();
            return;
          }
        }
        closeText();
        if (toolStarted) sseSend(ctrl, "content_block_stop", { type: "content_block_stop", index: toolIndex });
        sseSend(ctrl, "message_delta", { type: "message_delta", delta: { stop_reason: toolStarted ? "tool_use" : "end_turn", stop_sequence: null }, usage });
        sseSend(ctrl, "message_stop", { type: "message_stop" });
        (ctrl as any)._usage = usage;
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}

// ---------- OpenAI-format streaming: pass-through for chat completions ----------
// When Zen returns chat-format SSE, just relay it directly (it's already OpenAI-compatible)

export function chatStreamPassthrough(upstream: Response): ReadableStream<Uint8Array> {
  // Just pass through the upstream body — it's already OpenAI SSE format
  return upstream.body!;
}

// ---------- Responses-format -> OpenAI chat streaming ----------

export function responsesStreamToOpenAI(upstream: Response, baseModel: string, chatCompletionId: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(ctrl) {
      const enc = new TextEncoder();
      let usage = { prompt_tokens: 0, completion_tokens: 0 };
      const toolCalls: Map<string, { index: number; id: string; name: string; arguments: string }> = new Map();
      let toolIndex = 0;

      try {
        for await (const ev of sseJsonLines(upstream)) {
          const t = ev.type ?? "";

          if (t === "response.output_text.delta" && ev.delta) {
            openaiSseSend(ctrl, {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: baseModel,
              choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }],
            });
          } else if (t === "response.output_item.added" || t === "response.function_call.added") {
            const item = ev.item ?? {};
            if (item.type === "function_call") {
              const id = item.call_id ?? item.id ?? `call_${Date.now()}`;
              const name = item.name ?? "";
              const idx = toolIndex++;
              toolCalls.set(id, { index: idx, id, name, arguments: "" });
              openaiSseSend(ctrl, {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: baseModel,
                choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
              });
            }
          } else if ((t === "response.function_call_arguments.delta" || t === "response.output_item.delta") && (ev.delta || ev.arguments)) {
            const part = typeof (ev.delta ?? ev.arguments) === "string" ? (ev.delta ?? ev.arguments) : JSON.stringify(ev.delta ?? ev.arguments ?? "");
            // Find the active tool call
            const callId = ev.call_id ?? ev.item?.call_id;
            let tc = callId ? toolCalls.get(callId) : undefined;
            if (!tc && toolCalls.size > 0) tc = [...toolCalls.values()].pop();
            if (tc) {
              tc.arguments += part;
              openaiSseSend(ctrl, {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: baseModel,
                choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: part } }] }, finish_reason: null }],
              });
            }
          } else if (t === "response.completed" || t === "response.done") {
            const resp = ev.response ?? ev;
            usage = {
              prompt_tokens: resp?.usage?.input_tokens ?? 0,
              completion_tokens: resp?.usage?.output_tokens ?? 0,
            };
            const hasTool = toolCalls.size > 0;
            const finishReason = hasTool ? "tool_calls" : resp?.status === "incomplete" ? "length" : "stop";
            openaiSseSend(ctrl, {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: baseModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens },
            });
            openaiSseDone(ctrl);
            ctrl.close();
            return;
          }
        }
        // Stream ended without explicit done
        const hasTool = toolCalls.size > 0;
        openaiSseSend(ctrl, {
          id: chatCompletionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: baseModel,
          choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens },
        });
        openaiSseDone(ctrl);
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}

// ---------- Messages-format (Anthropic) -> OpenAI chat streaming ----------

export function messagesStreamToOpenAI(upstream: Response, baseModel: string, chatCompletionId: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(ctrl) {
      let usage = { prompt_tokens: 0, completion_tokens: 0 };
      const toolCalls: { index: number; id: string; name: string; arguments: string }[] = [];
      let currentToolIndex = 0;

      try {
        for await (const ev of sseJsonLines(upstream)) {
          const t = ev.type ?? "";

          if (t === "content_block_start") {
            const block = ev.content_block ?? {};
            if (block.type === "tool_use") {
              const idx = currentToolIndex++;
              toolCalls.push({ index: idx, id: block.id, name: block.name, arguments: "" });
              openaiSseSend(ctrl, {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: baseModel,
                choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }, finish_reason: null }],
              });
            }
          } else if (t === "content_block_delta") {
            const delta = ev.delta ?? {};
            if (delta.type === "text_delta" && delta.text) {
              openaiSseSend(ctrl, {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: baseModel,
                choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
              });
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const tc = toolCalls[toolCalls.length - 1];
              if (tc) {
                tc.arguments += delta.partial_json;
                openaiSseSend(ctrl, {
                  id: chatCompletionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: baseModel,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: delta.partial_json } }] }, finish_reason: null }],
                });
              }
            }
          } else if (t === "message_delta") {
            const d = ev.delta ?? {};
            const u = ev.usage ?? {};
            if (typeof u.output_tokens === "number") usage.completion_tokens = u.output_tokens;
            const stopReason = d.stop_reason;
            let finishReason = "stop";
            if (stopReason === "tool_use") finishReason = "tool_calls";
            else if (stopReason === "max_tokens") finishReason = "length";
            openaiSseSend(ctrl, {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: baseModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens },
            });
          } else if (t === "message_start") {
            const msg = ev.message ?? {};
            const u = msg.usage ?? {};
            if (typeof u.input_tokens === "number") usage.prompt_tokens = u.input_tokens;
            // Send role chunk
            openaiSseSend(ctrl, {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: baseModel,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            });
          } else if (t === "message_stop") {
            openaiSseDone(ctrl);
            ctrl.close();
            return;
          }
        }
        // End without explicit message_stop
        openaiSseDone(ctrl);
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
}
