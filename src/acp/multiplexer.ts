/**
 * The ACP v2 session multiplexer.
 *
 * One `buzz-agent-prime acp` process fronts many outer ACP sessions. Each
 * outer `session/new` launches an isolated `prime-agent --mode acp`
 * subprocess in the requested working directory; outer session ids are mapped
 * to child session ids and every forwarded `session/update` has its session id
 * rewritten back. Prompts, cancellation, close, errors, and child-process
 * termination are routed per session, so one session's failure never touches
 * another.
 */

import { createHash, randomUUID } from "node:crypto";
import { ChildRpcError } from "./child-link.js";
import { mkdirSync } from "node:fs";
import { ChildSession } from "./child-session.js";
import type { FrameWriter, Logger } from "./io.js";
import { probePrimeAgent, type PrimeProbeResult } from "./prime-probe.js";
import {
  AGENT_METHODS,
  BUZZ_AGENT_PRIME_META_NAMESPACE,
  CLIENT_METHODS,
  JSONRPC_ERROR,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
  jsonRpcError,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type NewSessionResult,
  type SessionUpdateParams,
} from "./protocol.js";

/** Where the outer client can find a durable session key in `session/new`. */
export const DURABLE_SESSION_KEY_PATH = "_meta.durableSessionKey";

export interface MultiplexerOptions {
  writer: FrameWriter;
  logger: Logger;
  /** Resolved prime-agent executable. */
  primeBin: string;
  /** Client info presented to prime-agent children. */
  clientInfo: { name: string; version: string };
  /** Maximum concurrent outer sessions. */
  maxSessions: number;
  /** Working directory used for the probe and for sessions that omit cwd. */
  defaultCwd: string;
  probeTimeoutMs?: number | undefined;
  childInitTimeoutMs?: number | undefined;
  childCloseTimeoutMs?: number | undefined;
}

interface SessionRecord {
  outerSessionId: string;
  child: ChildSession;
  childSessionId: string;
  durableKey: string | undefined;
}

interface PendingCreation {
  outerSessionId: string;
  child: ChildSession;
  durableKey: string | undefined;
  abort: AbortController;
}

/** Pending `session/prompt` forwarded to a child, keyed by outer request id. */
interface PendingPrompt {
  session: SessionRecord;
}

/** Child-initiated request forwarded to the outer client. */
interface PendingChildRequest {
  session: SessionRecord;
  childRequestId: JsonRpcId;
}

/** Derive deterministic session directory from canonical cwd + session title. */
function deriveSessionDir(
  cwd: string,
  sessionTitle: string | undefined,
  stateDir: string,
): string | undefined {
  const title = sessionTitle?.trim();
  if (!title) return undefined;
  const hash = createHash("sha256");
  hash.update(cwd);
  hash.update("\0");
  hash.update(title);
  return `${stateDir}/sessions/${hash.digest("hex").slice(0, 32)}`;
}

/** Read `_meta.sessionTitle` from session/new params. */
function readSessionTitle(params: Record<string, unknown>): string | undefined {
  const meta = params["_meta"] as Record<string, unknown> | undefined;
  return typeof meta?.["sessionTitle"] === "string" ? (meta["sessionTitle"] as string) : undefined;
}

export class AcpMultiplexer {
  readonly #options: MultiplexerOptions;
  readonly #writer: FrameWriter;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #durableKeys = new Map<string, string>();
  /** Sessions intentionally terminated by the multiplexer (close, cancel,
   *  shutdown).  Used to distinguish `reason: "killed"` from natural exit
   *  or crash in the `childExited` notification (#20). */
  readonly #killedSessions = new Set<string>();
  /** Session directories currently in use — guards duplicate named sessions
   *  that share a `--session-dir` when `_meta.sessionTitle` is set but
   *  `_meta.durableSessionKey` is not (#13 follow-up). */
  readonly #liveSessionDirs = new Map<string, string>();
  readonly #pendingCreations = new Map<JsonRpcId, PendingCreation>();
  readonly #pendingPrompts = new Map<JsonRpcId, PendingPrompt>();
  readonly #pendingChildRequests = new Map<JsonRpcId, PendingChildRequest>();
  #probe: PrimeProbeResult | undefined;
  #probePromise: Promise<PrimeProbeResult> | undefined;
  #nextForwardedRequestId = 1;
  #shuttingDown = false;

  constructor(options: MultiplexerOptions) {
    this.#options = options;
    this.#writer = options.writer;
    this.#logger = options.logger;
  }

