/**
 * `buzz-agent-prime acp` — the ACP v2 session multiplexer.
 *
 * Speaks ACP v2 NDJSON over stdin/stdout with strict stdout discipline: only
 * ACP frames reach stdout, every diagnostic goes to stderr. Each outer
 * `session/new` launches an isolated `prime-agent --mode acp` subprocess in
 * the requested working directory, bounded by
 * `BUZZ_AGENT_PRIME_MAX_SESSIONS` (default 4).
 */

import { createRequire } from "node:module";
import { LineDecoder } from "./frame-codec.js";
import { FrameWriter, Logger } from "./io.js";
import { parseFrame } from "./jsonrpc.js";
import { AcpMultiplexer } from "./multiplexer.js";
import { JSONRPC_ERROR, jsonRpcError } from "./protocol.js";

/** Environment variable overrides (see docs/contracts.md, issue #3). */
const ENV = {
  maxSessions: "BUZZ_AGENT_PRIME_MAX_SESSIONS",
  primeBin: "BUZZ_AGENT_PRIME_PRIME_BIN",
  workspaceDir: "BUZZ_AGENT_PRIME_WORKSPACE_DIR",
} as const;

export interface AcpCommandOptions {
  /** Input stream (defaults to process.stdin). */
  input?: NodeJS.ReadableStream;
  /** Output stream (defaults to process.stdout). */
  output?: NodeJS.WritableStream;
  /** prime-agent executable (defaults to $BUZZ_AGENT_PRIME_PRIME_BIN or "prime-agent"). */
  primeBin?: string;
  /** Maximum concurrent sessions (defaults to $BUZZ_AGENT_PRIME_MAX_SESSIONS or 4). */
  maxSessions?: number;
  /** Default working directory for sessions that omit cwd. */
  defaultCwd?: string;
  /** Install SIGINT/SIGTERM handlers (defaults to true; disable in tests). */
  installSignalHandlers?: boolean;
  probeTimeoutMs?: number | undefined;
  childInitTimeoutMs?: number | undefined;
  childCloseTimeoutMs?: number | undefined;
  /** Maximum inbound frame size in bytes (test/tuning knob). */
  maxFrameBytes?: number | undefined;
  logger?: Logger | undefined;
}

/**
 * Run the ACP multiplexer until the client disconnects (stdin EOF) or a
 * shutdown signal arrives, then reap every child and resolve with the process
 * exit code.
 */
export async function runAcpCommand(options: AcpCommandOptions = {}): Promise<number> {
  const logger = options.logger ?? new Logger();

  const maxSessions = resolveMaxSessions(options.maxSessions, logger);
  if (maxSessions === undefined) return 1;

  const primeBin = options.primeBin ?? process.env[ENV.primeBin] ?? "prime-agent";
  const defaultCwd = options.defaultCwd ?? process.env[ENV.workspaceDir] ?? process.cwd();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const writer = new FrameWriter(output);
  const multiplexer = new AcpMultiplexer({
    writer,
    logger,
    primeBin,
    clientInfo: { name: "buzz-agent-prime", version: packageVersion() },
    maxSessions,
    defaultCwd,
    probeTimeoutMs: options.probeTimeoutMs,
    childInitTimeoutMs: options.childInitTimeoutMs,
    childCloseTimeoutMs: options.childCloseTimeoutMs,
  });

  logger.info(
    `acp multiplexer ready (prime ${primeBin}, maxSessions ${maxSessions}, defaultCwd ${defaultCwd})`,
  );

  const decoder = new LineDecoder(options.maxFrameBytes);
  let resolveFinished!: () => void;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${reason})`);
    await multiplexer.shutdown();
    resolveFinished();
  };

  input.on("data", (chunk: string | Uint8Array) => {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    for (const event of decoder.push(bytes)) {
      if (event.type === "tooLarge") {
        logger.error(
          `inbound frame of ${event.bytes} bytes exceeds ${event.limit} byte limit; rejecting`,
        );
        void writer
          .write({
            jsonrpc: "2.0",
            id: null,
            error: jsonRpcError(
              JSONRPC_ERROR.parseError,
              `Parse error: frame exceeds maximum size of ${event.limit} bytes`,
              { frameBytes: event.bytes, limit: event.limit },
            ),
          })
          .catch(() => undefined);
        continue;
      }
      if (event.text.trim().length === 0) continue;
      const outcome = parseFrame(event.text);
      if (outcome.kind === "invalid") {
        void writer.write(outcome.response).catch(() => undefined);
        continue;
      }
      void multiplexer.handleMessage(outcome.message).catch((error) => {
        logger.error(`failed to handle inbound message: ${String(error)}`);
      });
    }
  });

  input.on("end", () => {
    void shutdown("client disconnected (stdin EOF)");
  });
  input.on("close", () => {
    void shutdown("input stream closed");
  });
  input.on("error", (error) => {
    logger.error(`input stream error: ${String(error)}`);
    void shutdown("input stream error");
  });

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  if (options.installSignalHandlers !== false) {
    for (const signal of signals) {
      const handler = () => {
        void shutdown(`received ${signal}`);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  try {
    await finishedPromise;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
  return 0;
}

function resolveMaxSessions(explicit: number | undefined, logger: Logger): number | undefined {
  const raw = explicit ?? process.env[ENV.maxSessions] ?? "4";
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    logger.error(`invalid ${ENV.maxSessions}: expected a positive integer, got "${String(raw)}"`);
    return undefined;
  }
  return parsed;
}

function packageVersion(): string {
  try {
    // Resolved relative to the compiled module (dist/acp/ -> package.json).
    const require = createRequire(import.meta.url);
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
