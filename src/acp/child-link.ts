/**
 * A bounded JSON-RPC link to one child process speaking ACP over stdio.
 *
 * Used for both the one-shot `initialize` probe and each isolated
 * `prime-agent --mode acp` session subprocess. The child is spawned detached
 * (its own process group) so IPython kernels, RLM subagents, and other
 * descendants can be terminated and reaped as a group on close and shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { LineDecoder } from "./frame-codec.js";
import {
  JSONRPC_ERROR,
  PROTOCOL_METHODS,
  isErrorObject,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  jsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./protocol.js";

/** Error raised when the child answers a request with a JSON-RPC error. */
export class ChildRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ChildRpcError";
    this.code = code;
    this.data = data;
  }

  /** Rebuild from a JSON-RPC error object. */
  static from(error: { code: number; message: string; data?: unknown }): ChildRpcError {
    return new ChildRpcError(error.code, error.message, error.data);
  }
}

/** Error raised when the child dies (or is killed) before answering. */
export class ChildExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null, detail?: string) {
    super(detail ?? `child process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    this.name = "ChildExitedError";
    this.code = code;
    this.signal = signal;
  }
}

/** Options for a {@link ChildLink}. */
export interface ChildLinkOptions {
  /** Executable to spawn (absolute path or resolved from PATH). */
  command: string;
  args: string[];
  /** Working directory for the child. */
  cwd: string;
  /** Extra environment entries merged over the parent environment. */
  env?: Record<string, string> | undefined;
  /** Called for every notification the child sends. */
  onNotification?: ((notification: JsonRpcNotification) => void) | undefined;
  /** Called for every request the child initiates (client-directed). */
  onRequest?: ((request: JsonRpcRequest) => void) | undefined;
  /** Called when the child process exits. */
  onExit?: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  /** Called with decoded stderr chunks from the child. */
  onStderr?: ((chunk: string) => void) | undefined;
  /** Called when a malformed or oversized frame arrives from the child. */
  onProtocolViolation?: ((kind: "malformed" | "tooLarge", detail: string) => void) | undefined;
  /** Spawn timeout for the process (milliseconds; 0 disables). */
  spawnTimeoutMs?: number | undefined;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A single in-flight request to the child. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

/**
 * One child process plus its NDJSON conversation.
 *
 * `request()` serializes JSON-RPC requests through monotonically increasing
 * numeric ids and matches responses by id. Notifications are handed to
 * `onNotification`; requests initiated by the child are handed to
 * `onRequest` for the caller to forward and answer.
 */
export class ChildLink {
  readonly child: ChildProcess;
  readonly #decoder = new LineDecoder();
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #onNotification?: ChildLinkOptions["onNotification"];
  readonly #onRequest?: ChildLinkOptions["onRequest"];
  readonly #onExit?: ChildLinkOptions["onExit"];
  readonly #onStderr?: ChildLinkOptions["onStderr"];
  readonly #onProtocolViolation?: ChildLinkOptions["onProtocolViolation"];
  #nextId = 1;
  #exit: ExitInfo | undefined;
  #exitPromise: Promise<ExitInfo>;
  #resolveExit!: (info: ExitInfo) => void;

  constructor(options: ChildLinkOptions) {
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onExit = options.onExit;
    this.#onStderr = options.onStderr;
    this.#onProtocolViolation = options.onProtocolViolation;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });

    const spawnTimer =
      options.spawnTimeoutMs && options.spawnTimeoutMs > 0
        ? setTimeout(() => {
            if (this.#exit) return;
            this.#failAll(
              new Error(`child process failed to spawn within ${options.spawnTimeoutMs}ms`),
            );
            this.killGroup("SIGKILL");
          }, options.spawnTimeoutMs)
        : undefined;

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.#onStdoutChunk(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.#onStderr?.(chunk);
    });
    this.child.on("error", (error) => {
      if (spawnTimer) clearTimeout(spawnTimer);
      // Spawn failures (ENOENT, EACCES) surface here; the process never ran.
      this.#failAll(
        new ChildExitedError(null, null, `failed to spawn child process: ${error.message}`),
      );
      this.#finishExit({ code: null, signal: null });
    });
    this.child.on("exit", (code, signal) => {
      if (spawnTimer) clearTimeout(spawnTimer);
      const info: ExitInfo = { code, signal };
      this.#finishExit(info);
      const reason = new ChildExitedError(code, signal);
      this.#failAll(reason);
      this.#onExit?.(code, signal);
    });
    this.child.on("close", () => {
      this.#resolveExit(this.#exit ?? { code: null, signal: null });
    });
  }

  /** Send a request and await the child's response. */
  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.#exit) {
      return Promise.reject(new ChildExitedError(this.#exit.code, this.#exit.signal));
    }
    const id = this.#nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | undefined, result?: unknown) => {
        if (settled) return;
        settled = true;
        const pending = this.#pending.get(id);
        if (pending?.timer) clearTimeout(pending.timer);
        this.#pending.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => {
        void this.notify(PROTOCOL_METHODS.cancelRequest, { requestId: id }).catch(() => undefined);
        settle(
          new ChildRpcError(JSONRPC_ERROR.requestCancelled, "Request cancelled", { requestId: id }),
        );
      };
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => {
              settle(new Error(`${method} timed out after ${options.timeoutMs}ms`));
            }, options.timeoutMs)
          : undefined;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (result: unknown) => settle(undefined, result),
        reject: (error: Error) => settle(error),
        timer,
      });
      this.child.stdin?.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          settle(
            new ChildExitedError(null, null, `failed to write to child stdin: ${error.message}`),
          );
        }
      });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: unknown): Promise<void> {
    if (this.#exit) {
      return Promise.reject(new ChildExitedError(this.#exit.code, this.#exit.signal));
    }
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    return new Promise((resolve, reject) => {
      this.child.stdin?.write(`${JSON.stringify(notification)}\n`, (error) => {
        if (error) reject(new ChildExitedError(null, null, error.message));
        else resolve();
      });
    });
  }

  /** Write a response back to a request the child initiated. */
  respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.#writeMessage({ jsonrpc: "2.0", id, result });
  }

  /** Write an error response back to a request the child initiated. */
  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    return this.#writeMessage({
      jsonrpc: "2.0",
      id,
      error: jsonRpcError(code, message, data),
    });
  }

  /** Close the child's stdin (the ACP end-of-connection signal). */
  closeStdin(): void {
    this.child.stdin?.end();
  }

  /** Wait for the child to exit, up to `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<ExitInfo> {
    if (this.#exit) return this.#exit;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ExitInfo>((resolve) => {
      timer = setTimeout(() => resolve(this.#exit ?? { code: null, signal: null }), timeoutMs);
    });
    const result = await Promise.race([this.#exitPromise, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** Terminate the child's process group (SIGTERM by default). */
  killGroup(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.#exit) return;
    try {
      if (process.platform === "win32") {
        this.child.kill(signal);
      } else if (this.child.pid !== undefined) {
        process.kill(-this.child.pid, signal);
      }
    } catch {
      // ESRCH: already gone; nothing to reap.
    }
  }

  /** The child's pid, when it is running. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  #onStdoutChunk(chunk: string): void {
    let events;
    try {
      events = this.#decoder.push(new TextEncoder().encode(chunk));
    } catch (error) {
      this.#onProtocolViolation?.(
        "malformed",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    for (const event of events) {
      if (event.type === "tooLarge") {
        this.#onProtocolViolation?.(
          "tooLarge",
          `frame of ${event.bytes} bytes exceeds ${event.limit} byte limit`,
        );
        continue;
      }
      this.#handleFrame(event.text);
    }
  }

  #handleFrame(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.#onProtocolViolation?.("malformed", "non-JSON line on child stdout");
      return;
    }
    if (isResponseMessage(value)) {
      const pending = this.#pending.get(value.id);
      if (!pending) {
        // A late response after cancellation/timeout: drop silently.
        return;
      }
      this.#pending.delete(value.id);
      if (pending.timer) clearTimeout(pending.timer);
      if ("result" in value) {
        pending.resolve(value.result);
      } else if (isErrorObject(value.error)) {
        pending.reject(ChildRpcError.from(value.error));
      } else {
        pending.reject(new Error("malformed error response from child"));
      }
      return;
    }
    if (isRequestMessage(value)) {
      this.#onRequest?.(value);
      return;
    }
    if (isNotificationMessage(value)) {
      this.#onNotification?.(value);
      return;
    }
    this.#onProtocolViolation?.("malformed", "unrecognized JSON-RPC message on child stdout");
  }

  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #finishExit(info: ExitInfo): void {
    if (this.#exit) return;
    this.#exit = info;
    this.#resolveExit(info);
  }

  #writeMessage(message: JsonRpcMessage): Promise<void> {
    if (this.#exit) {
      return Promise.reject(new ChildExitedError(this.#exit.code, this.#exit.signal));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new ChildExitedError(null, null, error.message));
        else resolve();
      });
    });
  }
}