  /** Total live + pending sessions (used for the capacity bound). */
  get sessionCount(): number {
    return this.#sessions.size + this.#pendingCreations.size;
  }

  /** Handle one inbound message from the outer client. */
  async handleMessage(message: JsonRpcMessage): Promise<void> {
    if ("method" in message && "id" in message) {
      await this.#handleRequest(message);
      return;
    }
    if ("method" in message) {
      await this.#handleNotification(message);
      return;
    }
    await this.#handleResponse(message);
  }

  /**
   * Shut down every child and drain the writer. Idempotent; safe to call
   * multiple times (EOF and a signal may race).
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    const cleanups: Promise<void>[] = [];
    for (const record of this.#sessions.values()) {
      this.#killedSessions.add(record.outerSessionId);
      cleanups.push(record.child.terminate().catch(() => undefined));
    }
    for (const creation of this.#pendingCreations.values()) {
      cleanups.push(creation.child.terminate().catch(() => undefined));
    }
    // Fail anything still awaiting a child answer.
    for (const prompt of this.#pendingPrompts.values()) {
      void this.#failPrompt(
        prompt.session,
        jsonRpcError(JSONRPC_ERROR.requestCancelled, "Request cancelled", {
          reason: "multiplexer shutting down",
        }),
      );
    }
    await Promise.allSettled(cleanups);
    this.#sessions.clear();
    this.#durableKeys.clear();
    this.#killedSessions.clear();
    this.#liveSessionDirs.clear();
    this.#pendingCreations.clear();
    this.#pendingPrompts.clear();
    await this.#writer.drain();
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;
    try {
      switch (method) {
        case AGENT_METHODS.initialize:
          await this.#handleInitialize(id, params);
          return;
        case AGENT_METHODS.sessionNew:
          await this.#handleSessionNew(id, params);
          return;
        case AGENT_METHODS.sessionPrompt:
          await this.#handleSessionPrompt(id, params);
          return;
        case AGENT_METHODS.sessionClose:
          await this.#handleSessionClose(id, params);
          return;
        default:
          await this.#respondError(
            id,
            jsonRpcError(JSONRPC_ERROR.methodNotFound, `"Method not found": ${method}`, {
              method,
            }),
          );
      }
    } catch (error) {
      this.#logger.error(`request ${method} failed: ${String(error)}`);
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.internalError, `Internal error: ${String(error)}`),
      );
    }
  }

  async #handleInitialize(id: JsonRpcId, params: unknown): Promise<void> {
    const protocolVersion = readProtocolVersion(params);
    if (protocolVersion !== PROTOCOL_VERSION) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.invalidParams, "Unsupported ACP protocol version", {
          expectedProtocolVersion: PROTOCOL_VERSION,
          receivedProtocolVersion: protocolVersion,
        }),
      );
      return;
    }
    try {
      const probe = await this.#initializeProbe();
      await this.#respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: "buzz-agent-prime",
          title: "Buzz Agent Prime",
          version: this.#options.clientInfo.version,
        },
        agentCapabilities: { ...probe.agentCapabilities },
        authMethods: [],
        _meta: {
          ...probe.meta,
          [BUZZ_AGENT_PRIME_META_NAMESPACE]: {
            multiplexer: {
              protocolVersion: PROTOCOL_VERSION,
              maxSessions: this.#options.maxSessions,
            },
            upstream: {
              name: "prime-agent",
              version: readString(probe.agentInfo, "version"),
              protocolVersion: probe.protocolVersion,
            },
          },
        },
      });
    } catch (error) {
      this.#logger.error(
        `failed to probe prime-agent (${this.#options.primeBin}): ${String(error)}`,
      );
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.internalError, `Failed to probe prime-agent: ${String(error)}`),
      );
    }
  }

  #initializeProbe(): Promise<PrimeProbeResult> {
    if (this.#probe) return Promise.resolve(this.#probe);
    if (!this.#probePromise) {
      this.#probePromise = probePrimeAgent({
        primeBin: this.#options.primeBin,
        clientInfo: this.#options.clientInfo,
        cwd: this.#options.defaultCwd,
        timeoutMs: this.#options.probeTimeoutMs,
        onStderr: (chunk) => process.stderr.write(`[prime-probe] ${chunk}`),
      })
        .then((result) => {
          this.#probe = result;
          return result;
        })
        .finally(() => {
          this.#probePromise = undefined;
        });
    }
    return this.#probePromise;
  }

  async #handleSessionNew(id: JsonRpcId, params: unknown): Promise<void> {
    const requestParams = asRecord(params);
    const cwd =
      typeof requestParams.cwd === "string" ? requestParams.cwd : this.#options.defaultCwd;
    const durableKey = readDurableSessionKey(requestParams);

    // Derive session directory early so duplicate checks can use it.
    const stateDir = process.env["BUZZ_AGENT_PRIME_STATE_DIR"] || "/var/lib/buzz-agent-prime";
    const sessionTitle = readSessionTitle(requestParams);
    const sessionDir = deriveSessionDir(cwd, sessionTitle, stateDir);

    if (this.sessionCount >= this.#options.maxSessions) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.serverError, "Maximum concurrent sessions reached", {
          maxSessions: this.#options.maxSessions,
          reason: "capacity",
        }),
      );
      return;
    }
    if (durableKey !== undefined && this.#durableKeys.has(durableKey)) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.invalidParams, "Duplicate live durable session key", {
          durableSessionKey: durableKey,
          reason: "duplicate_live_key",
        }),
      );
      return;
    }
    // Also guard against duplicate named sessions that share a
    // `--session-dir` via `_meta.sessionTitle` without a durable key.
    if (sessionDir !== undefined && this.#liveSessionDirs.has(sessionDir)) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.serverError, "Duplicate live named session", {
          sessionDir,
          reason: "duplicate_live_session_dir",
        }),
      );
      return;
    }

    if (sessionDir) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const outerSessionId = randomUUID();
    const abort = new AbortController();
    // Forward the client's session/new params verbatim, defaulting only the
    // members prime-agent requires even under an empty workload: cwd (we
    // always supply one) and mcpServers (buzz-acp always sends an array; a
    // generic v2 client may omit it).
    const sessionNewParams = { mcpServers: [], additionalDirectories: [], ...requestParams, cwd };

    const child = new ChildSession({
      primeBin: this.#options.primeBin,
      clientInfo: this.#options.clientInfo,
      outerSessionId,
      cwd,
      sessionNewParams,
      sessionDir,
      onUpdate: (update) => this.#forwardUpdate(outerSessionId, update),
      onRequest: (request) => void this.#forwardChildRequest(outerSessionId, request),
      onExit: (code, signal) => this.#handleChildExit(outerSessionId, code, signal),
      logger: this.#logger,
      initTimeoutMs: this.#options.childInitTimeoutMs,
      closeTimeoutMs: this.#options.childCloseTimeoutMs,
    });
    // Register the durable key and session dir BEFORE the async
    // handshake so two concurrent session/new requests cannot both pass
    // the duplicate-key check (#22, #13 follow-up).
    if (durableKey !== undefined) {
      this.#durableKeys.set(durableKey, outerSessionId);
    }
    if (sessionDir !== undefined) {
      this.#liveSessionDirs.set(sessionDir, outerSessionId);
    }

    const creation: PendingCreation = { outerSessionId, child, durableKey, abort };
    this.#pendingCreations.set(id, creation);

    try {
      const result = await child.start();
      this.#pendingCreations.delete(id);
      const record: SessionRecord = {
        outerSessionId,
        child,
        childSessionId: result.sessionId,
        durableKey,
      };
      this.#sessions.set(outerSessionId, record);
      this.#logger.info(
        `session ${outerSessionId} created (child ${result.sessionId}, cwd ${cwd}, ${this.#sessions.size}/${this.#options.maxSessions} live)`,
      );
      await this.#respond(id, this.#newSessionResponse(outerSessionId, result));
    } catch (error) {
      this.#pendingCreations.delete(id);
      if (durableKey !== undefined) this.#durableKeys.delete(durableKey);
      if (sessionDir !== undefined) this.#liveSessionDirs.delete(sessionDir);
      await child.terminate().catch(() => undefined);
      if (abort.signal.aborted) {
        await this.#respondError(
          id,
          jsonRpcError(JSONRPC_ERROR.requestCancelled, "Session creation cancelled", {
            reason: "cancel_request",
          }),
        );
        return;
      }
      const rpcError = childErrorToJsonRpc(error, "session/new failed");
      await this.#respondError(id, rpcError);
    }
  }

  async #handleSessionPrompt(id: JsonRpcId, params: unknown): Promise<void> {
    const requestParams = asRecord(params);
    const sessionId =
      typeof requestParams.sessionId === "string" ? requestParams.sessionId : undefined;
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session === undefined) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.invalidParams, "Unknown ACP session", {
          sessionId: sessionId ?? null,
        }),
      );
      return;
    }
    if (session.child.exited) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.internalError, "prime-agent subprocess has exited", {
          sessionId,
        }),
      );
      return;
    }
    this.#pendingPrompts.set(id, { session });
    try {
      const result = await session.child.prompt({
        sessionId: session.childSessionId,
        ...omit(requestParams, ["sessionId"]),
      });
      this.#pendingPrompts.delete(id);
      await this.#respond(id, result);
    } catch (error) {
      this.#pendingPrompts.delete(id);
      await this.#respondError(id, childErrorToJsonRpc(error, "session/prompt failed"));
    }
  }

  async #handleSessionClose(id: JsonRpcId, params: unknown): Promise<void> {
    const requestParams = asRecord(params);
    const sessionId =
      typeof requestParams.sessionId === "string" ? requestParams.sessionId : undefined;
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session === undefined) {
      await this.#respondError(
        id,
        jsonRpcError(JSONRPC_ERROR.invalidParams, "Unknown ACP session", {
          sessionId: sessionId ?? null,
        }),
      );
      return;
    }
    // Fail any prompt still awaiting this session's child so the client's
    // pending request settles even if the child dies before answering.
    for (const [promptId, prompt] of this.#pendingPrompts) {
      if (prompt.session.outerSessionId === session.outerSessionId) {
        this.#pendingPrompts.delete(promptId);
      }
    }
    this.#killedSessions.add(session.outerSessionId);
    await session.child.close();
    this.#dropSession(session.outerSessionId);
    this.#logger.info(`session ${session.outerSessionId} closed`);
    await this.#respond(id, {});
  }

  async #handleNotification(notification: JsonRpcNotification): Promise<void> {
    const { method, params } = notification;
    switch (method) {
      case "session/cancel":
        await this.#handleSessionCancel(params);
        return;
      case PROTOCOL_METHODS.cancelRequest:
        await this.#handleCancelRequest(params);
        return;
      default:
        // Unknown notifications are ignored per JSON-RPC 2.0.
        this.#logger.info(`ignoring unknown notification ${method}`);
    }
  }

  async #handleSessionCancel(params: unknown): Promise<void> {
    const requestParams = asRecord(params);
    const sessionId =
      typeof requestParams.sessionId === "string" ? requestParams.sessionId : undefined;
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (session === undefined) {
      this.#logger.info(`session/cancel for unknown session ${String(sessionId)}; ignoring`);
      return;
    }
    await session.child.cancel();
  }

  async #handleCancelRequest(params: unknown): Promise<void> {
    const requestParams = asRecord(params);
    const requestId = requestParams.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const creation = this.#pendingCreations.get(requestId);
    if (creation) {
      creation.abort.abort();
      await creation.child.terminate().catch(() => undefined);
      this.#pendingCreations.delete(requestId);
      return;
    }
    const prompt = this.#pendingPrompts.get(requestId);
    if (prompt) {
      await prompt.session.child.cancel();
    }
  }

  async #handleResponse(response: JsonRpcSuccessResponse | JsonRpcErrorResponse): Promise<void> {
    const pending = this.#pendingChildRequests.get(response.id);
    if (!pending) {
      this.#logger.info(
        `ignoring response for unknown forwarded request id ${String(response.id)}`,
      );
      return;
    }
    this.#pendingChildRequests.delete(response.id);
    if (!this.#sessions.has(pending.session.outerSessionId) || pending.session.child.exited) {
      return;
    }
    try {
      if ("result" in response) {
        await pending.session.child.respondToChildRequest(pending.childRequestId, response.result);
      } else {
        await pending.session.child.respondErrorToChildRequest(
          pending.childRequestId,
          response.error.code,
          response.error.message,
          response.error.data,
        );
      }
    } catch (error) {
      this.#logger.error(`failed to route response to child: ${String(error)}`);
    }
  }

  #forwardUpdate(outerSessionId: string, update: Record<string, unknown>): void {
    const params: SessionUpdateParams = { sessionId: outerSessionId, update };
    void this.#writer.write({
      jsonrpc: "2.0",
      method: CLIENT_METHODS.sessionUpdate,
      params,
    });
  }

  #forwardChildRequest(outerSessionId: string, request: JsonRpcRequest): void {
    const session = this.#sessions.get(outerSessionId);
    if (session === undefined) {
      // A request from the child racing session creation has no route yet;
      // prime-agent does not emit client-directed requests during startup.
      this.#logger.info(
        `dropping child request ${request.method} for unregistered session ${outerSessionId}`,
      );
      return;
    }
    const outerId: JsonRpcId = `bap-req-${this.#nextForwardedRequestId++}`;
    this.#pendingChildRequests.set(outerId, {
      session,
      childRequestId: request.id,
    });
    void this.#writer
      .write({
        jsonrpc: "2.0",
        id: outerId,
        method: request.method,
        params: request.params,
      })
      .catch(() => undefined);
  }

  #handleChildExit(
    outerSessionId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const session = this.#sessions.get(outerSessionId);
    if (session === undefined) return;
    this.#dropSession(outerSessionId);
    // Surface the exit to the outer client as namespaced metadata so a
    // harness can distinguish an agent-chosen stop from a subprocess death.
    // Clean up the per-session killed flag; use it for notification + log level.
    const wasKilled = this.#killedSessions.delete(outerSessionId);
    const reason: string = wasKilled
      ? "killed"
      : code !== 0 || signal !== null
        ? "crashed"
        : "exited";
    const update: Record<string, unknown> = {
      sessionUpdate: "session_info_update",
      _meta: {
        [BUZZ_AGENT_PRIME_META_NAMESPACE]: {
          childExited: {
            sessionId: outerSessionId,
            code,
            signal,
            reason,
          },
        },
      },
    };
    this.#forwardUpdate(outerSessionId, update);
    this.#logger[reason === "killed" ? "info" : "error"](
      `session ${outerSessionId}: child ${reason} (code ${String(code)}, signal ${String(signal)})`,
    );
  }

  #dropSession(outerSessionId: string): void {
    const session = this.#sessions.get(outerSessionId);
    if (session === undefined) return;
    this.#sessions.delete(outerSessionId);
    if (session.durableKey !== undefined) {
      const owner = this.#durableKeys.get(session.durableKey);
      if (owner === outerSessionId) this.#durableKeys.delete(session.durableKey);
    }
    // Release the session directory guard so a subsequent restart or new
    // session can reclaim the directory.
    for (const [dir, owner] of this.#liveSessionDirs) {
      if (owner === outerSessionId) {
        this.#liveSessionDirs.delete(dir);
        break;
      }
    }
    for (const [requestId, pending] of this.#pendingChildRequests) {
      if (pending.session.outerSessionId === outerSessionId) {
        this.#pendingChildRequests.delete(requestId);
      }
    }
  }

  async #failPrompt(session: SessionRecord, error: JsonRpcErrorResponse["error"]): Promise<void> {
    for (const [requestId, pending] of this.#pendingPrompts) {
      if (pending.session.outerSessionId === session.outerSessionId) {
        this.#pendingPrompts.delete(requestId);
        await this.#respondError(requestId, error);
      }
    }
  }

  #newSessionResponse(outerSessionId: string, result: NewSessionResult): Record<string, unknown> {
    // The outer client sees our session id; the child session id never leaks
    // outward. The child's configOptions (model configuration) and namespaced
    // `_meta` are preserved so prime-agent behavior is unchanged.
    const response: Record<string, unknown> = { sessionId: outerSessionId };
    if (result.configOptions !== undefined) response.configOptions = result.configOptions;
    if (result._meta !== undefined) response._meta = result._meta;
    return response;
  }

  #respond(id: JsonRpcId, result: unknown): Promise<void> {
    return this.#writer.write({ jsonrpc: "2.0", id, result });
  }

  #respondError(id: JsonRpcId, error: JsonRpcErrorResponse["error"]): Promise<void> {
    return this.#writer.write({ jsonrpc: "2.0", id, error });
  }
}

/** Map a child failure onto a JSON-RPC error the outer client can consume. */
export function childErrorToJsonRpc(
  error: unknown,
  fallbackPrefix: string,
): JsonRpcErrorResponse["error"] {
  if (error instanceof ChildRpcError) {
    return jsonRpcError(error.code, error.message, error.data);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonRpcError(JSONRPC_ERROR.internalError, `${fallbackPrefix}: ${message}`);
}

function readProtocolVersion(params: unknown): number | undefined {
  const record = asRecord(params);
  return typeof record.protocolVersion === "number" ? record.protocolVersion : undefined;
}

function readDurableSessionKey(params: Record<string, unknown>): string | undefined {
  const meta = asRecord(params._meta);
  const key = meta.durableSessionKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function omit(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) result[key] = value;
  }
  return result;
}
