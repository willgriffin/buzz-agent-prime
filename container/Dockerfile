# syntax=docker/dockerfile:1.7
# buzz-agent-prime — OCI image v0.1
#
# Multi-stage, multi-arch, pinned to immutable upstreams.
# Every software pin is verified by SHA256.

# ### Stage 0: Rust workspace (buzz* tools from block/buzz) ####################
FROM rust:1.88-bookworm AS rust-builder

ARG BUZZ_REF=3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42
ARG BUZZ_REPO=https://github.com/block/buzz.git

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --filter=blob:none "$BUZZ_REPO" . \
 && git checkout "$BUZZ_REF" \
 && git sparse-checkout init --cone \
 && git sparse-checkout set crates examples

RUN cargo build --release -p buzz-cli -p buzz-acp -p git-credential-nostr \
 && strip target/release/buzz target/release/buzz-acp target/release/git-credential-nostr

# ### Stage 1: prime-agent v0.7.1 (verified tarball) ##########################
FROM node:22-bookworm-slim AS prime-builder

ARG PRIME_TARBALL=https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.1/prime-agent-0.7.1.tgz
ARG PRIME_SHA256=d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "$PRIME_TARBALL" -o /tmp/prime-agent.tgz \
 && echo "$PRIME_SHA256  /tmp/prime-agent.tgz" | sha256sum -c - \
 && mkdir -p /opt/prime-agent \
 && tar -xzf /tmp/prime-agent.tgz -C /opt/prime-agent --strip-components=1 \
 && rm /tmp/prime-agent.tgz \
 && cd /opt/prime-agent \
 && npm install --omit=dev --ignore-scripts \
 && npm cache clean --force

# ### Stage 2: buzz-agent-prime (our Node package) ##############################
FROM node:22-bookworm-slim AS app-builder

WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci \
 && npm run build

# ### Stage 3: uv binary fetch #################################################
FROM debian:bookworm-slim AS uv-fetch
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG UV_VERSION=0.5.11
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) ARCH=x86_64 ;; \
      arm64) ARCH=aarch64 ;; \
      *)     echo "unsupported arch"; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz" \
      -o /tmp/uv.tar.gz \
 && mkdir /tmp/uv && tar -xzf /tmp/uv.tar.gz -C /tmp/uv \
 && cp /tmp/uv/uv-${ARCH}-unknown-linux-gnu/uv /usr/local/bin/uv \
 && chmod +x /usr/local/bin/uv

# ### Stage 4: python3.12 + ipykernel (from python:3.12-slim) ##################
FROM python:3.12-slim-bookworm AS python-runtime
RUN pip install --no-cache-dir ipykernel

# ### Stage 5: runtime (debian slim + copied layers) ###########################
FROM debian:bookworm-slim AS runtime

# OCI labels.
ARG VERSION=0.1.0
ARG REVISION=local
ARG CREATED_AT=unknown
LABEL org.opencontainers.image.title="buzz-agent-prime" \
      org.opencontainers.image.description="Run Prime Agent as a persistent Buzz-native agent" \
      org.opencontainers.image.source="https://buzz.happyvertical.com/git/2ff508fee38b4ee69114c43693c2d863f8ecc93aef11ac91fea6b577045bd84a/buzz-agent-prime.git" \
      org.opencontainers.image.url="https://github.com/willgriffin/buzz-agent-prime" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED_AT}" \
      ai.primeintellect.prime-agent.version="0.7.1" \
      ai.primeintellect.prime-agent.commit="a18809e00ea30638584d87b3afea7285a9d7296c" \
      io.block.buzz.commit="3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42"

# Runtime system packages only (no compilers, no build tools).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
      git \
      ripgrep \
      jq \
 && rm -rf /var/lib/apt/lists/*

# Copy Node from the node base image (which we used for the builders).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node:22-bookworm-slim /opt /opt
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Copy Python 3.12 from the python base image.
COPY --from=python-runtime /usr/local /usr/local

# Copy all the built + pinned software layers.
COPY --from=uv-fetch /usr/local/bin/uv /usr/local/bin/uv
COPY --from=prime-builder /opt/prime-agent /opt/prime-agent
COPY --from=rust-builder /src/target/release/buzz /usr/local/bin/buzz
COPY --from=rust-builder /src/target/release/buzz-acp /usr/local/bin/buzz-acp
COPY --from=rust-builder /src/target/release/git-credential-nostr /usr/local/bin/git-credential-nostr
COPY --from=app-builder /src/dist /opt/buzz-agent-prime/dist
COPY --from=app-builder /src/package.json /opt/buzz-agent-prime/package.json
COPY LICENSE NOTICE.md /opt/buzz-agent-prime/

# Executable symlinks.
RUN ln -sf /opt/buzz-agent-prime/dist/cli.js /usr/local/bin/buzz-agent-prime \
 && ln -sf /opt/prime-agent/dist/bundle/cli.js /usr/local/bin/prime-agent \
 && chmod +x /opt/buzz-agent-prime/dist/cli.js

# Non-root user 1001.
RUN groupadd --system --gid 1001 buzzagent \
 && useradd  --system --uid 1001 --gid buzzagent --home-dir /var/lib/buzz-agent-prime --shell /usr/sbin/nologin buzzagent \
 && mkdir -p /var/lib/buzz-agent-prime /workspace /tmp \
 && chown -R buzzagent:buzzagent /var/lib/buzz-agent-prime /workspace /tmp

USER buzzagent
WORKDIR /var/lib/buzz-agent-prime

ENV NODE_ENV=production \
    BUZZ_AGENT_PRIME_STATE_DIR=/var/lib/buzz-agent-prime \
    BUZZ_AGENT_PRIME_WORKSPACE_DIR=/workspace \
    BUZZ_AGENT_PRIME_TMP_DIR=/tmp \
    PATH="/usr/local/bin:${PATH}"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/buzz-agent-prime"]
CMD ["serve"]

VOLUME ["/var/lib/buzz-agent-prime", "/workspace", "/tmp"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD /usr/local/bin/buzz-agent-prime doctor || exit 1
