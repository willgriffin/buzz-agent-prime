/**
 * One isolated `prime-agent --mode acp` subprocess, bound to one outer
 * session.
 *
 * Prime Agent hosts one session per process, so the multiplexer launches a
 * fresh child in the requested working directory for every outer
 * `session/new`. This module owns the child's ACP conversation: initialize,
 * session/new, prompt, cancel, close, and termination. Outer-to-child id
 * mapping lives in the multiplexer; this class only ever speaks the child's
 * session id.
 */

import { ChildLink, ChildRpcError } from "./child-link.js";
import type { Logger } from "./io.js";
import {
  AGENT_METHODS,
  AGENT_NOTIFICATIONS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  type JsonRpcId,
  type JsonRpcRequest,
  type NewSessionResult,
  type SessionUpdateParams,
} from "./protocol.js";

/** Default ceiling for a child's initialize + session/new handshake. */
export const DEFAULT_CHILD_INIT_TIMEOUT_MS = 60_000;
/** Default ceiling for a child's session/close round trip. */
export const DEFAULT_CHILD_CLOSE_TIMEOUT_MS = 10_000;
/** Grace period after close before the child's process group is killed. */
const CHILD_EXIT_GRACE_MS = 2_000;

export interface ChildSessionOptions {
  primeBin: string;
  clientInfo: { name: string; version: string };
  /** Outer session id, used for diagnostics only. */
  outerSessionId: string;
  /** Working directory the child is launched in. */
  cwd: string;
  /** The outer `session/new` params, forwarded verbatim to the child. */
  sessionNewParams: Record<string, unknown>;
  /** Optional `--session-dir` passed to the child prime-agent process.
   *  A named (durable) session stores all state under this path so the
   *  same Prime session can be resumed after a container restart (#13). */
  sessionDir?: string | undefined;
  /** Called with each `session/update` notification payload from the child. */
  onUpdate: (update: Record<string, unknown>) => void;
  /** Called when the child process exits (after cleanup bookkeeping). */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Called for requests the child initiates toward its client. */
  onRequest: (request: JsonRpcRequest) => void;
  onStderr?: ((chunk: string) => void) | undefined;
  logger: Logger;
  initTimeoutMs?: number | undefined;
  closeTimeoutMs?: number | undefined;
}

/**
 * A live Prime child session. `start()` must complete before any other
 * method is used; it performs initialize + session/new and resolves with the
 * child session id and any `configOptions`/`_meta` the child returned.
 */
export class ChildSession {
  readonly outerSessionId: string;
  readonly cwd: string;
  readonly #link: ChildLink;
  readonly #onUpdate: (update: Record<string, unknown>) => void;
  readonly #onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly #logger: Logger;
  readonly #clientInfo: { name: string; version: string };
  readonly #sessionNewParams: Record<string, unknown>;
  readonly #sessionDir: string | undefined;
  readonly #initTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  #childSessionId: string | undefined;
  #closed = false;

