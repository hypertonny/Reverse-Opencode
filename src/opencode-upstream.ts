import { spawn, type ChildProcess } from "node:child_process";
import { OPENCODE_SERVER_URL, FREE_MODELS, updateFreeModels } from "./config.ts";

let serverProcess: ChildProcess | null = null;
let serverReady = false;

/** Check if the upstream OpenCode server is healthy */
export async function isOpenCodeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${OPENCODE_SERVER_URL}/global/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.healthy === true;
  } catch {
    return false;
  }
}

/** Ensure OpenCode server is running; launch it if not already running */
export async function ensureOpenCodeServer(): Promise<boolean> {
  if (await isOpenCodeHealthy()) {
    serverReady = true;
    return true;
  }

  // Try to spawn opencode serve
  try {
    const port = new URL(OPENCODE_SERVER_URL).port || "4096";
    console.log(`[upstream] OpenCode server not detected at ${OPENCODE_SERVER_URL}. Launching opencode serve --port ${port}...`);
    
    serverProcess = spawn("opencode", ["serve", "--port", port], {
      stdio: "pipe",
      shell: true,
      detached: false,
    });

    serverProcess.stderr?.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[opencode-serve stderr] ${msg}`);
    });

    // Poll until healthy (up to 15s)
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 800));
      if (await isOpenCodeHealthy()) {
        console.log(`[upstream] OpenCode server successfully connected at ${OPENCODE_SERVER_URL}`);
        serverReady = true;
        return true;
      }
    }
  } catch (err: any) {
    console.error(`[upstream] Failed to launch opencode serve: ${err?.message ?? err}`);
  }

  return false;
}

/** Fetch available free models dynamically from OpenCode server */
export async function discoverOpenCodeModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OPENCODE_SERVER_URL}/config/providers`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [...FREE_MODELS];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return [...FREE_MODELS];

    const freeModels: string[] = [];
    const modelsForConfig: any[] = [];

    for (const provider of data) {
      if (provider.id !== "opencode" && provider.id !== "opencode-ai") continue;
      if (!provider.models) continue;

      for (const [modelId, modelDef] of Object.entries<any>(provider.models)) {
        const id = modelDef.id ?? modelId;
        modelsForConfig.push({ id, owned_by: "opencode", created: Math.floor(Date.now() / 1000) });
        // Free models have 0 input/output cost or explicit free suffix
        const isFree = (modelDef.cost?.input === 0 && modelDef.cost?.output === 0) ||
                       id.endsWith("-free") || id.endsWith("-contributor-free") ||
                       id === "big-pickle";
        if (isFree) {
          freeModels.push(id);
        }
      }
    }

    if (freeModels.length > 0) {
      updateFreeModels(modelsForConfig);
      return freeModels;
    }
  } catch (err: any) {
    console.log(`[upstream] Model discovery error: ${err?.message ?? err}`);
  }
  return [...FREE_MODELS];
}

export type OpenCodeResult = {
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: any }>;
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: "stop" | "tool_calls" | "length";
};

/** Create an ephemeral session in OpenCode */
export async function createSession(title?: string): Promise<string> {
  const res = await fetch(`${OPENCODE_SERVER_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? `proxy-${Date.now()}` }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenCode create session failed (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.id;
}

/** Delete an ephemeral session in OpenCode */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}`, { method: "DELETE" });
  } catch {}
}

/** Helper to extract plain text from any content block or array */
export function stringifyContent(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content.map(stringifyContentItem).filter(Boolean).join("\n");
  }
  return stringifyContentItem(content);
}

function stringifyContentItem(c: any): string {
  if (typeof c === "string") return c;
  if (!c || typeof c !== "object") return "";
  if (c.type === "text" || !c.type) return c.text ?? "";
  if (c.type === "tool_use") {
    const inputStr = typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {});
    return `[Tool Call: ${c.name} (id: ${c.id ?? "call"})]\nArguments: ${inputStr}`;
  }
  if (c.type === "tool_result") {
    const out = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
    return `[Tool Result for ${c.tool_use_id ?? "call"}${c.is_error ? " (Error)" : ""}]:\n${out}`;
  }
  if (c.type === "image") {
    return "[Image]";
  }
  return c.text ? String(c.text) : JSON.stringify(c);
}

/** Extract full system prompt from string or Anthropic content block array */
export function extractSystemPrompt(raw: any): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && item.text) return item.text;
        return "";
      })
      .filter(Boolean);
    return parts.join("\n\n").trim() || undefined;
  }
  return undefined;
}

/** Convert incoming messages into OpenCode parts & system prompt */
export function normalizeMessages(messages: any[]): {
  systemPrompt: string | undefined;
  historyMessages: Array<{ role: "user" | "assistant"; text: string }>;
  currentMessage: { text: string; parts?: any[] };
} {
  let systemPrompt: string | undefined = undefined;
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      const text = stringifyContent(m.content);
      if (text) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      }
      continue;
    }

    const text = stringifyContent(m.content);

    if (i === messages.length - 1 && m.role === "user") {
      return {
        systemPrompt,
        historyMessages: history,
        currentMessage: { text },
      };
    } else {
      history.push({ role: m.role === "assistant" ? "assistant" : "user", text });
    }
  }

  // Fallback if last message wasn't user
  const last = history.pop() ?? { role: "user", text: "" };
  return {
    systemPrompt,
    historyMessages: history,
    currentMessage: { text: last.text },
  };
}

