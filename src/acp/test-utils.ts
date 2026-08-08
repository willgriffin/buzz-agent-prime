/**
 * Test harness for the ACP multiplexer.
 *
 * Runs `runAcpCommand` in-process with injected PassThrough streams so tests
 * can drive the outer ACP conversation exactly like buzz-acp would, and can
 * assert on every frame the multiplexer writes to stdout. Frames are consumed
 * in arrival order (FIFO with a predicate), so reused request ids and
 * interleaved notifications never cross wires between assertions.
 */

import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { runAcpCommand, type AcpCommandOptions } from "./index.js";

/** Absolute path to the fake prime-agent fixture. */
export const FAKE_AGENT = fileURLToPath(
  new URL("./__fixtures__/fake-acp-agent.mjs", import.meta.url),
);

/** A JSON-RPC frame received from the multiplexer. */
export type Frame = Record<string, unknown>;

export interface AcpHarmess {
  send(message: unknown): void;
  sendRaw(text: string): void;
  nextFrame(predicate?: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  frames(): Frame[];
  done: Promise<number>;
  close(): Promise<number>;
}

export interface HarnessOptions {
  maxSessions?: number;
  primeBin?: string;
  env?: Record<string, string>;
  maxFrameBytes?: number;
  runOptions?: Partial<AcpCommandOptions>;
}

export function startAcp(options: HarnessOptions = {}): AcpHarmess {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  const consumed: boolean[] = [];
  const waiters: {
    predicate: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  let buffer = "";

  function tryMatchFrom(start: number): number {
    for (let i = start; i < frames.length; i++) {
      if (consumed[i]) continue;
      return i;
    }
    return -1;
  }

  function checkWaiters(): void {
    for (let w = 0; w < waiters.length; w++) {
      const waiter = waiters[w]!;
      // Find the first unconsumed frame that matches this waiter's predicate.
      const matchIndex = frames.findIndex((f, i) => !consumed[i] && waiter.predicate(f));
      if (matchIndex !== -1) {
        consumed[matchIndex] = true;
        waiters.splice(w, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frames[matchIndex]!);
        w--;
      }
    }
  }

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      consumed.push(false);
      checkWaiters();
    }
  });

  const done = runAcpCommand({
    input,
    output,
    installSignalHandlers: false,
    primeBin: options.primeBin ?? FAKE_AGENT,
    maxSessions: options.maxSessions ?? 4,
    defaultCwd: process.cwd(),
    probeTimeoutMs: 5_000,
    childInitTimeoutMs: 5_000,
    childCloseTimeoutMs: 2_000,
    maxFrameBytes: options.maxFrameBytes,
    ...options.runOptions,
  });

  return {
    send(message: unknown): void {
      input.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(text: string): void {
      input.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    nextFrame(
      predicate: (frame: Frame) => boolean = () => true,
      timeoutMs = 5_000,
    ): Promise<Frame> {
      const existing = tryMatchFrom(0);
      if (existing !== -1 && predicate(frames[existing]!)) {
        consumed[existing] = true;
        return Promise.resolve(frames[existing]!);
      }
      // Wait for a future frame (and also recheck all unconsumed ones, in case
      // this predicate matches an earlier one not yet consumed by anyone).
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === resolve);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error(`timed out waiting for frame after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
        checkWaiters();
      });
    },
    frames(): Frame[] {
      return [...frames];
    },
    done,
    async close(): Promise<number> {
      input.end();
      return done;
    },
  };
}

export function request(
  id: number | string,
  method: string,
  params?: unknown,
): Record<string, unknown> {
  const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  return message;
}

export function notification(method: string, params?: unknown): Record<string, unknown> {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  return message;
}

export function successResponse(id: number | string, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: number | string,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
