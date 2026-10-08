export const ZEN_BASE = process.env.ZEN_BASE_URL ?? "https://opencode.ai/zen/v1";
export const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
export const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY ?? "";
export const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
export const PORT = Number(process.env.PORT ?? 3000);
export const LOG_FILE = process.env.LOG_FILE ?? "./logs/requests.jsonl";
// Non-streaming upstream timeout (ms). Streams have no total timeout
// (chunks flow continuously); idle-socket protection is a future knob.
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 300_000);
// Max incoming JSON body (bytes). Protects against huge base64 payloads.
export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 25 * 1024 * 1024);
// Global fixed-window rate limit (requests/min, 0 = disabled).
export const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 240);
// Max concurrent upstream requests (0 = unlimited). Excess gets 429.
export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 16);
// Log rotation: when the JSONL file exceeds this, it is moved to .1 (0 = off).
export const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 50 * 1024 * 1024);

// Retry configuration for upstream errors (429, 5xx)
export const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 3);
export const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS ?? 1000);
export const RETRY_MAX_DELAY_MS = Number(process.env.RETRY_MAX_DELAY_MS ?? 30_000);

// Dynamic free model discovery interval (ms). 0 = disabled.
export const MODEL_REFRESH_INTERVAL_MS = Number(process.env.MODEL_REFRESH_INTERVAL_MS ?? 300_000); // 5 min

export type Effort = "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | string;

export function zenAuth(): Record<string, string> {
  return OPENCODE_API_KEY ? { Authorization: `Bearer ${OPENCODE_API_KEY}` } : {};
}

// Free models (keyless, $0). Jev excluded — SystemOne API, not chat.
const STATIC_FREE_MODELS = new Set([
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "big-pickle",
  "space-bunny-free",
  "longcat-2.5-preview-free",
  "exo-free",
  "fledge-alpha-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "ling-3.1-flash-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
]);

// Dynamic free model set — starts with static, updated periodically from upstream
let dynamicFreeModels: Set<string> = new Set(STATIC_FREE_MODELS);
let lastModelRefresh = 0;
let allUpstreamModels: any[] = [];

export function getFreeModels(): Set<string> {
  return dynamicFreeModels;
}

export function getAllUpstreamModels(): any[] {
  return allUpstreamModels;
}

export function updateFreeModels(upstreamModels: any[]) {
  allUpstreamModels = upstreamModels;
  const discovered = new Set(STATIC_FREE_MODELS);
  for (const m of upstreamModels) {
    const id = typeof m === "string" ? m : m?.id;
    if (!id) continue;
    // Auto-discover free models by suffix pattern
    if (id.endsWith("-free") || id.endsWith("-contributor-free")) {
      discovered.add(id.toLowerCase());
    }
  }
  dynamicFreeModels = discovered;
  lastModelRefresh = Date.now();
}

export function shouldRefreshModels(): boolean {
  if (MODEL_REFRESH_INTERVAL_MS <= 0) return false;
  return Date.now() - lastModelRefresh > MODEL_REFRESH_INTERVAL_MS;
}

// Kept for backwards compat — references current dynamic set
export const FREE_MODELS = STATIC_FREE_MODELS;

export const DEFAULT_FREE_MODEL = process.env.DEFAULT_FREE_MODEL ?? "muse-spark-1.3-contributor-free";

/** Check if a requested model name is an Anthropic / Claude / Opus / Sonnet alias */
export function isClaudeAlias(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("claude") ||
    m.includes("opus") ||
    m.includes("sonnet") ||
    m.includes("haiku")
  );
}

/** Resolve any requested client model (including aliases) to the actual upstream model */
export function resolveUpstreamModel(model: string): string {
  if (isClaudeAlias(model)) {
    return DEFAULT_FREE_MODEL;
  }
  return model;
}

export function isFreeModel(base: string): boolean {
  if (isClaudeAlias(base)) return true;
  return dynamicFreeModels.has(base.toLowerCase());
}

export const FREE_ONLY = !OPENCODE_API_KEY;

