# buzz-agent-prime Container Image

## Build

```bash
# ARM64 (native on Apple Silicon, Graviton, etc.)
docker build --platform linux/arm64 \
  -f container/Dockerfile \
  -t ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  --build-arg VERSION=0.1.0 \
  --build-arg REVISION=$(git rev-parse --short HEAD) \
  --build-arg CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .

# AMD64
docker build --platform linux/amd64 \
  -f container/Dockerfile \
  -t ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  --build-arg VERSION=0.1.0 \
  --build-arg REVISION=$(git rev-parse --short HEAD) \
  --build-arg CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  .

# Multi-arch manifest (requires buildx)
docker buildx build --platform linux/amd64,linux/arm64 \
  -f container/Dockerfile \
  -t ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  --build-arg VERSION=0.1.0 \
  --build-arg REVISION=$(git rev-parse --short HEAD) \
  --build-arg CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --push .
```

## What's inside

| Component                            | Version / Pin                                    |
| ------------------------------------ | ------------------------------------------------ |
| prime-agent                          | v0.7.1 / `a18809e0` (tarball verified by SHA256) |
| buzz, buzz-acp, git-credential-nostr | `3a96acea` (Rust build from pinned commit)       |
| buzz-agent-prime                     | this repo, latest                                |
| Node.js                              | 22.12.0                                          |
| Python                               | 3.12 (with ipykernel)                            |
| uv                                   | 0.5.11                                           |

## Smoke test

```bash
docker run --rm ghcr.io/willgriffin/buzz-agent-prime:0.1.0 version
# 0.1.0

docker run --rm ghcr.io/willgriffin/buzz-agent-prime:0.1.0 doctor
# Reports binary presence, writability, config status
```

## ACP handshake test

```bash
printf '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":2,"info":{"name":"test"},"capabilities":{}},"id":1}
' \
  | docker run --rm -i ghcr.io/willgriffin/buzz-agent-prime:0.1.0 acp
# Returns merged capabilities + _meta from the multiplexer + prime-agent
```

## Non-root + read-only rootfs

The image runs as UID 1001 (non-root). Add `--read-only` with tmpfs mounts for state:

```bash
docker run --rm --read-only \
  --tmpfs /var/lib/buzz-agent-prime \
  --tmpfs /workspace \
  --tmpfs /tmp \
  ghcr.io/willgriffin/buzz-agent-prime:0.1.0 doctor
```

## Reproducibility

Every pinned upstream is verified by SHA256 at build time. The resulting image
carries OCI labels with exact version and commit hashes.
