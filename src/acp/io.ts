/**
 * Strict stdout discipline for the `acp` command.
 *
 * Only ACP NDJSON frames may reach stdout; every diagnostic goes to stderr.
 * `FrameWriter` serializes writes so frames never interleave, and `Logger`
 * routes diagnostics to stderr only.
 */

import type { JsonRpcMessage } from "./protocol.js";

/** A serialized NDJSON writer that owns a single output stream. */
export class FrameWriter {
  #output: NodeJS.WritableStream;
  #queue: Promise<void> = Promise.resolve();

  constructor(output: NodeJS.WritableStream) {
    this.#output = output;
  }

  /** Enqueue one JSON-RPC message as a single newline-terminated frame. */
  write(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    // Preserve ordering: chain onto the previous write regardless of
    // backpressure, and resolve when this frame has been flushed to the
    // underlying stream. A failed write must never reject the shared queue,
    // or every later frame would be dropped with an unhandled rejection.
    this.#queue = this.#queue
      .then(async () => {
        const flushed = this.#output.write(line);
        if (flushed === false) {
          await new Promise<void>((resolve) => this.#output.once("drain", resolve));
        }
      })
      .catch(() => undefined);
    return this.#queue;
  }

  /** Wait for every enqueued frame to be flushed. */
  async drain(): Promise<void> {
    await this.#queue;
  }

  /** Whether the underlying stream has been destroyed/closed. */
  get closed(): boolean {
    return typeof (this.#output as { destroyed?: boolean }).destroyed === "boolean"
      ? (this.#output as { destroyed?: boolean }).destroyed === true
      : false;
  }
}

/**
 * Diagnostics logger. Writes only to stderr — never stdout — so the ACP
 * stream cannot be corrupted by logging.
 */
export class Logger {
  #enabled: boolean;

  constructor(enabled = true) {
    this.#enabled = enabled;
  }

  /** Write a diagnostic line to stderr. */
  error(message: string, ...details: unknown[]): void {
    if (!this.#enabled) return;
    const suffix = details.length > 0 ? ` ${details.map((d) => stringifyDetail(d)).join(" ")}` : "";
    process.stderr.write(`buzz-agent-prime acp: ${message}${suffix}\n`);
  }

  /** Write an informational line to stderr. */
  info(message: string): void {
    if (!this.#enabled) return;
    process.stderr.write(`buzz-agent-prime acp: ${message}\n`);
  }
}

function stringifyDetail(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
