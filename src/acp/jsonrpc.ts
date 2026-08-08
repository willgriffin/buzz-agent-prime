/**
 * JSON-RPC 2.0 message parsing for the ACP transport.
 *
 * The multiplexer is deliberately lenient about members it does not know
 * (they are forwarded verbatim), but strict about the JSON-RPC envelope:
 * a frame that is not valid JSON, or that is not a valid message, produces a
 * deterministic JSON-RPC error response instead of silent corruption.
 */

import {
  JSONRPC_ERROR,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  jsonRpcError,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
} from "./protocol.js";

/** Outcome of parsing one inbound frame. */
export type ParseOutcome =
  | { kind: "message"; message: JsonRpcMessage }
  | { kind: "invalid"; response: JsonRpcErrorResponse };

/**
 * Parse one NDJSON frame into a JSON-RPC message.
 *
 * Batch arrays are not accepted on the outer link: buzz-agent-prime acts as a
 * transparent session multiplexer, and a batch would make per-session routing
 * (and `$/cancel_request` targeting) ambiguous. Non-object JSON is an invalid
 * request per the JSON-RPC spec.
 */
export function parseFrame(text: string): ParseOutcome {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      kind: "invalid",
      response: {
        jsonrpc: "2.0",
        id: null,
        error: jsonRpcError(JSONRPC_ERROR.invalidRequest, "Invalid request: empty frame"),
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {
      kind: "invalid",
      response: {
        jsonrpc: "2.0",
        id: null,
        error: jsonRpcError(JSONRPC_ERROR.parseError, "Parse error: invalid JSON"),
      },
    };
  }

  if (Array.isArray(value)) {
    return {
      kind: "invalid",
      response: {
        jsonrpc: "2.0",
        id: null,
        error: jsonRpcError(
          JSONRPC_ERROR.invalidRequest,
          "Invalid request: JSON-RPC batches are not supported",
          {
            reason: "batch_not_supported",
          },
        ),
      },
    };
  }

  if (isRequestMessage(value) || isNotificationMessage(value) || isResponseMessage(value)) {
    return { kind: "message", message: value };
  }

  return {
    kind: "invalid",
    response: {
      jsonrpc: "2.0",
      id: null,
      error: jsonRpcError(JSONRPC_ERROR.invalidRequest, "Invalid request: not a JSON-RPC message"),
    },
  };
}
