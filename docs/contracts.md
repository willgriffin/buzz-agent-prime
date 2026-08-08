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
| `BUZZ_AGENT_PRIME_PRIME_BIN`     | `prime-agent`               | #3    | Prime Agent executable path (not on the public npm registry; override per image).            |
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

## ACP multiplexer protocol contract (issue #3)

### `initialize`

The multiplexer probes the pinned Prime executable and returns a merged
`initialize` response that preserves Prime's capabilities and namespaced
`_meta` (under `ai.primeintellect.prime-agent`) and adds its own namespace
under `ai.buzz.buzz-agent-prime` with:

- `multiplexer: true`
- `upstream: { name: "prime-agent", version: <probed> }`

### `session/new`

- Capacity bound: `session/new` beyond `BUZZ_AGENT_PRIME_MAX_SESSIONS`
  returns JSON-RPC server error `-32000`, message `"Maximum concurrent
sessions reached"`, data `{ maxSessions, reason: "capacity" }`.
- Durable keys: `session/new` params `_meta.durableSessionKey` (string) are
  honoured. A duplicate **live** key is rejected with JSON-RPC `invalidParams`
  (`-32602`, data `{ durableSessionKey, reason: "duplicate_live_key" }`). The
  key is accepted again after the holding session closes or the child exits.
- Session isolation: each outer `session/new` launches an isolated
  `prime-agent --mode acp` subprocess in the requested `cwd`.
- `additionalDirectories` and `mcpServers` default to `[]` when omitted.

### Session errors and child exits

- A child crash or non-zero exit is forwarded as a
  `session_info_update` notification with `_meta` payload
  `{ sessionId, code, signal }` under the
  `ai.buzz.buzz-agent-prime` namespace key `childExited`.

### stdout discipline

Only ACP NDJSON frames reach stdout. All diagnostics, logs, and forwarded
child stderr (prefixed `[prime-agent:<sessionId>]`) go to stderr. Malformed
inbound frames emit a valid JSON-RPC error frame (id null) and continue.
Oversized frames are rejected and the stream resumes at the next newline.
