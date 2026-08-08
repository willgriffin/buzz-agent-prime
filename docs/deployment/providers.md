# Provider Configuration

Prime Agent talks to LLM providers (Anthropic, OpenAI, etc.) using standard
environment variables. This document explains how to configure them for your
`buzz-agent-prime` deployment.

## How provider keys flow

```text
Environment variable (e.g. ANTHROPIC_API_KEY)
  → Docker/Kubernetes env injection
    → buzz-acp process env
      → prime-agent subprocess env (inherited)
        → LLM provider API
```

`buzz-agent-prime` passes the full environment through to `prime-agent`
subprocesses. Any environment variable you set on the container is inherited
by the agent.

## Supported providers

Prime Agent (v0.7.1) supports the following primary providers:

### Anthropic (Claude)

```bash
ANTHROPIC_API_KEY=sk-ant-api03-…
```

### OpenAI

```bash
OPENAI_API_KEY=sk-…
```

### OpenRouter

```bash
OPENROUTER_API_KEY=sk-or-v1-…
```

> **Note:** The exact set of supported providers and their environment
> variable names are defined by Prime Agent's own configuration. See the
> [Prime Agent documentation](https://github.com/PrimeIntellect-ai/prime-agent)
> for the full list. The variables above are the most commonly used; any
> provider key variable that Prime recognizes will work when set on the
> container.

## Docker Compose

Add provider keys to your `.env` file (never commit this file):

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-api03-…
# OPENAI_API_KEY=sk-…
# OPENROUTER_API_KEY=sk-or-v1-…
```

The `deploy/docker/docker-compose.yml` manifest reads these from the
environment and injects them into the container:

```yaml
# Excerpt from the expected docker-compose.yml structure:
services:
  buzz-agent-prime:
    env_file:
      - .env
    environment:
      # Keys from .env are injected here
      - ANTHROPIC_API_KEY
      - BUZZ_RELAY_URL
      - BUZZ_PRIVATE_KEY
```

### Alternative: Docker secrets

For production, prefer Docker secrets over `.env`:

```yaml
services:
  buzz-agent-prime:
    secrets:
      - anthropic_api_key
secrets:
  anthropic_api_key:
    file: /run/secrets/anthropic_api_key
```

The specific manifest structure is defined by the Docker worker (issue #6)
under `deploy/docker/`.

## Kubernetes

Create a `Secret` containing provider keys:

```bash
kubectl create secret generic buzz-agent-secrets \
  --from-literal=BUZZ_PRIVATE_KEY=nsec1… \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-…
```

The `deploy/kubernetes/` manifests reference this secret and inject the keys
as environment variables:

```yaml
# Excerpt from the expected Deployment manifest structure:
spec:
  containers:
    - name: buzz-agent-prime
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: buzz-agent-secrets
              key: ANTHROPIC_API_KEY
```

### ExternalSecret (recommended for production)

For production clusters with a secrets manager (Vault, AWS Secrets Manager,
GCP Secret Manager), use
[ExternalSecrets](https://external-secrets.io/):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: buzz-agent-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: buzz-agent-secrets
  data:
    - secretKey: ANTHROPIC_API_KEY
      remoteRef:
        key: buzz-agent-prime/anthropic-api-key
    - secretKey: BUZZ_PRIVATE_KEY
      remoteRef:
        key: buzz-agent-prime/buzz-private-key
```

## Heartbeat (optional)

`buzz-acp` supports a heartbeat interval to keep the relay connection alive.
It is disabled by default in v0.1:

```bash
BUZZ_ACP_HEARTBEAT_INTERVAL=0  # disabled (default)
# To enable (e.g. every 60 seconds):
BUZZ_ACP_HEARTBEAT_INTERVAL=60
```

See the [contracts](../contracts.md) for all environment variables.

## Verifying provider configuration

After deployment, verify that the agent can reach providers:

```bash
# Docker
docker exec -it buzz-agent-prime buzz-agent-prime doctor

# Kubernetes
kubectl exec deployment/buzz-agent-prime -- buzz-agent-prime doctor
```

`doctor` checks for required configuration without printing secret values.
If keys are missing or unreachable, `doctor` reports which configuration is
required.

The ultimate test is sending a message from a Buzz channel: the agent invokes
the model and replies.
