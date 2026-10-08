import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  parseModel, PORT, PROXY_API_KEY, FREE_ONLY, isFreeModel,
  validateEffort, MAX_BODY_BYTES, RATE_LIMIT_RPM, MAX_CONCURRENT, FREE_ENFORCED, ALLOW_PAID,
  getFreeModels, getAllUpstreamModels, updateFreeModels, shouldRefreshModels,
  resolveUpstreamModel,
} from "./config.ts";
import {
  estimateTokens, newAnthropicId,
} from "./translate.ts";
import {
  openaiError, anthropicError,
} from "./upstream.ts";
import {
  ensureOpenCodeServer, discoverOpenCodeModels,
  executeOpenCodeNonStreaming, executeOpenCodeStreaming, isOpenCodeHealthy,
  extractSystemPrompt,
} from "./opencode-upstream.ts";
import { logRequest, usageCost } from "./logging.ts";

const app = new Hono();
const startedAt = Date.now();

// ---------- in-memory observability ----------
type Agg = { requests: number; input_tokens: number; output_tokens: number; cost_usd: number; errors: number };
const metrics = {
  totals: { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, errors: 0 } as Agg,
  byModel: {} as Record<string, Agg>,
  byKey: {} as Record<string, Agg>,
  streamZeroUsage: 0,
};

function record(model: string, inTok: number, outTok: number, cost: number, isErr: boolean, streamNoUsage: boolean, apiKey?: string) {
  const t = metrics.totals;
  t.requests += 1; t.input_tokens += inTok; t.output_tokens += outTok; t.cost_usd += cost;
  if (isErr) t.errors += 1;
  const m = (metrics.byModel[model] ??= { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, errors: 0 });
  m.requests += 1; m.input_tokens += inTok; m.output_tokens += outTok; m.cost_usd += cost;
  if (isErr) m.errors += 1;
  if (streamNoUsage) metrics.streamZeroUsage += 1;
  if (apiKey) {
    const keyId = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "***";
    const k = (metrics.byKey[keyId] ??= { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, errors: 0 });
    k.requests += 1; k.input_tokens += inTok; k.output_tokens += outTok; k.cost_usd += cost;
    if (isErr) k.errors += 1;
  }
}

// ---------- rate limiting (fixed window + concurrency cap) ----------
let windowStart = Date.now();
let windowCount = 0;
let inFlight = 0;

function checkLimits(): { ok: true } | { ok: false; status: 429; retryAfter: number } {
  const now = Date.now();
  if (RATE_LIMIT_RPM > 0) {
    if (now - windowStart >= 60_000) { windowStart = now; windowCount = 0; }
    if (windowCount >= RATE_LIMIT_RPM) {
      return { ok: false, status: 429, retryAfter: Math.ceil((60_000 - (now - windowStart)) / 1000) };
    }
    windowCount += 1;
  }
  if (MAX_CONCURRENT > 0 && inFlight >= MAX_CONCURRENT) {
    return { ok: false, status: 429, retryAfter: 5 };
  }
  return { ok: true };
}

function extractApiKey(c: any): string | undefined {
  const key = c.req.header("x-api-key") ?? c.req.header("X-Api-Key");
  if (key) return key;
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

function authed(c: any): boolean {
  if (!PROXY_API_KEY) return true;
  const key = extractApiKey(c);
  return key === PROXY_API_KEY;
}

async function readBody(c: any): Promise<{ ok: true; json: any } | { ok: false; status: number; message: string }> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, status: 400, message: "could not read request body" };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, message: `request body too large (${text.length} > ${MAX_BODY_BYTES} bytes)` };
  }
  if (!text.trim()) return { ok: true, json: null };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, message: "invalid JSON body" };
  }
}

// ---------- dynamic model discovery ----------
async function refreshModelsIfNeeded() {
  if (!shouldRefreshModels()) return;
  try {
    await discoverOpenCodeModels();
  } catch (e: any) {
    console.log(`[models] refresh failed: ${e?.message ?? e}`);
  }
}

