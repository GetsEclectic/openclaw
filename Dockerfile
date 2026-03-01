# Stage 1: Build
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm

COPY . /tmp/openclaw
RUN cd /tmp/openclaw \
    && pnpm install \
    && pnpm run build \
    && npm pack \
    && mv openclaw-*.tgz /tmp/openclaw.tgz

# Stage 2: Runtime
FROM node:22-slim

# Runtime dependencies
RUN apt-get update && apt-get install -y \
    git curl jq ripgrep sqlite3 procps \
    && rm -rf /var/lib/apt/lists/*

# Install openclaw from tarball + cleanup
COPY --from=builder /tmp/openclaw.tgz /tmp/openclaw.tgz
RUN npm install -g /tmp/openclaw.tgz \
    && rm /tmp/openclaw.tgz \
    && npm cache clean --force \
    && rm -rf /root/.npm/_cacache /root/.npm/_logs

# Install gogcli
RUN curl -sL https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz | tar xz -C /usr/local/bin

# Install signal-cli
RUN SIGNAL_CLI_VERSION=$(curl -s https://api.github.com/repos/AsamK/signal-cli/releases/latest | jq -r '.tag_name' | sed 's/^v//') \
    && curl -sL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
    | tar xz -C /opt \
    && ln -s /opt/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native/bin/signal-cli /usr/local/bin/signal-cli

# Install Matrix dependencies
RUN npm install -g @vector-im/matrix-bot-sdk@0.8.0-element.3 @matrix-org/matrix-sdk-crypto-nodejs@^0.4.0

# Entrypoint auto-installs missing plugins before starting
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]
CMD ["openclaw", "gateway", "run"]
