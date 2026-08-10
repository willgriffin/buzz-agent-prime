/**
 * ACP client helper for spawning and communicating with the
 * `buzz-agent-prime acp` multiplexer subprocess.
 *
 * Provides a promise-based API for sending requests and collecting
 * responses/notifications over stdin/stdout NDJSON.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseFrame, isResult, isError, isNotification, type ParseResult } from "./ndjson.js";
import type {
  AcpFrame,
  JsonRpcError,
  JsonRpcResult,
  JsonRpcNotification,
  RequestId,
  InitializeResponseResult,
  NewSessionResponseResult,
} from "./types.js";

/**
 * Check whether the `buzz-agent-prime acp` command is implemented
 * (i.e., the core multiplexer from issue #3 has been merged).
 *
 * Returns `true` if the binary exists and `acp` produces a valid
 * JSON-RPC response on stdout after receiving `initialize`, `false` otherwise.
 */
export async function isAcpImplemented(worktreeDir: string): Promise<boolean> {
  const binInfo = resolveBinary(worktreeDir);

  return new Promise<boolean>((resolve) => {
    const child = spawn(binInfo.cmd, [...binInfo.args, "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: worktreeDir,
      env: { ...process.env },
    });

    let gotJsonRpc = false;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGKILL");
        resolve(false);
      }
    }, 4000);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.includes('"jsonrpc"') && !gotJsonRpc) {
        gotJsonRpc = true;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(true);
        }
      }
    });

    child.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });

    // Send an initialize frame
    const initFrame = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: "buzz-test-probe", version: "0.0.0" },
      },
    };
    try {
      child.stdin?.write(JSON.stringify(initFrame) + "\n");
    } catch {
      // stdin write failed — process probably already dead
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

interface BinaryInfo {
  cmd: string;
  args: string[];
}

function resolveBinary(worktreeDir: string): BinaryInfo {
  const distCli = path.join(worktreeDir, "dist", "cli.js");
  if (fs.existsSync(distCli)) {
    return { cmd: "node", args: [distCli] };
  }

  const srcCli = path.join(worktreeDir, "src", "cli.ts");
  if (fs.existsSync(srcCli)) {
    // Node 22+ supports --experimental-strip-types
    return { cmd: "node", args: ["--experimental-strip-types", srcCli] };
  }

  // Fallback — will fail, but caller handles that
  return { cmd: "node", args: [path.join(worktreeDir, "dist", "cli.js")] };
}

export interface AcpClientOptions {
  /** Worktree root directory. */
  worktreeDir: string;
  /** Environment variables to pass to the child (merge with process.env). */
  env?: Record<string, string>;
  /** Timeout for waiting on a response (ms), default 10000. */
  responseTimeoutMs?: number;
}

export interface CollectedFrame {
  frame: AcpFrame;
  raw: string;
}

/**
 * An ACP client that peers with the `buzz-agent-prime acp` subprocess.
 * Collects incoming frames and provides methods to send requests and
 * await responses by id.
 */
export class AcpClient {
  private readonly child: ChildProcess;
  private pending = "";
  private readonly collected: CollectedFrame[] = [];
  private nextId = 1;
  private exitCode: number | null = null;
  private readonly exitPromise: Promise<number>;
  private stderrText = "";
  private readonly responseTimeoutMs: number;

  constructor(opts: AcpClientOptions) {
    const binInfo = resolveBinary(opts.worktreeDir);

    this.responseTimeoutMs = opts.responseTimeoutMs ?? 10000;

    const childEnv: Record<string, string | undefined> = { ...process.env };
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        childEnv[k] = v;
      }
    }

    this.child = spawn(binInfo.cmd, [...binInfo.args, "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.worktreeDir,
      env: childEnv,
    });

    this.child.stdout?.setEncoding("utf-8");
    this.child.stderr?.setEncoding("utf-8");

    this.child.stdout?.on("data", (chunk: string) => {
      this.pending += chunk;
      let idx: number;
      while ((idx = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, idx).trimEnd();
        this.pending = this.pending.slice(idx + 1);
        if (line.length === 0) continue;
        const result = parseFrame(line);
        if (result.ok) {
          this.collected.push({ frame: result.frame, raw: line });
        }
      }
    });

    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });

    this.exitPromise = new Promise<number>((resolve) => {
      this.child.on("exit", (code) => {
        this.exitCode = code ?? -1;
        resolve(this.exitCode);
      });
    });
  }

  get isExited(): boolean {
    return this.exitCode !== null;
  }

  get exitValue(): number | null {
    return this.exitCode;
  }

  get stderr(): string {
    return this.stderrText;
  }

  get collectedFrames(): readonly CollectedFrame[] {
    return this.collected;
  }

  /**
   * Collect all queued frames (responses and notifications).
   * Does not block — returns immediately.
   */
  collectAll(): CollectedFrame[] {
    const out = [...this.collected];
    this.collected.length = 0;
    return out;
  }

  /**
   * Drain and parse all stdout lines that have arrived so far.
   */
  drainStdout(): ParseResult[] {
    const lines: string[] = [];
    while (this.collected.length > 0) {
      lines.push(this.collected.shift()!.raw);
    }
    return lines.map((line) => parseFrame(line));
  }

  /**
   * Generate the next request id.
   */
  nextRequestId(): number {
    return this.nextId++;
  }

  /**
   * Send a JSON-RPC request frame.
   */
  sendRequest(method: string, params?: unknown): RequestId {
    const id = this.nextRequestId();
    const frame: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      frame.params = params;
    }
    this.write(frame);
    return id;
  }

  /**
   * Send a JSON-RPC notification (no id → no response expected).
   */
  sendNotification(method: string, params?: unknown): void {
    const frame: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      frame.params = params;
    }
    this.write(frame);
  }

  /**
   * Send a raw string as a frame.
   */
  sendRaw(raw: string): void {
    this.child.stdin?.write(raw + "\n");
  }

  /**
   * Wait for a response (result or error) with the given id.
   * Timeout after `responseTimeoutMs`.
   */
  async awaitResponse(id: RequestId): Promise<JsonRpcResult | JsonRpcError> {
    const deadline = Date.now() + this.responseTimeoutMs;
    while (Date.now() < deadline) {
      const found = this.collected.find(
        (c) => (isResult(c.frame) || isError(c.frame)) && (c.frame as { id: unknown }).id === id,
      );
      if (found) {
        const idx = this.collected.indexOf(found);
        this.collected.splice(idx, 1);
        return found.frame as JsonRpcResult | JsonRpcError;
      }
      if (this.isExited) {
        throw new Error(
          `Process exited (code=${this.exitCode}) before response for id=${id}. stderr: ${this.stderrText}`,
        );
      }
      await sleep(50);
    }
    throw new Error(
      `Timeout waiting for response id=${id}. Collected: ${JSON.stringify(this.collected.map((c) => c.raw))}. stderr: ${this.stderrText}`,
    );
  }

  /**
   * Wait for a notification of the given method.
   */
  async awaitNotification(method: string, timeoutMs?: number): Promise<JsonRpcNotification> {
    const deadline = Date.now() + (timeoutMs ?? this.responseTimeoutMs);
    while (Date.now() < deadline) {
      const found = this.collected.find(
        (c) => isNotification(c.frame) && (c.frame as { method: string }).method === method,
      );
      if (found) {
        const idx = this.collected.indexOf(found);
        this.collected.splice(idx, 1);
        return found.frame as JsonRpcNotification;
      }
      if (this.isExited) {
        throw new Error(
          `Process exited (code=${this.exitCode}) before notification ${method}. stderr: ${this.stderrText}`,
        );
      }
      await sleep(50);
    }
    throw new Error(`Timeout waiting for notification method=${method}.`);
  }

  /**
   * Collect all notifications of the given method.
   */
  collectNotifications(method: string): JsonRpcNotification[] {
    const matching = this.collected.filter(
      (c) => isNotification(c.frame) && (c.frame as { method: string }).method === method,
    );
    for (const m of matching) {
      const idx = this.collected.indexOf(m);
      if (idx >= 0) this.collected.splice(idx, 1);
    }
    return matching.map((m) => m.frame as JsonRpcNotification);
  }

  /**
   * Collect all notifications with predicate.
   */
  collectNotificationsWhere(predicate: (n: JsonRpcNotification) => boolean): JsonRpcNotification[] {
    const matching = this.collected.filter(
      (c) => isNotification(c.frame) && predicate(c.frame as JsonRpcNotification),
    );
    for (const m of matching) {
      const idx = this.collected.indexOf(m);
      if (idx >= 0) this.collected.splice(idx, 1);
    }
    return matching.map((m) => m.frame as JsonRpcNotification);
  }

  /**
   * Perform a full initialize handshake.
   */
  async initialize(): Promise<InitializeResponseResult> {
    const id = this.sendRequest("initialize", {
      protocolVersion: 2,
      clientCapabilities: {},
      clientInfo: { name: "buzz-test-client", version: "0.0.0" },
    });
    const resp = await this.awaitResponse(id);
    if (isError(resp)) {
      throw new Error(`Initialize failed: ${JSON.stringify(resp.error)}`);
    }
    return resp.result as InitializeResponseResult;
  }

  /**
   * Create a new session.
   */
  async newSession(cwd?: string): Promise<NewSessionResponseResult> {
    const id = this.sendRequest("session/new", { cwd: cwd ?? "/tmp" });
    const resp = await this.awaitResponse(id);
    if (isError(resp)) {
      throw new Error(`session/new failed: ${JSON.stringify(resp.error)}`);
    }
    return resp.result as NewSessionResponseResult;
  }

  /**
   * Send a prompt to a session.
   */
  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{
    response: JsonRpcResult | JsonRpcError;
    notifications: JsonRpcNotification[];
  }> {
    const id = this.sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    const resp = await this.awaitResponse(id);
    const notifications = this.collectNotifications("session/update");
    return { response: resp, notifications };
  }

  /**
   * Send a session/cancel notification.
   */
  cancel(sessionId: string): void {
    this.sendNotification("session/cancel", { sessionId });
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const id = this.sendRequest("session/close", { sessionId });
    await this.awaitResponse(id);
  }

  /**
   * Wait for the process to exit (with optional timeout).
   */
  async awaitExit(timeoutMs = 5000): Promise<number> {
    const timer = setTimeout(() => {
      if (!this.isExited) this.child.kill("SIGKILL");
    }, timeoutMs);
    const code = await this.exitPromise;
    clearTimeout(timer);
    return code;
  }

  /**
   * Kill the child process.
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }

  /**
   * Close stdin on the child.
   */
  closeStdin(): void {
    this.child.stdin?.end();
  }

  private write(frame: Record<string, unknown>): void {
    this.child.stdin?.write(JSON.stringify(frame) + "\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