// Ensure OpenCode server and load initial models
ensureOpenCodeServer().then(() => discoverOpenCodeModels()).catch(() => {});

// ---------- health & metrics ----------

app.get("/health", async (c) => {
  const upstreamHealthy = await isOpenCodeHealthy();
  return c.json({
    ok: true,
    upstream: upstreamHealthy ? "connected" : "starting/disconnected",
    mode: FREE_ONLY ? "free-keyless" : "keyed",
    paid_models: ALLOW_PAID ? "allowed" : "blocked (free-only)",
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    limits: { rate_limit_rpm: RATE_LIMIT_RPM, max_concurrent: MAX_CONCURRENT, max_body_bytes: MAX_BODY_BYTES, in_flight: inFlight },
    free_models: [...getFreeModels()],
  });
});

app.get("/metrics/json", (c) => {
  if (!authed(c)) return c.json({ error: { type: "authentication_error", message: "invalid proxy key" } }, 401);
  return c.json({ uptime_s: Math.floor((Date.now() - startedAt) / 1000), ...metrics });
});

app.get("/metrics", (c) => {
  if (!authed(c)) return c.text("# Unauthorized\n", 401);
  const lines: string[] = [];
  const up = Math.floor((Date.now() - startedAt) / 1000);
  lines.push("# HELP opencode_proxy_uptime_seconds Proxy uptime in seconds");
  lines.push("# TYPE opencode_proxy_uptime_seconds gauge");
  lines.push(`opencode_proxy_uptime_seconds ${up}`);

  lines.push("# HELP opencode_proxy_requests_total Total requests");
  lines.push("# TYPE opencode_proxy_requests_total counter");
  lines.push(`opencode_proxy_requests_total ${metrics.totals.requests}`);

  lines.push("# HELP opencode_proxy_errors_total Total error responses");
  lines.push("# TYPE opencode_proxy_errors_total counter");
  lines.push(`opencode_proxy_errors_total ${metrics.totals.errors}`);

  lines.push("# HELP opencode_proxy_input_tokens_total Total input tokens");
  lines.push("# TYPE opencode_proxy_input_tokens_total counter");
  lines.push(`opencode_proxy_input_tokens_total ${metrics.totals.input_tokens}`);

  lines.push("# HELP opencode_proxy_output_tokens_total Total output tokens");
  lines.push("# TYPE opencode_proxy_output_tokens_total counter");
  lines.push(`opencode_proxy_output_tokens_total ${metrics.totals.output_tokens}`);

  lines.push("# HELP opencode_proxy_cost_usd_total Total estimated cost in USD");
  lines.push("# TYPE opencode_proxy_cost_usd_total counter");
  lines.push(`opencode_proxy_cost_usd_total ${metrics.totals.cost_usd.toFixed(6)}`);

  lines.push("# HELP opencode_proxy_in_flight Current in-flight requests");
  lines.push("# TYPE opencode_proxy_in_flight gauge");
  lines.push(`opencode_proxy_in_flight ${inFlight}`);

  lines.push("# HELP opencode_proxy_stream_zero_usage Streams that ended without usage data");
  lines.push("# TYPE opencode_proxy_stream_zero_usage counter");
  lines.push(`opencode_proxy_stream_zero_usage ${metrics.streamZeroUsage}`);

  lines.push("# HELP opencode_proxy_model_requests_total Requests per model");
  lines.push("# TYPE opencode_proxy_model_requests_total counter");
  for (const [model, agg] of Object.entries(metrics.byModel)) {
    lines.push(`opencode_proxy_model_requests_total{model="${model}"} ${agg.requests}`);
  }

  lines.push("# HELP opencode_proxy_model_input_tokens_total Input tokens per model");
  lines.push("# TYPE opencode_proxy_model_input_tokens_total counter");
  for (const [model, agg] of Object.entries(metrics.byModel)) {
    lines.push(`opencode_proxy_model_input_tokens_total{model="${model}"} ${agg.input_tokens}`);
  }

  lines.push("# HELP opencode_proxy_model_output_tokens_total Output tokens per model");
  lines.push("# TYPE opencode_proxy_model_output_tokens_total counter");
  for (const [model, agg] of Object.entries(metrics.byModel)) {
    lines.push(`opencode_proxy_model_output_tokens_total{model="${model}"} ${agg.output_tokens}`);
  }

  lines.push("# HELP opencode_proxy_model_cost_usd_total Cost per model in USD");
  lines.push("# TYPE opencode_proxy_model_cost_usd_total counter");
  for (const [model, agg] of Object.entries(metrics.byModel)) {
    lines.push(`opencode_proxy_model_cost_usd_total{model="${model}"} ${agg.cost_usd.toFixed(6)}`);
  }

  lines.push("# HELP opencode_proxy_model_errors_total Errors per model");
  lines.push("# TYPE opencode_proxy_model_errors_total counter");
  for (const [model, agg] of Object.entries(metrics.byModel)) {
    lines.push(`opencode_proxy_model_errors_total{model="${model}"} ${agg.errors}`);
  }

  c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return c.text(lines.join("\n") + "\n");
});

