# Quick Start for Operators

This guide walks a fresh operator from zero to a verified deployment. You do
not need to read source code — everything here is self-contained.

## Prerequisites

- **Docker 24+** (for Docker/Compose deployment) **or** a **Kubernetes 1.28+**
  cluster with `kubectl` configured (for Kubernetes deployment).
- A **Buzz relay** endpoint (default: `wss://buzz.happyvertical.com`).
- A **Buzz Nostr identity** (nsec or hex private key). See
  [Buzz Identity Setup](identity.md).
- One or more **model provider API keys** (e.g. Anthropic, OpenAI). See
  [Provider Configuration](providers.md).

## Steps

### 1. Generate a Buzz identity

Create a Nostr key pair for your agent. The private key (`nsec…` or hex)
is the agent's identity on the relay.

```bash
# See identity.md for full instructions
# Generate an nsec with any Nostr key tool, then set it:
export BUZZ_PRIVATE_KEY=nsec1…
```

→ Full guide: [Buzz Identity Setup](identity.md)

### 2. Configure model providers

Set the environment variables for your model providers. Prime Agent reads
standard provider key variables.

```bash
export ANTHROPIC_API_KEY=sk-ant-…
# or
export OPENAI_API_KEY=sk-…
```

→ Full guide: [Provider Configuration](providers.md)

### 3. Choose your deployment platform

| Platform | Guide |
| -------- | ----- |
| Docker Compose (recommended for single-host) | [Docker Deployment](docker.md) |
| Kubernetes (single-replica, persistent) | [Kubernetes Deployment](kubernetes.md) |

### 4. Deploy

#### Docker Compose

```bash
# Clone the repository and navigate to deployment manifests
git clone https://github.com/willgriffin/buzz-agent-prime.git
cd buzz-agent-prime

# Copy the example environment file and fill in secrets
cp .env.example .env
# Edit .env: set BUZZ_PRIVATE_KEY and provider keys

# Start the agent
docker compose --file deploy/docker/docker-compose.yml up -d
```

→ Full guide: [Docker Deployment](docker.md)

#### Kubernetes

```bash
kubectl apply -k deploy/kubernetes/
# Or with Helm (if using the chart):
# helm install buzz-agent-prime deploy/kubernetes/charts/buzz-agent-prime
```

→ Full guide: [Kubernetes Deployment](kubernetes.md)

### 5. Verify the deployment

Run the built-in diagnostics:

```bash
# From inside the container:
docker exec -it buzz-agent-prime buzz-agent-prime doctor

# Or via kubectl:
kubectl exec deployment/buzz-agent-prime -- buzz-agent-prime doctor
```

`doctor` checks binaries, versions, state-directory writability, and required
configuration. It **never prints secrets**.

Check the version:

```bash
buzz-agent-prime version
# Expected: 0.1.0
```

Check that the agent is connected to the relay:

```bash
# Docker
docker logs buzz-agent-prime 2>&1 | grep -i relay

# Kubernetes
kubectl logs deployment/buzz-agent-prime | grep -i relay
```

Send a test message from a Buzz channel where your agent is configured to
respond (see `BUZZ_ACP_RESPOND_TO` in [contracts](../contracts.md)). The agent
should reply within a few seconds.

### 6. Back up state

The state directory (`/var/lib/buzz-agent-prime`) contains session state,
kernel checkpoints, and artifacts. Back it up regularly.

→ Full guide: [Backup and Restore](backup.md)

## Next steps

- [Architecture](../architecture.md) — how the components fit together.
- [Troubleshooting](troubleshooting.md) — common issues and fixes.
- [Upgrade and Rollback](upgrade.md) — how to update safely.
- [Buzz Desktop harness](../buzz-desktop.md) — connect with Buzz Desktop.
