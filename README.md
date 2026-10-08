# Reverse-Opencode (`opencode-zen-proxy`)

> **Version:** `v1.0.0` (Production Release)  
> **Release Date:** `2026-10-09T02:00:00+05:30` (Friday, October 9, 2026)  
> **Author & Engineering:** Hypertonny  
> **Repository:** `git@github.com:hypertonny/Reverse-Opencode.git` ([https://github.com/hypertonny/Reverse-Opencode](https://github.com/hypertonny/Reverse-Opencode))  
> **Documentation:** [ARCHITECTURE_AND_END_TO_END_SPEC.md](ARCHITECTURE_AND_END_TO_END_SPEC.md) | [CHANGELOG.md](CHANGELOG.md)

High-performance local AI gateway that exposes **OpenCode's free models** (including **Muse Spark 1.3 Free**, **Big Pickle**, **Space Bunny Free**, and all contributor models) through **both OpenAI-compatible and Anthropic-compatible APIs**.

Any coding agent—**Claude Code CLI (v2.1.295)**, **Cline**, **Aider**, **Continue**, etc.—can plug directly into this proxy to code autonomously without paid API keys.

---

## Key Features

- **Dual API Surface:**
  - **OpenAI-compatible:** `POST /v1/chat/completions`, `GET /v1/models` (SSE streaming chunks with `data: [DONE]`, tool calling, multi-turn messages).
  - **Anthropic-compatible:** `POST /v1/messages`, `POST /v1/messages/count_tokens` (SSE streaming events: `message_start`, `content_block_delta`, `message_stop`, tool use blocks).
- **Official OpenCode Integration:**
  - Communicates directly with OpenCode's official server mode (`opencode serve --port 4096`) using your logged-in account.
  - Zero client spoofing or limit evasion.
  - Automatic background discovery & lifecycle management.
- **Strict Free Model Policy:**
  - Only allows free models (`muse-spark-1.3-contributor-free`, `big-pickle`, `space-bunny-free`, `ling-3.1-flash-free`, etc.).
  - Blocks any paid model with a clean `403 model_not_allowed` error.
  - Set `ALLOW_PAID_MODELS=true` if you explicitly want to unlock paid models.
- **Dynamic Model Discovery:**
  - Discovers available free models dynamically via `GET /v1/models` and caches them with periodic background refresh.
- **Production Observability & Metrics:**
  - Structured JSON logging to `./logs/requests.jsonl` with automatic file rotation.
  - Request IDs (`X-Request-Id`) across all hops.
  - Redaction of API keys and private prompts in metrics.
  - `GET /health` — health check, upstream connection status, active limits, free model list.
  - `GET /metrics` — Prometheus metrics (requests, tokens, latency, in-flight, errors, per-model counters).
  - `GET /usage` — Aggregated usage and token summary per model and per key.
- **Safety & Rate Limiting:**
  - Configurable RPM rate limiter and concurrency cap with `Retry-After` header.
  - Max payload size validation (`MAX_BODY_BYTES`) to prevent memory exhaustion.
  - Graceful connection cancellation and error mapping.

---

## Quickstart

### Prerequisites
- [Bun](https://bun.sh) (v1.1+)
- [OpenCode CLI](https://opencode.ai) logged in with your account (`opencode providers list`)

### 1. Install & Configure

```bash
git clone git@github.com:hypertonny/Reverse-Opencode.git
cd Reverse-Opencode
bun install
cp .env.example .env
```

### 2. Start OpenCode Server

Ensure your OpenCode server is active (the proxy can also auto-attach):
```bash
opencode serve --port 4096
```

### 3. Start the Proxy

```bash
bun run src/index.ts
```

Output:
```
opencode-zen-proxy listening on http://127.0.0.1:3005
mode: free-keyless | proxy auth: disabled (open) | rate: 240/min max-conc: 16
API endpoints:
  Anthropic: POST /v1/messages (streaming SSE)
  OpenAI:    POST /v1/chat/completions (SSE streaming)
  Models:    GET  /v1/models
  Health:    GET  /health
  Metrics:   GET  /metrics (Prometheus) | GET /metrics/json
  Usage:     GET  /usage
```

---

## Agent Configuration

### 1. Claude Code

Claude Code communicates using the Anthropic Messages API. Point it to the proxy base URL:

#### macOS / Linux
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3005"
export ANTHROPIC_API_KEY="dummy" # Or your PROXY_API_KEY if configured

# Launch Claude Code with Muse Spark 1.3 Free
claude --model muse-spark-1.3-contributor-free
```

#### Windows (PowerShell)
```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3005"
$env:ANTHROPIC_API_KEY = "dummy"

claude --model muse-spark-1.3-contributor-free
```

---

### 2. Cline (VS Code Extension)

1. Open **Cline Settings** in VS Code.
2. Select **API Provider**: `OpenAI Compatible` (or `Anthropic Compatible`).
3. Set **Base URL**: `http://127.0.0.1:3005/v1`
4. Set **API Key**: `dummy` (or your `PROXY_API_KEY`).
5. Set **Model ID**: `muse-spark-1.3-contributor-free` (or `big-pickle`).
6. Click **Save**.

---

### 3. Aider

Aider supports OpenAI-compatible endpoints with custom base URLs:

```bash
export OPENAI_API_BASE="http://127.0.0.1:3005/v1"
export OPENAI_API_KEY="dummy"

aider --model openai/muse-spark-1.3-contributor-free
```

---

### 4. Continue (VS Code / JetBrains)

Add the following provider block to your `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "OpenCode Muse Spark 1.3 (Free)",
      "provider": "openai",
      "model": "muse-spark-1.3-contributor-free",
      "apiBase": "http://127.0.0.1:3005/v1",
      "apiKey": "dummy"
    },
    {
      "title": "OpenCode Big Pickle (Free)",
      "provider": "openai",
      "model": "big-pickle",
      "apiBase": "http://127.0.0.1:3005/v1",
      "apiKey": "dummy"
    }
  ]
}
```

---

## Available Free Models

Query dynamic list at runtime: `curl http://127.0.0.1:3005/v1/models`

- `muse-spark-1.3-contributor-free` (Recommended - best coding performance)
- `muse-spark-1.2-contributor-free`
- `big-pickle`
- `space-bunny-free`
- `longcat-2.5-preview-free`
- `exo-free`
- `fledge-alpha-free`
- `mimo-v2.6-flash-free`
- `mimo-v2.5-free`
- `ling-3.1-flash-free`
- `ling-3.0-flash-fin-free`
- `nemotron-3-ultra-free`
- `nemotron-3.5-lightning-free`

---

## Docker Deployment

Build and run with Docker:

```bash
docker build -t opencode-zen-proxy .
docker run -d -p 3005:3005 -p 4096:4096 --name opencode-proxy opencode-zen-proxy
```

---

## Testing & Verification

Run the automated test suite with Bun:

```bash
bun test
```

### Manual Curl Checks

#### Check Health
```bash
curl -s http://127.0.0.1:3005/health
```

#### List Models
```bash
curl -s http://127.0.0.1:3005/v1/models
```

#### OpenAI Chat Completion (Streaming)
```bash
curl -N -X POST http://127.0.0.1:3005/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "messages": [{"role": "user", "content": "Count from 1 to 3"}],
    "stream": true
  }'
```

#### Anthropic Messages (Streaming)
```bash
curl -N -X POST http://127.0.0.1:3005/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": true
  }'
```

---

## Prometheus & Observability

- **Metrics:** `GET /metrics` returns Prometheus metrics:
  - `opencode_proxy_uptime_seconds`
  - `opencode_proxy_requests_total`
  - `opencode_proxy_errors_total`
  - `opencode_proxy_input_tokens_total`
  - `opencode_proxy_output_tokens_total`
  - `opencode_proxy_in_flight`
  - Per-model counters: `opencode_proxy_model_requests_total{model="..."}`
- **Usage Summary:** `GET /usage` returns JSON summary broken down by model and API key.
- **Audit Logs:** Requests logged to `./logs/requests.jsonl` with token counts, latency, and sanitized headers.