app.get("/usage", (c) => {
  if (!authed(c)) return c.json({ error: { type: "authentication_error", message: "invalid proxy key" } }, 401);
  return c.json({
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    totals: metrics.totals,
    by_model: metrics.byModel,
    by_key: metrics.byKey,
  });
});

// ---------- model list (both OpenAI + Anthropic compatible) ----------

app.get("/v1/models", async (c) => {
  if (!authed(c)) return c.json({ error: { type: "authentication_error", message: "invalid proxy key" } }, 401);
  try {
    await refreshModelsIfNeeded();
    const upstreamModels = getAllUpstreamModels();
    const all = upstreamModels.length > 0
      ? upstreamModels.map((m: any) => ({
        id: m.id,
        object: "model",
        created: m.created ?? Math.floor(Date.now() / 1000),
        owned_by: m.owned_by ?? "opencode",
      }))
      : [...getFreeModels()].map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "opencode",
      }));
    const data = FREE_ENFORCED ? all.filter((m: any) => isFreeModel(m.id)) : all;
    return c.json({ object: "list", data });
  } catch (e: any) {
    const ids = [...getFreeModels()];
    return c.json({
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode" })),
      fallback: true,
    });
  }
});

// ---------- Anthropic-compatible endpoint ----------

app.post("/v1/messages/count_tokens", async (c) => {
  if (!authed(c)) return c.json(anthropicError("authentication_error", "invalid proxy key"), 401);
  const parsed = await readBody(c);
  if (!parsed.ok) return c.json(anthropicError("invalid_request_error", parsed.message), parsed.status as any);
  try {
    c.header("anthropic-version", "2023-06-01");
    return c.json({ input_tokens: estimateTokens(parsed.json ?? {}) });
  } catch (e: any) {
    return c.json(anthropicError("invalid_request_error", `could not estimate tokens: ${String(e?.message ?? e)}`), 400);
  }
});

