import { describe, expect, test } from "bun:test";

const BASE_URL = "http://127.0.0.1:3005";

describe("OpenCode Proxy Gateway Tests", () => {
  test("GET /health returns healthy status and free models", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.upstream).toBe("connected");
    expect(Array.isArray(data.free_models)).toBe(true);
    expect(data.free_models).toContain("muse-spark-1.3-contributor-free");
  }, { timeout: 10000 });

  test("GET /v1/models returns OpenAI model list", async () => {
    const res = await fetch(`${BASE_URL}/v1/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe("list");
    expect(Array.isArray(data.data)).toBe(true);
    const modelIds = data.data.map((m: any) => m.id);
    expect(modelIds).toContain("muse-spark-1.3-contributor-free");
  }, { timeout: 10000 });

  test("POST /v1/chat/completions non-streaming returns valid OpenAI completion", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        messages: [{ role: "user", content: "Say 'TEST_OK' and nothing else." }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe("chat.completion");
    expect(data.choices?.[0]?.message?.role).toBe("assistant");
    expect(data.choices?.[0]?.message?.content).toBeDefined();
    expect(data.usage?.prompt_tokens).toBeGreaterThan(0);
  }, { timeout: 30000 });

  test("POST /v1/chat/completions streaming returns valid OpenAI SSE events", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        messages: [{ role: "user", content: "Say 'STREAM_OK'." }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("[DONE]");
  }, { timeout: 30000 });

  test("POST /v1/messages non-streaming returns valid Anthropic message", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        max_tokens: 50,
        messages: [{ role: "user", content: "Say 'ANTHROPIC_OK'." }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe("message");
    expect(data.role).toBe("assistant");
    expect(data.content?.[0]?.type).toBe("text");
    expect(data.content?.[0]?.text).toBeDefined();
    expect(data.stop_reason).toBe("end_turn");
  }, { timeout: 30000 });

  test("POST /v1/messages streaming returns valid Anthropic SSE events", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        max_tokens: 50,
        messages: [{ role: "user", content: "Say 'ANTHROPIC_STREAM_OK'." }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
  }, { timeout: 30000 });

  test("Paid models are rejected with 403 on both endpoints", async () => {
    const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res1.status).toBe(403);
    const err1 = await res1.json();
    expect(err1.error?.code).toBe("model_not_allowed");

    const res2 = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "o1-preview",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res2.status).toBe(403);
    const err2 = await res2.json();
    expect(err2.error?.message).toContain("only free models allowed");
  }, { timeout: 10000 });

  test("Claude & Opus/Sonnet aliases are seamlessly accepted and mapped", async () => {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "opus 5.5",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say 'OPUS_ALIAS_TEST'." }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe("opus 5.5");
    expect(data.type).toBe("message");
    expect(data.usage?.cache_creation_input_tokens).toBe(0);
  }, { timeout: 30000 });

  test("GET /metrics returns Prometheus formatted metrics", async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("opencode_proxy_requests_total");
    expect(text).toContain("opencode_proxy_uptime_seconds");
  }, { timeout: 10000 });

  test("GET /usage returns JSON usage summary", async () => {
    const res = await fetch(`${BASE_URL}/usage`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totals).toBeDefined();
    expect(data.totals.requests).toBeGreaterThan(0);
  }, { timeout: 10000 });
});
