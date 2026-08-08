/**
 * One-shot probe of the pinned `prime-agent` executable.
 *
 * Runs during the outer `initialize` request so the multiplexer can (a) fail
 * fast when the pinned Prime executable is missing or broken, and (b) preserve
 * Prime's capabilities and namespaced `_meta` metadata in its own
 * `initialize` response. The probe process is short-lived: initialize, read,
 * close stdin, reap.
 */

import { ChildLink } from "./child-link.js";

/** Default ceiling for the probe (spawn + initialize response). */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
/** How long to wait for the probe process to exit after stdin closes. */
const PROBE_EXIT_GRACE_MS = 5_000;

/** Capabilities and metadata captured from the pinned Prime executable. */
export interface PrimeProbeResult {
  /** Protocol version Prime reported in its initialize response. */
  protocolVersion: number | string | undefined;
  /** Prime's `agentCapabilities` from its initialize response. */
  capabilities: Record<string, unknown>;
  /** Prime's `agentInfo` from its initialize response. */
  info: Record<string, unknown>;
  /** Prime's namespaced `_meta` from its initialize response. */
  meta: Record<string, unknown>;
}

export interface PrimeProbeOptions {
  /** Executable to probe (defaults to the `acp` prime binary). */
  primeBin: string;
  /** Client info we present to Prime while probing. */
  clientInfo: { name: string; version: string };
  /** Working directory for the probe process. */
  cwd: string;
  /** Overall timeout for probe completion, in milliseconds. */
  timeoutMs?: number | undefined;
  /** Receives stderr diagnostics from the probe process. */
  onStderr?: ((chunk: string) => void) | undefined;
  /** Extra environment entries for the probe process. */
  env?: Record<string, string> | undefined;
}

/**
 * Spawn the pinned Prime executable in ACP mode, negotiate `initialize`, and
 * return its capabilities and namespaced metadata.
 *
 * Throws if Prime cannot be spawned, fails to answer `initialize` in time,
 * speaks a different protocol version, or refuses the handshake.
 */
export async function probePrimeAgent(options: PrimeProbeOptions): Promise<PrimeProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const link = new ChildLink({
    command: options.primeBin,
    args: ["--mode", "acp"],
    cwd: options.cwd,
    onStderr: options.onStderr,
    env: options.env,
  });

  let result: PrimeProbeResult;
  try {
    // We propose v2; the pinned Prime build may report a different version,
    // which we capture rather than reject (see parseInitializeResult).
    const raw = await link.request(
      "initialize",
      {
        protocolVersion: 2,
        info: options.clientInfo,
        capabilities: {},
      },
      { timeoutMs },
    );
    result = parseInitializeResult(raw, options.primeBin);
  } finally {
    // End the connection; the agent exits when stdin closes.
    link.closeStdin();
    await link.waitForExit(PROBE_EXIT_GRACE_MS);
    if (!link.exited) {
      link.killGroup("SIGKILL");
      await link.waitForExit(PROBE_EXIT_GRACE_MS);
    }
  }
  return result;
}

function parseInitializeResult(raw: unknown, primeBin: string): PrimeProbeResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`prime-agent (${primeBin}) returned a non-object initialize result`);
  }
  const record = raw as Record<string, unknown>;
  const protocolVersion =
    typeof record.protocolVersion === "number" || typeof record.protocolVersion === "string"
      ? (record.protocolVersion as number | string)
      : undefined;
  const capabilities = isRecord(record.capabilities) ? record.capabilities : {};
  const info = isRecord(record.info) ? record.info : {};
  const meta = isRecord(record._meta) ? record._meta : {};
  return { protocolVersion, capabilities, info, meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
