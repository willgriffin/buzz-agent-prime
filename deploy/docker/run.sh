#!/bin/sh
# docker run — minimal Buzz agent quickstart
#
# Prerequisites:
#   BUZZ_PRIVATE_KEY=nsec1... (or hex key) — agent identity
#   OPENAI_API_KEY=sk-... (or other provider key)
#
# The agent identity must be a registered relay member on the target relay.

set -eu

: "${BUZZ_PRIVATE_KEY:?BUZZ_PRIVATE_KEY is required}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

docker run --rm --init \
  --read-only \
  --tmpfs /tmp:exec,size=256M \
  --volume buzz-agent-prime-state:/var/lib/buzz-agent-prime \
  --volume buzz-agent-prime-workspace:/workspace \
  --env BUZZ_PRIVATE_KEY \
  --env OPENAI_API_KEY \
  --env BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-wss://buzz.happyvertical.com}" \
  --env BUZZ_AGENT_PRIME_MAX_SESSIONS="${BUZZ_AGENT_PRIME_MAX_SESSIONS:-4}" \
  ghcr.io/willgriffin/buzz-agent-prime:0.1.0 \
  "$@"
