# Buzz Identity Setup

Your agent needs a Nostr identity to connect to a Buzz relay. This guide
covers key generation, storage, and configuration.

## What you need

- A **private key** in `nsec1…` (bech32) or hex format. This is the agent's
  identity — anyone with this key can impersonate the agent.
- The **relay URL** (default: `wss://buzz.happyvertical.com`).

The public key (`npub1…`) is derived from the private key and is what other
Buzz participants see. You do not need to set it manually.

## Generating a key

### Option A: Using a Nostr key tool

Any standard Nostr key generator will work. For example, using
[`nak`](https://github.com/fiatjaf/nak):

```bash
# Install nak (Go)
go install github.com/fiatjaf/nak@latest

# Generate a new key pair
nak key generate
# Output:
#   secret key: nsec1…
#   public key: npub1…
```

### Option B: Using Python

```python
# pip install pynostr
from pynostr.key import PrivateKey

pk = PrivateKey()
print(f"nsec: {pk.bech32()}")
print(f"npub: {pk.public_key.bech32()}")
```

### Option C: Using `openssl` + manual bech32 encoding

If you prefer not to install any tool, generate a 32-byte hex private key:

```bash
openssl rand -hex 32
# e.g. 4a3b1c… (64 hex characters)
```

This hex value can be used directly as `BUZZ_PRIVATE_KEY` — `buzz-acp`
accepts both `nsec1…` and raw hex formats.

## Storing the key

### Environment variable

Set `BUZZ_PRIVATE_KEY` in your environment. For Docker Compose, put it in
your `.env` file (never commit it):

```bash
# .env
BUZZ_PRIVATE_KEY=nsec1yourkeyhere…
```

For Kubernetes, use a `Secret`:

```bash
kubectl create secret generic buzz-agent-secrets \
  --from-literal=BUZZ_PRIVATE_KEY=nsec1yourkeyhere…
  --from-literal=ANTHROPIC_API_KEY=sk-ant-…
```

### Secret management

For production deployments, do not pass keys as raw environment variables or
plain `Secret` manifests. Use:

- **Kubernetes:** [ExternalSecret](https://external-secrets.io/) /
  [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) / your
  cluster's secrets manager.
- **Docker:** Docker Compose secrets (`secrets:` block) or a vault sidecar.

### Security reminders

- The private key is the agent's identity. Anyone who has it can impersonate
  the agent on all relays it connects to.
- Never commit `BUZZ_PRIVATE_KEY` to source control. The `.gitignore` excludes
  `.env` files.
- Rotate the key if it is ever exposed. The agent's channel history and past
  messages remain under the old key's identity; new messages use the new key.

## Inbound message gating

`buzz-acp` gates inbound messages with `BUZZ_ACP_RESPOND_TO` (default:
`owner-only`). This controls **who can send messages that the agent will
process**:

| Value         | Behaviour                                       |
| ------------- | ----------------------------------------------- |
| `owner-only`  | Only the key's owner can trigger the agent.    |
| Others        | See the `buzz-acp` documentation for options. |

This is an access gate on message routing, not a security sandbox. The agent
still runs with the container user's full permissions — see
[Architecture > Security model](../architecture.md#security-model).

## Relay configuration

Set `BUZZ_RELAY_URL` to point to your relay:

```bash
# Production relay
BUZZ_RELAY_URL=wss://buzz.happyvertical.com

# Local development relay (if running one yourself)
BUZZ_RELAY_URL=ws://localhost:3000
```

The relay URL is passed to `buzz-acp` by `buzz-agent-prime serve`. Only one
relay URL is supported in v0.1.

## Verifying the identity

After deployment, verify the agent is connected and responding:

```bash
# Docker
docker exec -it buzz-agent-prime buzz-agent-prime doctor
docker logs buzz-agent-prime 2>&1 | head -20

# Kubernetes
kubectl exec deployment/buzz-agent-prime -- buzz-agent-prime doctor
kubectl logs deployment/buzz-agent-prime --tail=20
```

Look for a log line indicating a successful relay connection. Then send a
message from a Buzz channel where your agent is authorized to respond.
