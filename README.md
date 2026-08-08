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
