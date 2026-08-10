# PR-thread command

`buzz-agent-prime pr-thread` reads one complete Buzz pull-request conversation
directly from a relay. It authenticates with NIP-42 using the agent identity,
then verifies every emitted Nostr event and applies PR author/repository-owner
authority rules to lifecycle events before emitting results.

## Invocation

Pass exactly one event id: 64 hexadecimal characters, using any one form.

```bash
buzz-agent-prime pr-thread <64-hex-event-id>
buzz-agent-prime pr-thread --event <64-hex-event-id>
buzz-agent-prime pr-thread --event=<64-hex-event-id>
```

Missing, duplicate, or malformed ids fail before a relay connection is made.

## Configuration and authentication

Programmatic caller options override environment variables. The command then
uses `BUZZ_RELAY_URL`, falling back to `ws://localhost:3000`, and requires
`BUZZ_PRIVATE_KEY` (nsec or hexadecimal) for NIP-42 authentication. The key is
never written to stdout or stderr. `http://` and `https://` relay origins are
normalized to `ws://` and `wss://`; WebSocket origins are accepted as-is. A
relay URL must be a bare origin: user info, paths other than `/`, queries, and
fragments are rejected. Use `wss://` (or `https://`) for production relays;
unencrypted `ws://` remains supported for local loopback development.

## Output and trust boundary

Each verified root, update, comment/review, and status event is emitted as one
terminal-safe JSON object per stdout line in chronological order. Progress,
counts, and errors are written to stderr; untrusted error text is
control-character stripped, credential-redacted, and length-bounded.

The reader does not treat every relay event as authoritative: malformed or
invalidly signed events, unrelated events, and unauthorized updates or statuses
are excluded. Only the verified PR author or repository owner can supply an
update or status. Directly linked, signature-verified kind-1 and kind-1111
comments from arbitrary authors are included as conversation context, but do
not carry lifecycle or review authority. Repository maintainer membership is
not resolved by this command.

Completeness is bounded by the command's relay result limit and depends on the
configured relay honestly returning its complete result. This command does not
cross-check other relays or prove global conversation completeness.