app.post("/v1/messages", async (c) => {
  if (!authed(c)) return c.json(anthropicError("authentication_error", "invalid proxy key"), 401);
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  const apiKey = extractApiKey(c);
  const t0 = Date.now();

  const finish = (args: {
    clientModel: string; upstreamModel: string; kind: string; effort?: string; stream: boolean;
    inTok: number; outTok: number; status: number; upstreamStatus?: number;
    upstreamErrorType?: string; error?: string; streamNoUsage?: boolean;
  }) => {
    const { cost, unknown } = usageCost(args.upstreamModel, args.inTok, args.outTok);
    const isErr = args.status >= 400;
    record(args.upstreamModel, args.inTok, args.outTok, cost, isErr, !!args.streamNoUsage, apiKey);
    logRequest({
      ts: new Date().toISOString(),
      request_id: requestId,
      client_model: args.clientModel,
      upstream_model: args.upstreamModel,
      upstream_kind: args.kind,
      effort: args.effort,
      stream: args.stream,
      input_tokens: args.inTok,
      output_tokens: args.outTok,
      cost_usd: cost,
      cost_unknown: unknown || undefined,
      duration_ms: Date.now() - t0,
      status: args.status,
      upstream_status: args.upstreamStatus,
      upstream_error_type: args.upstreamErrorType,
      error: args.error,
    });
  };

  const parsed = await readBody(c);
  if (!parsed.ok) {
    finish({ clientModel: "?", upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: parsed.status, error: parsed.message });
    return c.json(anthropicError("invalid_request_error", parsed.message), parsed.status as any);
  }
  const req = parsed.json;
  if (!req || typeof req.model !== "string" || !req.model) {
    finish({ clientModel: "?", upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: "model required" });
    return c.json(anthropicError("invalid_request_error", "model is required"), 400);
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    finish({ clientModel: String(req.model), upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: "messages[] required" });
    return c.json(anthropicError("invalid_request_error", "messages[] must be a non-empty array"), 400);
  }
  if (req.max_tokens === undefined || req.max_tokens === null) {
    finish({ clientModel: String(req.model), upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: "max_tokens required" });
    return c.json(anthropicError("invalid_request_error", "max_tokens is required"), 400);
  }

  const clientModel = String(req.model);
  const { base, effort: rawEffort } = parseModel(clientModel);
  const upstreamBase = resolveUpstreamModel(base);
  let effort: string | undefined;
  try {
    effort = validateEffort(rawEffort ?? process.env.DEFAULT_EFFORT);
  } catch (e: any) {
    finish({ clientModel, upstreamModel: upstreamBase, kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: String(e.message) });
    return c.json(anthropicError("invalid_request_error", String(e.message)), 400);
  }

  if (FREE_ENFORCED && !isFreeModel(base)) {
    const msg = `only free models allowed (${[...getFreeModels()].join(", ")}). Set ALLOW_PAID_MODELS=true to unlock paid models.`;
    finish({ clientModel, upstreamModel: upstreamBase, kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 403, error: msg });
    return c.json(anthropicError("invalid_request_error", msg), 403);
  }

  const systemPrompt = extractSystemPrompt(req.system);
  const stream = !!req.stream;
  const gate = checkLimits();
  if (!gate.ok) {
    finish({ clientModel, upstreamModel: upstreamBase, kind: "opencode", effort, stream, inTok: 0, outTok: 0, status: 429, error: "proxy rate limit" });
    c.header("Retry-After", String(gate.retryAfter));
    return c.json(anthropicError("rate_limit_error", `proxy rate limit exceeded, retry in ${gate.retryAfter}s`), 429);
  }
  inFlight += 1;

  try {
    if (!stream) {
      const result = await executeOpenCodeNonStreaming({
        model: upstreamBase,
        messages: req.messages,
        system: systemPrompt,
      });

      inFlight -= 1;
      const { cost, unknown } = usageCost(upstreamBase, result.usage.input_tokens, result.usage.output_tokens);
      record(upstreamBase, result.usage.input_tokens, result.usage.output_tokens, cost, false, false, apiKey);
      logRequest({
        ts: new Date().toISOString(),
        request_id: requestId,
        client_model: clientModel,
        upstream_model: upstreamBase,
        upstream_kind: "opencode-server",
        effort,
        stream: false,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd: cost,
        cost_unknown: unknown || undefined,
        duration_ms: Date.now() - t0,
        status: 200,
      });

      const content: any[] = [];
      if (result.text) {
        content.push({ type: "text", text: result.text });
      }
      if (Array.isArray(result.toolCalls)) {
        for (const tc of result.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }

      const hasTools = !!(result.toolCalls && result.toolCalls.length > 0);

      const anthropicMsg = {
        id: newAnthropicId(),
        type: "message",
        role: "assistant",
        model: clientModel,
        content,
        stop_reason: hasTools ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
      c.header("anthropic-version", "2023-06-01");
      return c.json(anthropicMsg);
    }

    // Anthropic SSE Streaming
    const msgId = newAnthropicId();
    const encoder = new TextEncoder();

    const responseStream = new ReadableStream({
      async start(controller) {
        try {
          let closed = false;
          const safeEnqueue = (data: Uint8Array) => {
            if (!closed) {
              try { controller.enqueue(data); } catch { closed = true; }
            }
          };
          const safeClose = () => {
            if (!closed) {
              closed = true;
              try { controller.close(); } catch {}
            }
          };
          const safeError = (err: any) => {
            if (!closed) {
              closed = true;
              try { controller.error(err); } catch {}
            }
          };

          // 1. message_start
          safeEnqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: clientModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          })}\n\n`));

          let blockIdx = 0;
          let textStarted = false;

          // 2. stream content deltas
          const result = await executeOpenCodeStreaming({
            model: upstreamBase,
            messages: req.messages,
            system: systemPrompt,
            onDelta: (textChunk) => {
              if (!textStarted) {
                textStarted = true;
                safeEnqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: blockIdx,
                  content_block: { type: "text", text: "" },
                })}\n\n`));
              }
              safeEnqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "text_delta", text: textChunk },
              })}\n\n`));
            },
          });

          // Close text block if opened
          if (textStarted) {
            safeEnqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: blockIdx,
            })}\n\n`));
            blockIdx += 1;
          }

          // Emit tool_use blocks if upstream produced tool calls
          if (Array.isArray(result.toolCalls)) {
            for (const tc of result.toolCalls) {
              safeEnqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIdx,
                content_block: { type: "tool_use", id: tc.id, name: tc.name },
              })}\n\n`));

              const inputStr = JSON.stringify(tc.arguments ?? {});
              safeEnqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "input_json_delta", partial_json: inputStr },
              })}\n\n`));

              safeEnqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: blockIdx,
              })}\n\n`));
              blockIdx += 1;
            }
          }

          const hasTools = !!(result.toolCalls && result.toolCalls.length > 0);

          // 3. message_delta
          safeEnqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: hasTools ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: result.usage.output_tokens },
          })}\n\n`));

          // 4. message_stop
          safeEnqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`));

          safeClose();

          inFlight -= 1;
          const { cost, unknown } = usageCost(upstreamBase, result.usage.input_tokens, result.usage.output_tokens);
          record(upstreamBase, result.usage.input_tokens, result.usage.output_tokens, cost, false, false, apiKey);
          logRequest({
            ts: new Date().toISOString(),
            request_id: requestId,
            client_model: clientModel,
            upstream_model: upstreamBase,
            upstream_kind: "opencode-server",
            effort,
            stream: true,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cost_usd: cost,
            cost_unknown: unknown || undefined,
            duration_ms: Date.now() - t0,
            status: 200,
          });
        } catch (err: any) {
          inFlight -= 1;
          if (!closed) {
            try { controller.error(err); } catch {}
          }
          finish({
            clientModel,
            upstreamModel: upstreamBase,
            kind: "opencode-server",
            effort,
            stream: true,
            inTok: 0,
            outTok: 0,
            status: 500,
            error: err?.message,
          });
        }
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (err: any) {
    inFlight -= 1;
    finish({
      clientModel: String(req.model),
      upstreamModel: base,
      kind: "opencode-server",
      effort,
      stream,
      inTok: 0,
      outTok: 0,
      status: 502,
      error: err?.message,
    });
    return c.json(anthropicError("api_error", `upstream OpenCode error: ${err?.message ?? err}`), 502);
  }
});

// ---------- OpenAI-compatible endpoint ----------

app.post("/v1/chat/completions", async (c) => {
  if (!authed(c)) return c.json(openaiError(401, "invalid_request_error", "invalid proxy key", "invalid_api_key"), 401);
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  const apiKey = extractApiKey(c);
  const t0 = Date.now();

  const finish = (args: {
    clientModel: string; upstreamModel: string; kind: string; effort?: string; stream: boolean;
    inTok: number; outTok: number; status: number; upstreamStatus?: number;
    error?: string;
  }) => {
    const { cost, unknown } = usageCost(args.upstreamModel, args.inTok, args.outTok);
    const isErr = args.status >= 400;
    record(args.upstreamModel, args.inTok, args.outTok, cost, isErr, false, apiKey);
    logRequest({
      ts: new Date().toISOString(),
      request_id: requestId,
      client_model: args.clientModel,
      upstream_model: args.upstreamModel,
      upstream_kind: args.kind,
      effort: args.effort,
      stream: args.stream,
      input_tokens: args.inTok,
      output_tokens: args.outTok,
      cost_usd: cost,
      cost_unknown: unknown || undefined,
      duration_ms: Date.now() - t0,
      status: args.status,
      upstream_status: args.upstreamStatus,
      error: args.error,
    });
  };

  const parsed = await readBody(c);
  if (!parsed.ok) {
    finish({ clientModel: "?", upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: parsed.status, error: parsed.message });
    return c.json(openaiError(parsed.status, "invalid_request_error", parsed.message), parsed.status as any);
  }
  const req = parsed.json;
  if (!req || typeof req.model !== "string" || !req.model) {
    finish({ clientModel: "?", upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: "model required" });
    return c.json(openaiError(400, "invalid_request_error", "model is required"), 400);
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    finish({ clientModel: String(req.model), upstreamModel: "?", kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: "messages[] required" });
    return c.json(openaiError(400, "invalid_request_error", "messages[] must be a non-empty array"), 400);
  }

  const { base, effort: rawEffort } = parseModel(String(req.model));
  let effort: string | undefined;
  try {
    effort = validateEffort(rawEffort ?? process.env.DEFAULT_EFFORT);
  } catch (e: any) {
    finish({ clientModel: String(req.model), upstreamModel: base, kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 400, error: String(e.message) });
    return c.json(openaiError(400, "invalid_request_error", String(e.message)), 400);
  }

  if (FREE_ENFORCED && !isFreeModel(base)) {
    const msg = `only free models allowed (${[...getFreeModels()].join(", ")}). Set ALLOW_PAID_MODELS=true to unlock paid models.`;
    finish({ clientModel: String(req.model), upstreamModel: base, kind: "opencode", stream: false, inTok: 0, outTok: 0, status: 403, error: msg });
    return c.json(openaiError(403, "invalid_request_error", msg, "model_not_allowed"), 403);
  }

  const stream = !!req.stream;
  const gate = checkLimits();
  if (!gate.ok) {
    finish({ clientModel: String(req.model), upstreamModel: base, kind: "opencode", effort, stream, inTok: 0, outTok: 0, status: 429, error: "proxy rate limit" });
    c.header("Retry-After", String(gate.retryAfter));
    return c.json(openaiError(429, "tokens", `proxy rate limit exceeded, retry in ${gate.retryAfter}s`, "rate_limit_exceeded"), 429);
  }
  inFlight += 1;

  try {
    if (!stream) {
      const result = await executeOpenCodeNonStreaming({
        model: base,
        messages: req.messages,
        system: typeof req.system === "string" ? req.system : undefined,
      });

      inFlight -= 1;
      const { cost, unknown } = usageCost(base, result.usage.input_tokens, result.usage.output_tokens);
      record(base, result.usage.input_tokens, result.usage.output_tokens, cost, false, false, apiKey);
      logRequest({
        ts: new Date().toISOString(),
        request_id: requestId,
        client_model: String(req.model),
        upstream_model: base,
        upstream_kind: "opencode-server",
        effort,
        stream: false,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd: cost,
        cost_unknown: unknown || undefined,
        duration_ms: Date.now() - t0,
        status: 200,
      });

      const messageObj: any = {
        role: "assistant",
        content: result.text,
      };
      if (result.toolCalls && result.toolCalls.length > 0) {
        messageObj.tool_calls = result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      const openaiRes = {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: base,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: result.finish_reason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
          total_tokens: result.usage.input_tokens + result.usage.output_tokens,
        },
      };
      return c.json(openaiRes);
    }

    // OpenAI SSE Streaming
    const chatId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();

    const responseStream = new ReadableStream({
      async start(controller) {
        try {
          // Initial role delta
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })}\n\n`));

          const result = await executeOpenCodeStreaming({
            model: base,
            messages: req.messages,
            system: typeof req.system === "string" ? req.system : undefined,
            onDelta: (chunk) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: base,
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
              })}\n\n`));
            },
            onReasoningDelta: (chunk) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: chatId,
                object: "chat.completion.chunk",
                created,
                model: base,
                choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
              })}\n\n`));
            },
          });

          // Final finish_reason chunk
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: base,
            choices: [{ index: 0, delta: {}, finish_reason: result.finish_reason }],
            usage: {
              prompt_tokens: result.usage.input_tokens,
              completion_tokens: result.usage.output_tokens,
              total_tokens: result.usage.input_tokens + result.usage.output_tokens,
            },
          })}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();

          inFlight -= 1;
          const { cost, unknown } = usageCost(base, result.usage.input_tokens, result.usage.output_tokens);
          record(base, result.usage.input_tokens, result.usage.output_tokens, cost, false, false, apiKey);
          logRequest({
            ts: new Date().toISOString(),
            request_id: requestId,
            client_model: String(req.model),
            upstream_model: base,
            upstream_kind: "opencode-server",
            effort,
            stream: true,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cost_usd: cost,
            cost_unknown: unknown || undefined,
            duration_ms: Date.now() - t0,
            status: 200,
          });
        } catch (err: any) {
          inFlight -= 1;
          controller.error(err);
          finish({
            clientModel: String(req.model),
            upstreamModel: base,
            kind: "opencode-server",
            effort,
            stream: true,
            inTok: 0,
            outTok: 0,
            status: 500,
            error: err?.message,
          });
        }
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
      },
    });
  } catch (err: any) {
    inFlight -= 1;
    finish({
      clientModel: String(req.model),
      upstreamModel: base,
      kind: "opencode-server",
      effort,
      stream,
      inTok: 0,
      outTok: 0,
      status: 502,
      error: err?.message,
    });
    return c.json(openaiError(502, "server_error", `upstream OpenCode error: ${err?.message ?? err}`), 502);
  }
});

// ---------- start proxy server ----------

console.log(`opencode-zen-proxy listening on http://127.0.0.1:${PORT}`);
console.log(`mode: ${FREE_ONLY ? "free-keyless" : "keyed"} | proxy auth: ${PROXY_API_KEY ? "enabled" : "disabled (open)"} | rate: ${RATE_LIMIT_RPM}/min max-conc: ${MAX_CONCURRENT}`);
console.log(`API endpoints:
  Anthropic: POST /v1/messages (streaming SSE)
  OpenAI:    POST /v1/chat/completions (SSE streaming)
  Models:    GET  /v1/models
  Health:    GET  /health
  Metrics:   GET  /metrics (Prometheus) | GET /metrics/json
  Usage:     GET  /usage`);

export default {
  port: PORT,
  fetch: app.fetch,
};
