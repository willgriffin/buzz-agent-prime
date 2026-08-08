# Public Contracts

This document is the authority for the public command-line and environment
interfaces of `buzz-agent-prime` v0.1. Implementation issues must not change
these contracts without updating this document.

## Commands

The binary `buzz-agent-prime` exposes exactly four commands in v0.1:

| Command   | Status (v0.1) | Behaviour                                                                                                                                                                                        |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acp`     | issue #3      | Speak ACP v2 NDJSON over stdin/stdout, one isolated `prime-agent --mode acp` subprocess per outer `session/new`. Strict stdout discipline: only ACP frames on stdout; all diagnostics on stderr. |
| `serve`   | issue #4      | Launch `buzz-acp` with `buzz-agent-prime acp` as the agent command; supervise the process tree; durable session routing under the state directory.                                               |
| `doctor`  | issue #4      | Non-destructive environment diagnostics (binaries, versions, state-directory writability, required configuration). Must never print secrets.                                                     |
| `version` | implemented   | Print the installed package version and exit 0.                                                                                                                                                  |

### Exit codes

- `0` success
- `1` expected failure (command-specific)
- `2` CLI usage error (unknown command / bad arguments)
- `3`+ reserved for runtime failures (documented per command as implemented)

### stdout discipline

`acp` must write **only** ACP NDJSON frames to stdout. Anything else (logs,
metrics, warnings) goes to stderr. Malformed or oversized inbound frames must
fail without corrupting the stdout stream.

## Environment variables

### buzz-agent-prime runtime

| Variable                         | Default                     | Owner | Meaning                                                                                      |
| -------------------------------- | --------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `BUZZ_AGENT_PRIME_MAX_SESSIONS`  | `4`                         | #3    | Maximum concurrent outer ACP sessions.                                                       |
| `BUZZ_AGENT_PRIME_STATE_DIR`     | `/var/lib/buzz-agent-prime` | #4    | Persistent Prime configuration, sessions, kernel state, artifacts, and repository checkouts. |
| `BUZZ_AGENT_PRIME_WORKSPACE_DIR` | `<state>/workspace`         | #4    | Default working directory for spawned sessions.                                              |
| `BUZZ_AGENT_PRIME_TMP_DIR`       | `<state>/tmp`               | #4    | Writable scratch space inside the container.                                                 |

### buzz-acp harness (pass-through from `serve`)

`serve` forwards the Buzz relay connection to `buzz-acp` and the ACP children:

| Variable                      | Default               | Meaning                                            |
| ----------------------------- | --------------------- | -------------------------------------------------- |
| `BUZZ_RELAY_URL`              | `ws://localhost:3000` | Relay WebSocket URL.                               |
| `BUZZ_PRIVATE_KEY`            | —                     | Agent Nostr identity (nsec or hex).                |
| `BUZZ_ACP_AGENT_COMMAND`      | `buzz-agent-prime`    | Agent binary spawned by buzz-acp (set by `serve`). |
| `BUZZ_ACP_AGENT_ARGS`         | `acp`                 | Agent arguments (comma-separated; set by `serve`). |
| `BUZZ_ACP_RESPOND_TO`         | `owner-only`          | Inbound author gate.                               |
| `BUZZ_ACP_HEARTBEAT_INTERVAL` | `0`                   | Heartbeat disabled by default.                     |

## Configuration files

v0.1 ships no configuration file format; configuration is environment-only.
This avoids a config schema lock-in before `serve`/`doctor` mature.

## Compatibility guarantee

Contract changes require a minor-version bump and a documented migration path.
See `docs/compatibility.md` for upstream pins and the compatibility matrix.
