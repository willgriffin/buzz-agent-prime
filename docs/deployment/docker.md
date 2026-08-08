# Docker Deployment

This guide deploys `buzz-agent-prime` on a single host using Docker Compose.
It is the recommended deployment for operators who want the simplest path to
a running agent.

## Prerequisites

- **Docker Engine 24+** and **Docker Compose v2** (`docker compose`).
- A **Buzz Nostr identity** (nsec or hex). See [Identity Setup](identity.md).
- One or more **model provider API keys**. See [Provider Configuration](providers.md).
- A reachable **Buzz relay** (default: `wss://buzz.happyvertical.com`).

## Overview

The Docker deployment runs a single container that includes:

- `buzz-agent-prime` (this package, the ACP multiplexer)
- `prime-agent` (pinned at v0.7.1)
- `buzz-acp` (pinned at 0.5.3 / `3a96acea`)
- Node.js 22 and Python 3.12 runtimes
- A persistent volume mounted at `/var/lib/buzz-agent-prime`

The container image is built by the Container worker (issue #5) from
`container/`. The Compose manifest is maintained by the Docker worker (issue
#6) under `deploy/docker/`.

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/willgriffin/buzz-agent-prime.git
cd buzz-agent-prime

# Copy the example environment file
cp .env.example .env
```

### 2. Edit `.env`

```bash
# .env
BUZZ_RELAY_URL=wss://buzz.happyvertical.com
BUZZ_PRIVATE_KEY=nsec1yourkeyhere…

# Model provider keys (at least one)
ANTHROPIC_API_KEY=sk-ant-api03-…
# OPENAI_API_KEY=sk-…

# Optional: tune session limits
BUZZ_AGENT_PRIME_MAX_SESSIONS=4
```

### 3. Start the agent

```bash
docker compose --file deploy/docker/docker-compose.yml up -d
```

### 4. Verify

```bash
# Check the container is running
docker compose --file deploy/docker/docker-compose.yml ps

# Run diagnostics
docker exec -it buzz-agent-prime buzz-agent-prime doctor

# Check logs for relay connection
docker logs buzz-agent-prime 2>&1 | head -30
```

## Expected manifest structure

> The actual manifest files are maintained by the Docker worker (issue #6).
> This section documents the expected structure so operators know what to look
> for and how to customize it.

### docker-compose.yml

The Compose manifest at `deploy/docker/docker-compose.yml` defines a single
service with:

- **Image:** the published container image (e.g.
  `ghcr.io/willgriffin/buzz-agent-prime:0.1.0`) or built from `container/`.
- **Environment:** loaded from `.env` or individual `environment:` entries.
- **Volumes:** a named or bind-mounted volume for
  `/var/lib/buzz-agent-prime` (persistent state).
- **Restart policy:** `unless-stopped` (or `always`).
- **Read-only root filesystem** with `tmpfs` for `/tmp` and the state tmp dir.
- **Non-root user:** the container runs as a dedicated unprivileged user.

```yaml
# Structurally similar to:
services:
  buzz-agent-prime:
    image: ghcr.io/willgriffin/buzz-agent-prime:0.1.0
    init: true
    restart: unless-stopped
    env_file: .env
    volumes:
      - buzz-agent-prime-state:/var/lib/buzz-agent-prime
    tmpfs:
      - /tmp
    read_only: true
    user: "1000:1000"

volumes:
  buzz-agent-prime-state:
```

### Dockerfile

The Dockerfile at `container/Dockerfile` (Container worker, issue #5)
multi-stage builds the image:

1. **Build stage:** installs `prime-agent` from the pinned GitHub commit
   tarball (not the public npm registry — see
   [compatibility.md](../compatibility.md)), builds `buzz-acp` and
   `git-credential-nostr` from the pinned `block/buzz` commit, and builds
   `buzz-agent-prime` from source.
2. **Runtime stage:** copies only the built artifacts, Node.js 22, Python 3.12,
   and sets up the state directory with a non-root user and read-only root.

## Configuration

All configuration is environment-based — v0.1 ships no configuration file.
See the full [contracts](../contracts.md) for all variables.

| Variable                         | Default                     | Purpose                             |
| -------------------------------- | --------------------------- | ----------------------------------- |
| `BUZZ_RELAY_URL`                 | `ws://localhost:3000`       | Relay WebSocket URL.                |
| `BUZZ_PRIVATE_KEY`               | —                           | Agent Nostr identity (nsec or hex). |
| `BUZZ_ACP_RESPOND_TO`            | `owner-only`                | Inbound author gate.                |
| `BUZZ_AGENT_PRIME_MAX_SESSIONS`  | `4`                         | Maximum concurrent sessions.        |
| `BUZZ_AGENT_PRIME_STATE_DIR`     | `/var/lib/buzz-agent-prime` | Persistent state directory.         |
| `BUZZ_AGENT_PRIME_WORKSPACE_DIR` | `<state>/workspace`         | Default session working directory.  |
| `BUZZ_AGENT_PRIME_TMP_DIR`       | `<state>/tmp`               | Writable scratch space.             |
| `BUZZ_ACP_HEARTBEAT_INTERVAL`    | `0`                         | Heartbeat interval (0=disabled).    |

## Persistent state

The state directory at `/var/lib/buzz-agent-prime` holds:

- **Named-channel sessions:** kernel checkpoints and artifacts keyed by
  channel title (from `_meta.sessionTitle`). These survive container restarts.
- **Ephemeral sessions:** sessions without `_meta.sessionTitle` are not
  persisted across restarts.
- **Repository checkouts:** git repos cloned by sessions live here.
- **Workspace:** the default working directory for spawned sessions.

Always mount a named volume (not a container-local directory) to preserve
state across image rebuilds and container restarts. See
[Backup and Restore](backup.md) for backup procedures.

## Security considerations

**The agent and its subagents execute with the container user's permissions.
`buzz-agent-prime` is not a security sandbox.** See
[Architecture > Security model](../architecture.md#security-model).

Recommended hardening:

1. **Non-root user:** the manifest should specify a non-root UID/GID.
2. **Read-only root filesystem:** `read_only: true` with `tmpfs` for writable
   scratch space.
3. **No host network:** use the default bridge network; do not set
   `network_mode: host`.
4. **Resource limits:** set `deploy.resources.limits` to bound CPU and memory.
5. **Secret management:** use Docker secrets or `.env` with restrictive file
   permissions (`chmod 600 .env`); never commit `.env`.

```yaml
services:
  buzz-agent-prime:
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 4G
```

## Stopping and restarting

```bash
# Stop the agent (state volume persists)
docker compose --file deploy/docker/docker-compose.yml down

# Restart
docker compose --file deploy/docker/docker-compose.yml up -d
```

Named-channel sessions resume automatically on restart. Ephemeral sessions
start fresh.

## Upgrading

See the [Upgrade and Rollback](upgrade.md) guide for safe image updates.
