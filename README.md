# buzz-agent-prime

Run [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) as a
persistent, [Buzz](https://github.com/block/buzz)-native agent for Docker and
Kubernetes.

```text
Buzz relay
  → buzz-acp
    → buzz-agent-prime ACP multiplexer
      → prime-agent --mode acp
        → IPython and local RLM subagents
```

Prime's native ACP mode supports one session per process, while `buzz-acp`
retains sessions for multiple channels. `buzz-agent-prime` multiplexes outer
ACP sessions onto isolated Prime ACP subprocesses — no Prime fork, no RPC
translation.

## Status

v0.1 in progress. Tracked in Buzz (canonical); GitHub is the public mirror and
issue tracker.

- [Epic — Ship buzz-agent-prime v0.1](https://github.com/willgriffin/buzz-agent-prime/issues/1)
- [Public contracts](docs/contracts.md)
- [Upstream pins and compatibility](docs/compatibility.md)
- [Directory ownership for parallel work](docs/directories.md)

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Read a PR thread

`pr-thread` reads a complete, verification-filtered Buzz PR conversation from
the configured relay and writes its chronological events as NDJSON to stdout.
Diagnostics and the event count go to stderr, so stdout can be piped safely.

```bash
buzz-agent-prime pr-thread <64-hex-event-id>
buzz-agent-prime pr-thread --event <64-hex-event-id>
buzz-agent-prime pr-thread --event=<64-hex-event-id>
```

The command uses an explicit caller option first, then `BUZZ_RELAY_URL` and
`BUZZ_PRIVATE_KEY`; the relay URL otherwise defaults to `ws://localhost:3000`.
HTTP(S) relay origins are converted to WebSocket origins; user info, paths,
queries, and fragments are rejected. Use `wss://` (or `https://`) for
production relays; unencrypted `ws://` remains supported for local loopback
development. The private key is used only for NIP-42 authentication and is
never printed. See
[the PR-thread reference](docs/pr-thread.md) for lifecycle-authority and
output details.