// Operator policy: only free models are served, regardless of whether a
// Console key is configured (the key is still needed — Zen rejects keyless
// free-tier calls — but paid models stay blocked). Set ALLOW_PAID_MODELS=true
// to unlock everything.
export const ALLOW_PAID = process.env.ALLOW_PAID_MODELS === "true";
export const FREE_ENFORCED = !ALLOW_PAID;

export const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "max", "xhigh"]);

export function validateEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if (!VALID_EFFORTS.has(e)) {
    throw new Error(`unknown effort "${effort}" (use model#effort with one of: ${[...VALID_EFFORTS].join(", ")})`);
  }
  return e;
}

export function parseModel(raw: string): { base: string; effort?: string } {
  const i = raw.indexOf("#");
  if (i === -1) {
    const envDefault = process.env.DEFAULT_EFFORT;
    return { base: raw, effort: envDefault || undefined };
  }
  const base = raw.slice(0, i);
  const effort = raw.slice(i + 1) || undefined;
  return { base, effort };
}

export type UpstreamKind = "chat" | "responses" | "messages";

export function routeUpstream(baseModel: string): UpstreamKind {
  const m = baseModel.toLowerCase();
  if (
    m.startsWith("claude-") ||
    m === "qwen3.8-flash" ||
    m.startsWith("qwen3.7-") ||
    m.startsWith("qwen3.6-") ||
    m.startsWith("qwen3.5-")
  ) return "messages";
  if (
    m.startsWith("muse-spark") ||
    m.startsWith("gpt-") ||
    m.startsWith("grok-")
  ) return "responses";
  return "chat";
}

