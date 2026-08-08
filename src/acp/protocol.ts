/**
 * ACP v2 protocol constants and JSON-RPC 2.0 message shapes.
 *
 * buzz-agent-prime speaks the Agent Client Protocol v2 (draft) over
 * newline-delimited JSON on stdin/stdout, one JSON-RPC 2.0 message per line.
 * This module is the single source of truth for method names, error codes,
 * and the message shapes the multiplexer emits and accepts. It deliberately
 * validates leniently: unknown members are preserved and forwarded rather
 * than rejected, so prime-agent metadata (and future ACP fields) survive the
 * hop untouched.
 */

/** The ACP draft protocol version this multiplexer speaks. */
export const PROTOCOL_VERSION = 2;

/** Agent (server) methods, per the ACP v2 draft. */
export const AGENT_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionClose: "session/close",
} as const;

/** Client (harness) methods, per the ACP v2 draft. */
export const CLIENT_METHODS = {
  sessionUpdate: "session/update",
} as const;

/** Protocol-level notifications (JSON-RPC 2.0 reserved namespace). */
export const PROTOCOL_METHODS = {
  cancelRequest: "$/cancel_request",
} as const;

/** Notifications the agent accepts. */
export const AGENT_NOTIFICATIONS = {
  sessionCancel: "session/cancel",
} as const;

/** JSON-RPC 2.0 error codes (see the spec, section 5.1). */
export const JSONRPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Implementation-defined server error range: -32000 .. -32099. */
  serverError: -32000,
  requestCancelled: -32800,
} as const;

/**
 * Reverse-domain namespace for buzz-agent-prime's own `_meta` payloads.
 *
 * Prime Agent uses `ai.primeintellect.prime-agent` for its namespaced
 * metadata (subagents, compaction, goals, refinement, heartbeats). We keep
 * that namespace verbatim and add our own so a multiplexer-aware client can
 * tell the two apart.
 */
export const BUZZ_AGENT_PRIME_META_NAMESPACE = "ai.buzz.buzz-agent-prime";

/** Reverse-domain namespace prime-agent uses for its `_meta` payloads. */
export const PRIME_AGENT_META_NAMESPACE = "ai.primeintellect.prime-agent";

/** JSON-RPC id: string, number, or null (per spec). */
export type JsonRpcId = string | number | null;

/** A JSON-RPC 2.0 request (expects a response). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 notification (no response expected). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 error object. */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC 2.0 success response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** A JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

/** Any JSON-RPC 2.0 message we can emit or receive. */
export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Shape of the `session/update` notification params. */
export interface SessionUpdateParams {
  sessionId: string;
  update: Record<string, unknown>;
}

/** Result shape of `session/prompt`, as emitted by prime-agent. */
export interface PromptResult {
  stopReason?: string;
  _meta?: Record<string, unknown>;
}

/** Result shape of `session/new`, as emitted by prime-agent. */
export interface NewSessionResult {
  sessionId: string;
  configOptions?: unknown;
  _meta?: Record<string, unknown>;
}

/** The `initialize` result we send to the outer client. */
export interface InitializeResult {
  protocolVersion: number;
  info: { name: string; title?: string; version: string };
  capabilities: Record<string, unknown>;
  authMethods?: unknown[];
  _meta?: Record<string, unknown>;
}

/** Build a JSON-RPC error object. */
export function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorObject {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return error;
}

/** Narrow a value to a JSON-RPC id. */
export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Whether a parsed object is a JSON-RPC request (has method + id). */
export function isRequestMessage(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string") return false;
  return "id" in value && isJsonRpcId(value.id);
}

/** Whether a parsed object is a JSON-RPC notification (method, no id). */
export function isNotificationMessage(value: unknown): value is JsonRpcNotification {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method !== "string") return false;
  return !("id" in value);
}

/** Whether a parsed object is a JSON-RPC response (result xor error, no method). */
export function isResponseMessage(
  value: unknown,
): value is JsonRpcSuccessResponse | JsonRpcErrorResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if ("method" in value) return false;
  if (!("id" in value) || !isJsonRpcId(value.id)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return false;
  return !hasError || isErrorObject(value.error);
}

/** Whether a value looks like a JSON-RPC error object. */
export function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "number" &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