  constructor(options: ChildSessionOptions) {
    this.outerSessionId = options.outerSessionId;
    this.cwd = options.cwd;
    this.#onUpdate = options.onUpdate;
    this.#onExit = options.onExit;
    this.#logger = options.logger;
    this.#clientInfo = options.clientInfo;
    this.#sessionNewParams = options.sessionNewParams;
    this.#sessionDir = options.sessionDir;
    this.#initTimeoutMs = options.initTimeoutMs ?? DEFAULT_CHILD_INIT_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CHILD_CLOSE_TIMEOUT_MS;
    const acpArgs = this.#sessionDir
      ? ["--mode", "acp", "--session-dir", this.#sessionDir]
      : ["--mode", "acp"];
    this.#link = new ChildLink({
      command: options.primeBin,
      args: acpArgs,
      cwd: options.cwd,
      onNotification: (notification) => this.#handleNotification(notification),
      onRequest: options.onRequest,
      onExit: (code, signal) => this.#handleExit(code, signal),
      onStderr: (chunk) => {
        // Child diagnostics must never reach our stdout.
        process.stderr.write(`[prime-agent:${this.outerSessionId}] ${chunk}`);
        options.onStderr?.(chunk);
      },
      onProtocolViolation: (kind, detail) => {
        this.#logger.error(
          `session ${this.outerSessionId}: protocol violation from prime-agent (${kind}): ${detail}`,
        );
        if (kind === "tooLarge") {
          // An oversized frame means the stream is untrustworthy: stop the
          // child rather than trying to recover mid-conversation.
          this.#link.killGroup("SIGKILL");
        }
      },
    });
  }

  /** Whether the child process has exited. */
  get exited(): boolean {
    return this.#link.exited;
  }

  /** The child's pid (for diagnostics). */
  get pid(): number | undefined {
    return this.#link.pid;
  }

  /** The child's ACP session id (set once `start()` resolves). */
  get childSessionId(): string | undefined {
    return this.#childSessionId;
  }

  /** Protocol version the child reported in its initialize response. */
  #childProtocolVersion: number | string | undefined;
  get childProtocolVersion(): number | string | undefined {
    return this.#childProtocolVersion;
  }

  /**
   * Perform initialize + session/new against the child and resolve with the
   * child's session id and preserved response members.
   */
  async start(): Promise<NewSessionResult> {
    const init = (await this.#link.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        info: this.#clientInfo,
        capabilities: {},
      },
      { timeoutMs: this.#initTimeoutMs },
    )) as Record<string, unknown>;
    // The wire negotiate accepts whatever protocol version the pinned Prime
    // reports (its build may lead or trail the v2 draft); only our outer link
    // advertises v2. Capabilities and namespaced metadata are captured below.
    this.#childProtocolVersion =
      typeof init.protocolVersion === "number" || typeof init.protocolVersion === "string"
        ? (init.protocolVersion as number | string)
        : undefined;
    const result = (await this.#link.request(AGENT_METHODS.sessionNew, this.#sessionNewParams, {
      timeoutMs: this.#initTimeoutMs,
    })) as NewSessionResult;
    if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
      throw new Error("prime-agent session/new response is missing a sessionId");
    }
    this.#childSessionId = result.sessionId;
    return result;
  }

  /** Run one turn. Resolves with the child's result or rejects with the child's error. */
  prompt(params: Record<string, unknown>): Promise<unknown> {
    return this.#link.request(AGENT_METHODS.sessionPrompt, params);
  }

  /** Cancel the in-flight turn (notification; no response). */
  async cancel(): Promise<void> {
    if (this.#closed || this.#childSessionId === undefined) return;
    try {
      await this.#link.notify(AGENT_NOTIFICATIONS.sessionCancel, {
        sessionId: this.#childSessionId,
      });
    } catch (error) {
      this.#logger.error(`session ${this.outerSessionId}: cancel failed: ${String(error)}`);
    }
  }

  /** Respond to a request the child initiated. */
  respondToChildRequest(id: JsonRpcId, result: unknown): Promise<void> {
    return this.#link.respond(id, result);
  }

  /** Respond with an error to a request the child initiated. */
  respondErrorToChildRequest(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    return this.#link.respondError(id, code, message, data);
  }

  /**
   * Close the session: session/close round trip, then end the child's stdin
   * and reap the process group (escalating to SIGKILL on grace expiry).
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#childSessionId !== undefined && !this.#link.exited) {
      try {
        await this.#link.request(
          AGENT_METHODS.sessionClose,
          { sessionId: this.#childSessionId },
          { timeoutMs: this.#closeTimeoutMs },
        );
      } catch (error) {
        // The child may already be gone or refuse; termination below is the
        // real guarantee.
        this.#logger.error(
          `session ${this.outerSessionId}: session/close failed: ${String(error)}`,
        );
      }
    }
    await this.#terminate();
  }

  /** Kill the child process group and wait for it to be reaped. */
  async terminate(): Promise<void> {
    this.#closed = true;
    await this.#terminate();
  }

  async #terminate(): Promise<void> {
    if (this.#link.exited) return;
    this.#link.closeStdin();
    await this.#link.waitForExit(CHILD_EXIT_GRACE_MS);
    if (this.#link.exited) return;
    this.#link.killGroup("SIGTERM");
    await this.#link.waitForExit(CHILD_EXIT_GRACE_MS);
    if (this.#link.exited) return;
    this.#link.killGroup("SIGKILL");
    await this.#link.waitForExit(CHILD_EXIT_GRACE_MS);
  }

  #handleNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method !== CLIENT_METHODS.sessionUpdate) return;
    if (this.#closed || this.#childSessionId === undefined) return;
    const params = notification.params as SessionUpdateParams | undefined;
    if (typeof params?.sessionId !== "string" || params.sessionId !== this.#childSessionId) return;
    if (typeof params.update !== "object" || params.update === null) return;
    this.#onUpdate(params.update);
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#closed = true;
    this.#onExit(code, signal);
  }
}

export { ChildRpcError };
