# Changelog & Release History

All notable changes to the **Reverse-Opencode** project (`opencode-zen-proxy`) will be documented in this file.

The project adheres to [Semantic Versioning (SemVer 2.0.0)](https://semver.org/spec/v2.0.0.html).

---

## [v1.0.0] - 2026-10-09T02:00:00+05:30 (Production Release)

### 🚀 Highlights & Executive Overview
The first stable production release of **Reverse-Opencode** (`opencode-zen-proxy`), providing a local AI gateway that bridges OpenCode Zen free frontier models (`muse-spark-1.3-contributor-free`, `big-pickle`, etc.) to Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`) client interfaces.

Enables autonomous coding tools—most notably **Claude Code CLI (v2.1.295)**, Cline, Aider, and Continue—to execute multi-turn agentic workflows, file operations, and bash tasks at zero cost.

---

### 📦 Release Version & Timing Metadata
* **Released Version:** `v1.0.0`
* **Release Timestamp:** `2026-10-09T02:00:00+05:30` (Friday, October 9, 2026)
* **Git Repository:** `git@github.com:hypertonny/Reverse-Opencode.git`
* **Web URL:** [https://github.com/hypertonny/Reverse-Opencode](https://github.com/hypertonny/Reverse-Opencode)
* **Author / Organization:** Hypertonny
* **Tested Agent:** Claude Code CLI v2.1.295 on Windows x64 (PowerShell) & Linux/macOS
* **Gateway Listen Port:** `3005` (Ensuring Port `3000` is preserved for user web applications like `munim-ai`)
* **Upstream Daemon Port:** `4096` (`opencode serve --port 4096`)

---

### 🔍 Deep Reverse Engineering Breakthroughs Included in v1.0.0
* **Direct Zen Gateway Forensics:** Documented the Cloudflare TLS/JA3 and cryptographic client signature checks blocking external clients from calling `https://opencode.ai/zen/v1` directly with `403 FreeTierError`. Solved by integrating local authenticated daemon `opencode serve`.
* **Binary Disassembly of `opencode.exe`:**
  - Located and isolated the hardcoded 1,500-character system prompt variable (`Na`) that forces the identity: *"You are OpenCode, the best coding agent on the planet..."*.
  - Discovered that the default `build` agent forcefully appends `Na` plus all scanned skills in `~/.config/opencode/skills` and `~/.claude/skills` (~30,000 tokens of prompt bloat).
* **The Native Whitelisted `agent: "explore"` Solution:**
  - Zen cloud server strictly enforces a whitelist on free-tier agents (custom agents like `agent: "passthrough"` return `403 FreeTierError`).
  - Discovered that the native `explore` agent is whitelisted by Zen, has **zero persona injection**, and does not load the 30k local skill tokens.
  - Implemented clean system prompt forwarding under `agent: "explore"`, allowing Claude Code's persona to be accepted 100% naturally by the upstream model without string replacements or hacks.

---

### ✨ Features & Architectural Capabilities
* **Anthropic Messages Protocol (`/v1/messages`):**
  - Full Anthropic Server-Sent Events (SSE) streaming lifecycle:
    `message_start` ➔ `content_block_start` ➔ `content_block_delta` ➔ `content_block_stop` ➔ `message_delta` ➔ `message_stop`.
  - Structured array system prompt parsing (`system: [{type: "text", text: "..."}]`).
  - Prompt caching usage fields: `cache_creation_input_tokens: 0`, `cache_read_input_tokens: 0` to prevent CLI UI crashes.
  - Seamless model aliasing: `opus 5.5`, `sonnet 5.5`, `claude-3-7-sonnet-*`, `claude-3-5-sonnet-*`, `claude-opus-*` automatically mapped to `muse-spark-1.3-contributor-free`.
* **OpenAI Protocol (`/v1/chat/completions`):**
  - Streaming SSE with `data: [DONE]`.
  - Non-streaming standard JSON response.
  - `GET /v1/models` endpoint for client auto-discovery.
* **Autonomous Multi-Turn Tool Support:**
  - Converts incoming Anthropic `tool_use` and `tool_result` content blocks into clean structural context.
  - Preserves full multi-turn conversation and tool execution state across turns.
* **Security & Free Tier Policy:**
  - Strict enforcement of free models only (`isFreeModel`).
  - Automatic `403 Forbidden` (`PaidModelForbiddenError`) on paid models to prevent unintended billing.
* **Stream Controller Safety:**
  - Guarded stream controller methods (`safeEnqueue`, `safeClose`, `safeError`) preventing `Invalid state: Controller is already closed` errors during rapid client disconnects.
* **Production Observability:**
  - Prometheus metrics on `/metrics`.
  - Token and request metrics on `/usage`.
  - Structured JSONL request logs in `logs/requests.jsonl` with automatic rotation.

---

### 🧪 Validation Suite
* **10/10 automated tests passing** in `test/proxy.test.ts`.
* **Live end-to-end Claude Code session verified:**
  1. Persona test: Answered naturally as Claude Code.
  2. Grounding test: Calculated accurate current time.
  3. Tool execution test: Read and summarized `package.json` autonomously.

---

## [v0.1.0-alpha] - 2026-10-08T22:30:00+05:30 (Initial PoC)
* Initial proof-of-concept exploring direct Zen API connectivity.
* Encountered `403 FreeTierError` and began binary inspection of OpenCode runtime.
