import type { StatePaths } from "./paths.js";

/* ---------- Defaults (see docs/contracts.md) ---------- */

export const DEFAULT_BUZZ_RELAY_URL = "ws://localhost:3000";
export const DEFAULT_BUZZ_ACP_RESPOND_TO = "owner-only";
export const DEFAULT_BUZZ_ACP_HEARTBEAT_INTERVAL = "0";
export const DEFAULT_MAX_SESSIONS = 4;

/** Agent binary and arguments that serve sets for buzz-acp. */
export const AGENT_COMMAND = "buzz-agent-prime";
export const AGENT_ARG = "acp";

/* ---------- Config types ---------- */

/** Resolved configuration for the `serve` command. */
export interface ServeConfig {
  relayUrl: string;
  /** Agent Nostr identity (nsec or hex). Sensitive — never printed. */
  privateKey: string | undefined;
  agentCommand: string;
  agentArgs: string;
  respondTo: string;
  heartbeatInterval: string;
  maxSessions: number;
}

/* ---------- Resolution ---------- */

function num(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Resolve serve configuration from the environment, applying defaults. */
export function resolveServeConfig(env: NodeJS.ProcessEnv = process.env): ServeConfig {
  return {
    relayUrl: env["BUZZ_RELAY_URL"] ?? DEFAULT_BUZZ_RELAY_URL,
    privateKey: env["BUZZ_PRIVATE_KEY"],
    agentCommand: env["BUZZ_ACP_AGENT_COMMAND"] ?? AGENT_COMMAND,
    agentArgs: env["BUZZ_ACP_AGENT_ARGS"] ?? AGENT_ARG,
    respondTo: env["BUZZ_ACP_RESPOND_TO"] ?? DEFAULT_BUZZ_ACP_RESPOND_TO,
    heartbeatInterval: env["BUZZ_ACP_HEARTBEAT_INTERVAL"] ?? DEFAULT_BUZZ_ACP_HEARTBEAT_INTERVAL,
    maxSessions: num(env["BUZZ_AGENT_PRIME_MAX_SESSIONS"], DEFAULT_MAX_SESSIONS),
  };
}

/**
 * Build the environment object to pass to the `buzz-acp` child process.
 *
 * Caller-provided env (defaults to `process.env`) is inherited, then the
 * harness env vars are applied with serve's defaults so buzz-acp always
 * receives a complete configuration.
 */
export function buildBuzzAcpEnv(
  config: ServeConfig,
  _statePaths: StatePaths,
  inherit: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherit };
  env["BUZZ_RELAY_URL"] = config.relayUrl;
  if (config.privateKey) {
    env["BUZZ_PRIVATE_KEY"] = config.privateKey;
  }
  env["BUZZ_ACP_AGENT_COMMAND"] = config.agentCommand;
  env["BUZZ_ACP_AGENT_ARGS"] = config.agentArgs;
  env["BUZZ_ACP_RESPOND_TO"] = config.respondTo;
  env["BUZZ_ACP_HEARTBEAT_INTERVAL"] = config.heartbeatInterval;
  return env;
}
