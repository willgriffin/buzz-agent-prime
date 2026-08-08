# Architecture

**Audience:** Contributors and operators who want to understand the
internal data flow and component boundaries of `buzz-agent-prime`.

For a quick operational overview, see [Deployment Guide](deployment/quickstart.md).

## System overview

```text
┌─────────────┐     WebSocket     ┌──────────────┐     stdio      ┌──────────────────────────────┐
│  Buzz relay │ ───────────────▶ │   buzz-acp   │ ──────────────▶│ buzz-agent-prime             │
│ (Nostr)     │ ◀─────────────── │ (ACP host)   │ ◀──────────────│ acp (ACP multiplexer)        │
└─────────────┘   inbound msg   └──────────────┘   ACP NDJSON  └──────────┬───────────────────┘
                                                                               │ session/new
                                    ┌──────────────────────────────────────────┘
                                    │  spawn one subprocess per outer session
                                    ▼
                              ┌──────────────────────┐
                              │ prime-agent --mode   │
                              │ acp (per session)    │
                              └────────┬─────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ IPython kernel    │
                              │ + local RLM       │
                              │   subagents       │
                              └──────────────────┘
```

## Component responsibilities

### Buzz relay

The relay is the Nostr message bus. Buzz channels (conversations) are
addressed by Nostr event identifiers. The relay forwards inbound messages to
connected agents and relays their responses back to channel participants.
`buzz-agent-prime` does not connect to the relay directly — `buzz-acp` owns
that connection.

### buzz-acp

`buzz-acp` (built from `block/buzz` crate `buzz-acp`) is the ACP host
process. It maintains the relay WebSocket, translates between Nostr messages
and [ACP v2](https://github.com/AcpStat) NDJSON frames, and retains session
state across multiple channels so that a single long-lived process can serve
many conversations.

`buzz-agent-prime serve` launches `buzz-acp` with `buzz-agent-prime acp`
configured as the agent command (`BUZZ_ACP_AGENT_COMMAND` /
`BUZZ_ACP_AGENT_ARGS`). The connection to the relay and inbound author gating
(`BUZZ_ACP_RESPOND_TO`) are `buzz-acp` concerns, not multiplexer concerns.

### buzz-agent-prime `acp` (ACP multiplexer)

The `acp` command is the core of the project. It reads ACP v2 NDJSON frames
from stdin and writes ACP v2 NDJSON frames to stdout — nothing else.

**Multiplexing model:** `buzz-acp` sends ACP session lifecycle events over a
single pipe. When `buzz-agent-prime` receives an outer `session/new`, it
spawns an isolated `prime-agent --mode acp` subprocess for that session. All
subsequent frames for that session are routed to the same subprocess. When
the session ends, the subprocess is terminated.

**Session routing:**

| Session has `_meta.sessionTitle`? | Behaviour                                      |
| --------------------------------- | ---------------------------------------------- |
| Yes (named channel)               | Persistent: state is kept across restarts.     |
| No                                | Ephemeral: a new session is created each time. |

Named-channel persistence relies on the state directory
(`BUZZ_AGENT_PRIME_STATE_DIR`). When a named session ends or the process
restarts, its kernel state and artifacts are preserved so the same channel
can resume. Sessions without `_meta.sessionTitle` get an ephemeral session ID
that is not durable — if the multiplexer restarts, that conversation starts
fresh.

**stdout discipline:** Only ACP NDJSON frames are written to stdout. All
diagnostics, warnings, and metrics go to stderr. This contract is critical
because `buzz-acp` parses stdout as a structured stream; any non-ACP data
would break the protocol.

### prime-agent `--mode acp`

Prime Agent's native ACP mode speaks the ACP v2 protocol over stdin/stdout
but supports only one session per process. `buzz-agent-prime` does not fork
Prime or translate any frames — it simply spawns one Prime subprocess per
outer session and pipes frames through.

### IPython kernel and RLM subagents

Inside each Prime subprocess, the IPython kernel provides the persistent
Python REPL, and Prime's RLM (Runtime Lifecycle Manager) can spawn local
subagents. These subagents inherit the permissions and environment of the
Prime process, which in turn inherits the container user's permissions.

See [Security Model](#security-model) below.

## Process tree

```text
buzz-agent-prime serve
  └── buzz-acp (relay connection, session management)
        └── buzz-agent-prime acp (ACP multiplexer)
              ├── prime-agent --mode acp  (session A)
              │     └── ipython kernel
              │           └── (optional) rlm subagents
              ├── prime-agent --mode acp  (session B)
              │     └── ...
              └── ... (up to BUZZ_AGENT_PRIME_MAX_SESSIONS)
```

## State directory layout

The state directory (`BUZZ_AGENT_PRIME_STATE_DIR`, default
`/var/lib/buzz-agent-prime`) holds all persistent runtime state:

```text
/var/lib/buzz-agent-prime/
  workspace/      # Default working directory for spawned sessions
  tmp/            # Writable scratch space inside the container
  sessions/      # Named-channel session state and kernel checkpoints
  artifacts/      # Generated files, logs, and other outputs
  repos/          # Git checkouts managed by sessions
```

Subdirectories under `sessions/` are keyed by the session title from
`_meta.sessionTitle`. Ephemeral sessions (no title) are not persisted here.

## Security model

**Prime Agent and its subagents execute with the container user's
permissions. `buzz-agent-prime` is not a security sandbox.**

- Subagents spawned by Prime's RLM can run arbitrary shell commands, network
  requests, and file I/O within the container user's privilege scope.
- There is no multi-tenant isolation between channels: all sessions share the
  same container user and filesystem permissions.
- The state volume should be treated as sensitive — it contains session
  transcripts, kernel state, and potentially cloned repositories with embedded
  credentials.

**Deployment hardening:**

- Run with a non-root container user and a read-only root filesystem.
- Use Kubernetes `SecurityContext` or Docker `--read-only` with `--tmpfs`
  for writable scratch space.
- Never give the agent cluster-admin or broad Kubernetes API permissions.
- Store `BUZZ_PRIVATE_KEY` and model API keys via a secrets manager, not in
  manifests or image layers.

See [SECURITY.md](../SECURITY.md) for the full security policy.

## Upstream pins

`buzz-agent-prime` is built from immutable upstream pins so that image contents
and behaviour reproduce exactly. The full compatibility matrix is in
[compatibility.md](compatibility.md).

| Component   | Pin (v0.1)          |
| ----------- | ------------------- |
| prime-agent | v0.7.1 / `a18809e0` |
| buzz-acp    | `3a96acea` (0.5.3)  |
| Node.js     | 22                  |
| Python      | 3.12                |

## What buzz-agent-prime is not

- **Not a fork of Prime.** It wraps Prime's existing `--mode acp` without
  modifying Prime source.
- **Not an RPC translator.** ACP frames pass through; no protocol translation
  occurs between `buzz-acp` and `prime-agent`.
- **Not a security boundary.** Subagents share the container user's
  privileges; there is no sandboxing between sessions.
- **Not multi-tenant.** v0.1 assumes a single trusted operator per deployment;
  channels are not isolated from each other.
- **Not a distributed system.** v0.1 targets single-replica deployments only.