/** Execute a non-streaming turn against OpenCode server */
export async function executeOpenCodeNonStreaming(params: {
  model: string;
  messages: any[];
  system?: string;
  timeoutMs?: number;
}): Promise<OpenCodeResult> {
  const sessionId = await createSession();

  try {
    const { systemPrompt: msgSys, historyMessages, currentMessage } = normalizeMessages(params.messages);
    const system = [params.system, msgSys].filter(Boolean).join("\n\n") || undefined;

    // Send history turns with noReply: true
    for (const h of historyMessages) {
      await fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: h.text }],
          noReply: true,
        }),
      });
    }

    // Send active message using native explore agent (no OpenCode persona injection)
    const promptText = system
      ? `[System Instructions]\n${system}\n\n${currentMessage.text}`
      : currentMessage.text;

    const payload: any = {
      agent: "explore",
      model: { providerID: "opencode", modelID: params.model },
      parts: [{ type: "text", text: promptText }],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 180000);

    const res = await fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenCode message failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    let text = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; name: string; arguments: any }> = [];

    if (Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (part.type === "text" && part.text) {
          text += part.text;
        } else if (part.type === "reasoning" && part.text) {
          reasoning += part.text;
        } else if (part.type === "tool" || part.type === "tool-call") {
          toolCalls.push({
            id: part.id ?? `call_${Date.now()}`,
            name: part.name ?? part.tool ?? "tool",
            arguments: part.args ?? part.input ?? {},
          });
        }
      }
    }

    const tokens = data.info?.tokens ?? {};
    const input_tokens = tokens.input ?? Math.ceil(currentMessage.text.length / 4);
    const output_tokens = tokens.output ?? Math.ceil(text.length / 4);
    const finish_reason = toolCalls.length > 0 ? "tool_calls" : "stop";

    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: { input_tokens, output_tokens },
      finish_reason,
    };
  } finally {
    // Ephemeral session cleanup
    deleteSession(sessionId).catch(() => {});
  }
}

/** Execute a streaming turn against OpenCode server */
export async function executeOpenCodeStreaming(params: {
  model: string;
  messages: any[];
  system?: string;
  onDelta: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  timeoutMs?: number;
}): Promise<OpenCodeResult> {
  const sessionId = await createSession();

  try {
    const { systemPrompt: msgSys, historyMessages, currentMessage } = normalizeMessages(params.messages);
    const system = [params.system, msgSys].filter(Boolean).join("\n\n") || undefined;

    // Send history turns with noReply: true
    for (const h of historyMessages) {
      await fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: h.text }],
          noReply: true,
        }),
      });
    }

    // Connect to global SSE stream before dispatching prompt
    const eventRes = await fetch(`${OPENCODE_SERVER_URL}/global/event`);
    if (!eventRes.ok || !eventRes.body) {
      throw new Error(`Failed to connect to OpenCode event stream (${eventRes.status})`);
    }

    const reader = eventRes.body.getReader();
    const decoder = new TextDecoder();
    let streamClosed = false;
    let accumulatedText = "";
    let accumulatedReasoning = "";

    // Event reader loop
    const eventLoopPromise = (async () => {
      let buffer = "";
      while (!streamClosed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            const props = ev.payload?.properties;
            if (props?.sessionID !== sessionId) continue;

            if (ev.payload?.type === "message.part.delta") {
              if (props?.field === "text" && props?.delta) {
                accumulatedText += props.delta;
                params.onDelta(props.delta);
              } else if (props?.field === "reasoning" && props?.delta) {
                accumulatedReasoning += props.delta;
                params.onReasoningDelta?.(props.delta);
              }
            }
          } catch {}
        }
      }
    })();

    // Dispatch prompt using native explore agent (no OpenCode persona injection)
    const promptText = system
      ? `[System Instructions]\n${system}\n\n${currentMessage.text}`
      : currentMessage.text;

    const payload: any = {
      agent: "explore",
      model: { providerID: "opencode", modelID: params.model },
      parts: [{ type: "text", text: promptText }],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 180000);

    const postPromise = fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const res = await postPromise;
    clearTimeout(timeout);

    // Stop SSE reader
    streamClosed = true;
    reader.cancel().catch(() => {});
    await eventLoopPromise.catch(() => {});

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenCode message failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    let finalText = accumulatedText;

    // Fallback if streaming deltas missed text
    if (!finalText && Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (part.type === "text" && part.text) {
          finalText += part.text;
          params.onDelta(part.text);
        }
      }
    }

    const toolCalls: Array<{ id: string; name: string; arguments: any }> = [];
    if (Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (part.type === "tool" || part.type === "tool-call") {
          toolCalls.push({
            id: part.id ?? `call_${Date.now()}`,
            name: part.name ?? part.tool ?? "tool",
            arguments: part.args ?? part.input ?? {},
          });
        }
      }
    }

    const tokens = data.info?.tokens ?? {};
    const input_tokens = tokens.input ?? Math.ceil(currentMessage.text.length / 4);
    const output_tokens = tokens.output ?? Math.ceil(finalText.length / 4);

    return {
      text: finalText,
      reasoning: accumulatedReasoning || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: { input_tokens, output_tokens },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  } finally {
    deleteSession(sessionId).catch(() => {});
  }
}
