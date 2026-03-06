# syntax=docker/dockerfile:1
# Stage 1: Build
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

WORKDIR /tmp/openclaw

# --- Dependency-manifest layer (changes rarely) ---
# Copy lockfile, workspace config, .npmrc, and every workspace package.json
# so that `pnpm install` is cached until a manifest actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Root workspace member: ui/
COPY ui/package.json ui/

# packages/*
COPY packages/clawdbot/package.json packages/clawdbot/
COPY packages/moltbot/package.json packages/moltbot/

# extensions/*
COPY extensions/bluebubbles/package.json extensions/bluebubbles/
COPY extensions/copilot-proxy/package.json extensions/copilot-proxy/
COPY extensions/diagnostics-otel/package.json extensions/diagnostics-otel/
COPY extensions/discord/package.json extensions/discord/
COPY extensions/feishu/package.json extensions/feishu/
COPY extensions/googlechat/package.json extensions/googlechat/
COPY extensions/google-gemini-cli-auth/package.json extensions/google-gemini-cli-auth/
COPY extensions/imessage/package.json extensions/imessage/
COPY extensions/irc/package.json extensions/irc/
COPY extensions/line/package.json extensions/line/
COPY extensions/llm-task/package.json extensions/llm-task/
COPY extensions/lobster/package.json extensions/lobster/
COPY extensions/matrix/package.json extensions/matrix/
COPY extensions/mattermost/package.json extensions/mattermost/
COPY extensions/memory-core/package.json extensions/memory-core/
COPY extensions/memory-lancedb/package.json extensions/memory-lancedb/
COPY extensions/minimax-portal-auth/package.json extensions/minimax-portal-auth/
COPY extensions/msteams/package.json extensions/msteams/
COPY extensions/nextcloud-talk/package.json extensions/nextcloud-talk/
COPY extensions/nostr/package.json extensions/nostr/
COPY extensions/open-prose/package.json extensions/open-prose/
COPY extensions/signal/package.json extensions/signal/
COPY extensions/slack/package.json extensions/slack/
COPY extensions/synology-chat/package.json extensions/synology-chat/
COPY extensions/telegram/package.json extensions/telegram/
COPY extensions/tlon/package.json extensions/tlon/
COPY extensions/twitch/package.json extensions/twitch/
COPY extensions/voice-call/package.json extensions/voice-call/
COPY extensions/whatsapp/package.json extensions/whatsapp/
COPY extensions/zalo/package.json extensions/zalo/
COPY extensions/zalouser/package.json extensions/zalouser/

# Install dependencies (cached unless a manifest or lockfile changes)
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Source layer (changes frequently) ---
COPY . .

RUN pnpm run build \
    && npm pack \
    && mv openclaw-*.tgz /tmp/openclaw.tgz

# Stage 2: Runtime
FROM node:22-slim

# Runtime system dependencies
RUN apt-get update && apt-get install -y \
    git curl jq ripgrep sqlite3 procps tmux android-tools-adb \
    && rm -rf /var/lib/apt/lists/*

# --- External tool installs (cached independently of source changes) ---

# Install Claude Code CLI
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @anthropic-ai/claude-code

# Install gogcli (pinned)
RUN curl -sL https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz | tar xz -C /usr/local/bin

# Install signal-cli (pinned)
ENV SIGNAL_CLI_VERSION=0.14.0
RUN curl -sL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
    | tar xz -C /opt \
    && ln -s /opt/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native/bin/signal-cli /usr/local/bin/signal-cli

# Install Matrix dependencies
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @vector-im/matrix-bot-sdk@0.8.0-element.3 @matrix-org/matrix-sdk-crypto-nodejs@^0.4.0

# --- Install openclaw from builder tarball ---
COPY --from=builder /tmp/openclaw.tgz /tmp/openclaw.tgz
RUN --mount=type=cache,target=/root/.npm \
    npm install -g /tmp/openclaw.tgz \
    && rm /tmp/openclaw.tgz

# Entrypoint auto-installs missing plugins before starting
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]
CMD ["openclaw", "gateway", "run"]