// Pricing per 1M tokens (input, output) from Zen docs. Cached-token pricing
// is ignored (approximation — logged cost is a lower bound when caching applies).
const FREE = { in: 0, out: 0 };
export const PRICING: Record<string, { in: number; out: number }> = {
  // free tier
  "big-pickle": FREE,
  "space-bunny-free": FREE,
  "longcat-2.5-preview-free": FREE,
  "exo-free": FREE,
  "fledge-alpha-free": FREE,
  "mimo-v2.6-flash-free": FREE,
  "mimo-v2.5-free": FREE,
  "ling-3.1-flash-free": FREE,
  "ling-3.0-flash-fin-free": FREE,
  "nemotron-3-ultra-free": FREE,
  "nemotron-3.5-lightning-free": FREE,
  "muse-spark-1.3-contributor-free": FREE,
  "muse-spark-1.2-contributor-free": FREE,
  "jev-1.13-free": FREE,
  "step-5-preview-free": FREE,
  "jev-1.13": { in: 0.042, out: 0 },
  // muse / open models
  "muse-spark-1.3": { in: 1.25, out: 4.25 },
  "muse-spark-1.2": { in: 1.25, out: 4.25 },
  "kimi-k2.6": { in: 0.95, out: 4.0 },
  "kimi-k2.5": { in: 0.6, out: 3.0 },
  "kimi-k2.7-code": { in: 0.95, out: 4.0 },
  "kimi-k3": { in: 3.0, out: 15.0 },
  "glm-5.3": { in: 1.4, out: 4.4 },
  "glm-5.3-flash": { in: 0.15, out: 0.5 },
  "glm-5.2": { in: 1.4, out: 4.4 },
  "glm-5.1": { in: 1.4, out: 4.4 },
  "glm-5": { in: 1.0, out: 3.2 },
  "qwen3.8-max": { in: 2.0, out: 6.0 },
  "qwen3.8-flash": { in: 0.15, out: 0.47 },
  "qwen3.7-max": { in: 2.5, out: 7.5 },
  "qwen3.7-plus": { in: 0.4, out: 1.6 },
  "qwen3.6-plus": { in: 0.5, out: 3.0 },
  "qwen3.5-plus": { in: 0.2, out: 1.2 },
  "deepseek-v4-pro": { in: 1.74, out: 3.48 },
  "deepseek-v4-flash": { in: 0.14, out: 0.28 },
  "deepseek-v4-flash-vision-exp": { in: 0.14, out: 0.28 },
  "deepseek-v4.1-flash": { in: 0.3, out: 1.2 },
  "minimax-m3": { in: 0.3, out: 1.2 },
  "minimax-m2.7": { in: 0.3, out: 1.2 },
  "minimax-m2.5": { in: 0.3, out: 1.2 },
  "mistral-large-4": { in: 0.68, out: 2.09 },
  // claude family (base tier; see TIERS for long-context rates)
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // gemini family
  "gemini-3.8-flash": { in: 1.5, out: 7.5 },
  "gemini-3.7-flash": { in: 1.5, out: 7.5 },
  "gemini-3.6-flash": { in: 1.5, out: 7.5 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-pro": { in: 2, out: 12 },
  "gemini-3-flash": { in: 0.5, out: 3.0 },
  // grok family
  "grok-4.7": { in: 2, out: 6 },
  "grok-4.6": { in: 2, out: 6 },
  "grok-4.5": { in: 2, out: 6 },
  "grok-build-0.1": { in: 1, out: 2 },
  // gpt family
  "gpt-6-astra": { in: 10, out: 50 },
  "gpt-6-sol": { in: 2, out: 10 },
  "gpt-6.1-sol": { in: 2, out: 10 },
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "gpt-5.6-sol": { in: 4, out: 20 },
  "gpt-5.6-terra": { in: 2, out: 12 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-5.5": { in: 5, out: 30 },
  "gpt-5.5-pro": { in: 30, out: 180 },
  "gpt-5.4": { in: 2.5, out: 15 },
  "gpt-5.4-pro": { in: 30, out: 180 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25 },
  "gpt-5.3-codex-spark": { in: 1.75, out: 14 },
  "gpt-5.3-codex": { in: 1.75, out: 14 },
  "gpt-5.2": { in: 1.75, out: 14 },
  "gpt-5.2-codex": { in: 1.75, out: 14 },
  "gpt-5.1": { in: 1.07, out: 8.5 },
  "gpt-5.1-codex": { in: 1.07, out: 8.5 },
  "gpt-5.1-codex-max": { in: 1.25, out: 10 },
  "gpt-5.1-codex-mini": { in: 0.25, out: 2 },
  "gpt-5": { in: 1.07, out: 8.5 },
  "gpt-5-codex": { in: 1.07, out: 8.5 },
  "gpt-5-nano": { in: 0.05, out: 0.4 },
};

// Long-context tiers: {above input_tokens} → higher per-1M rates.
const TIERS: Record<string, { above: number; in: number; out: number }> = {
  "claude-sonnet-4-5": { above: 200_000, in: 6, out: 22.5 },
  "claude-haiku-5-5": { above: 100_000, in: 0.5, out: 2.5 },
  "gemini-3.1-pro": { above: 200_000, in: 4, out: 18 },
  "grok-4.7": { above: 200_000, in: 4, out: 12 },
  "grok-4.6": { above: 200_000, in: 4, out: 12 },
  "grok-4.5": { above: 200_000, in: 4, out: 12 },
  "gpt-6-astra": { above: 272_000, in: 20, out: 75 },
  "gpt-6-sol": { above: 272_000, in: 4, out: 15 },
  "gpt-6.1-sol": { above: 272_000, in: 4, out: 15 },
  "gpt-6-luna": { above: 272_000, in: 0.2, out: 0.75 },
  "gpt-5.6-sol": { above: 272_000, in: 8, out: 30 },
  "gpt-5.6-terra": { above: 272_000, in: 4, out: 18 },
  "gpt-5.6-luna": { above: 272_000, in: 0.4, out: 1.8 },
  "gpt-5.5": { above: 272_000, in: 10, out: 45 },
  "gpt-5.4": { above: 272_000, in: 5, out: 22.5 },
};

export function priceFor(model: string, inputTokens: number): { in: number; out: number; tiered: boolean } | null {
  const key = model.toLowerCase();
  const base = PRICING[key] ?? PRICING[model];
  if (!base) return null;
  const tier = TIERS[key];
  if (tier && inputTokens > tier.above) return { in: tier.in, out: tier.out, tiered: true };
  return { ...base, tiered: false };
}

export function costUSD(model: string, inTok: number, outTok: number): number {
  const p = priceFor(model, inTok);
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

export function hasPrice(model: string): boolean {
  return priceFor(model, 0) !== null;
}
