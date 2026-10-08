# OpenCode Zen Proxy Gateway
FROM oven/bun:1.3-alpine

WORKDIR /app

# Install Node.js & npm (for OpenCode CLI)
RUN apk add --no-cache nodejs npm curl bash

# Install OpenCode globally
RUN npm install -g opencode-ai

# Copy package files
COPY package.json bun.lock* ./

# Install proxy dependencies
RUN bun install --frozen-lockfile || bun install

# Copy application source
COPY . .

# Expose proxy port (3000) and opencode internal port (4096)
EXPOSE 3000
EXPOSE 4096

ENV PORT=3000
ENV OPENCODE_SERVER_URL=http://127.0.0.1:4096

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

# Start the proxy (auto-starts opencode serve if needed)
CMD ["bun", "run", "src/index.ts"]
