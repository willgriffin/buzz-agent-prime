/**
 * ACP v2 wire types for buzz-agent-prime test infrastructure.
 *
 * These types mirror the Agent Client Protocol v2 JSON Schema
 * (https://github.com/agentclientprotocol/agent-client-protocol).
 * They are used by the contract and e2e test suites to build,
 * parse, and validate NDJSON frames exchanged between the
 * buzz-agent-prime multiplexer and its ACP children.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export type RequestId = number | string | null;

/** A JSON-RPC 2.0 request frame. */
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: P;
}

/** A JSON-RPC 2.0 notification frame (no id). */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

/** A JSON-RPC 2.0 successful response frame. */
export interface JsonRpcResult<R = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  result: R;
}

/** A JSON-RPC 2.0 error response frame. */
export interface JsonRpcError {
  jsonrpc: "2.0";
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcResult<R> | JsonRpcError;

export type AcpFrame = JsonRpcRequest | JsonRpcNotification | JsonRpcResult | JsonRpcError;

// ---------------------------------------------------------------------------
// Protocol version and capability negotiation
// ---------------------------------------------------------------------------

/** ACP protocol version — currently v2. */
export const ACP_PROTOCOL_VERSION = 2 as const;

export interface Implementation {
  name: string;
  title?: string;
  version: string;
  _meta?: Record<string, unknown> | null;
}

export interface SessionCapabilities {
  prompt?: {
    image?: boolean | null;
    audio?: boolean | null;
    resourceLink?: boolean | null;
    resource?: boolean | null;
  } | null;
  mcp?: unknown;
  delete?: boolean | null;
  list?: boolean | null;
  resume?: boolean | null;
}

export interface AgentCapabilities {
  session?: SessionCapabilities | null;
  _meta?: Record<string, unknown> | null;
}

export interface ClientCapabilities {
  elicitation?: unknown;
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeRequestParams {
  protocolVersion: number;
  info: Implementation;
  capabilities?: ClientCapabilities;
  _meta?: Record<string, unknown> | null;
}

export interface InitializeResponseResult {
  protocolVersion: number;
  info: Implementation;
  capabilities?: AgentCapabilities;
  authMethods?: unknown[];
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

export interface NewSessionRequestParams {
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  _meta?: Record<string, unknown> | null;
}

export interface NewSessionResponseResult {
  sessionId: string;
  configOptions?: unknown[];
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

export interface TextContentBlock {
  type: "text";
  text: string;
  annotations?: unknown;
  _meta?: Record<string, unknown> | null;
}

export type ContentBlock = TextContentBlock | Record<string, unknown>;

export interface PromptRequestParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown> | null;
}

export interface PromptResponseResult {
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// session/cancel (client → agent notification)
// ---------------------------------------------------------------------------

export interface CancelSessionParams {
  sessionId: string;
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// session/close
// ---------------------------------------------------------------------------

export interface CloseSessionParams {
  sessionId: string;
  _meta?: Record<string, unknown> | null;
}

export interface CloseSessionResult {
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// session/update (agent → client notification)
// ---------------------------------------------------------------------------

export type StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string; // allow custom / extension values

export interface StateUpdateRunning {
  state: "running";
}

export interface StateUpdateIdle {
  state: "idle";
  stopReason?: StopReason;
}

export interface StateUpdateRequiresAction {
  state: "requires_action";
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  messageId: string;
  content: ContentBlock;
  _meta?: Record<string, unknown> | null;
}

export interface AgentMessageUpdate {
  sessionUpdate: "agent_message";
  messageId: string;
  content?: ContentBlock[] | null;
  _meta?: Record<string, unknown> | null;
}

export interface StateUpdate {
  sessionUpdate: "state_update";
  state: "running" | "idle" | "requires_action" | string;
  stopReason?: StopReason;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentMessageUpdate
  | StateUpdate
  | (Record<string, unknown> & { sessionUpdate: string });

export interface UpdateSessionParams {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// $/cancel_request (protocol-level notification)
// ---------------------------------------------------------------------------

export interface CancelRequestParams {
  requestId: RequestId;
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Extension notifications for Prime metadata forwarding
// ---------------------------------------------------------------------------

/**
 * Prime-specific extension notification method names.
 * These use the ACP extensibility mechanism (`_meta` and ext notifications)
 * to carry IPython and subagent lifecycle events through the multiplexer.
 *
 * Values prefixed with `_` are reserved for implementation-specific extensions
 * per the ACP v2 spec.
 */
export const PRIME_EXT_IPYTHON_LIFECYCLE = "_prime/ipython_lifecycle" as const;
export const PRIME_EXT_SUBAGENT_LIFECYCLE = "_prime/subagent_lifecycle" as const;

export type IPythonLifecycleEvent = "start" | "ready" | "restart" | "shutdown";

export interface IPythonLifecycleParams {
  sessionId: string;
  event: IPythonLifecycleEvent;
  kernelId?: string;
  _meta?: Record<string, unknown> | null;
}

export type SubagentLifecycleEvent = "spawn" | "ready" | "complete" | "error";

export interface SubagentLifecycleParams {
  sessionId: string;
  event: SubagentLifecycleEvent;
  subagentId?: string;
  subagentName?: string;
  _meta?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

export const PARSE_ERROR = -32700 as const;
export const INVALID_REQUEST = -32600 as const;
export const METHOD_NOT_FOUND = -32601 as const;
export const INVALID_PARAMS = -32602 as const;
export const INTERNAL_ERROR = -32603 as const;

// ---------------------------------------------------------------------------
// Frame size bounds (contract)
// ---------------------------------------------------------------------------

/** Default maximum inbound frame size in bytes (1 MiB). */
export const DEFAULT_MAX_FRAME_SIZE = 1 * 1024 * 1024;

/** Maximum concurrent outer ACP sessions (default from contract). */
export const DEFAULT_MAX_SESSIONS = 4;
