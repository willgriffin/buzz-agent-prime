/**
 * NDJSON (newline-delimited JSON) framing utilities for ACP v2.
 *
 * Each ACP wire message is a compact JSON object terminated by `\n`.
 * These helpers serialise, parse, and validate frames against the
 * ACP v2 JSON-RPC 2.0 wire contract.
 */

import {
  PARSE_ERROR,
  INVALID_REQUEST,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResult,
  type JsonRpcResponse,
  type AcpFrame,
} from "./types.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialise a single ACP frame to a compact NDJSON line (no trailing newline).
 */
export function serializeFrame(frame: AcpFrame): string {
  return JSON.stringify(frame);
}

/**
 * Serialise a single ACP frame to an NDJSON line with trailing `\n`.
 */
export function serializeFrameLine(frame: AcpFrame): string {
  return serializeFrame(frame) + "\n";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult =
  { ok: true; frame: AcpFrame } | { ok: false; error: string; line: string };

/**
 * Parse a single NDJSON line into an ACP frame.
 *
 * Returns `{ ok: false, error, line }` for malformed or invalid frames.
 * This function never throws — it is safe to use in stream-piping contexts.
 */
export function parseFrame(line: string): ParseResult {
  const trimmed = line.trimEnd();

  if (trimmed.length === 0) {
    return { ok: false, error: "empty line", line };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "invalid JSON", line };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "frame must be a JSON object", line };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj["jsonrpc"] !== "2.0") {
    return { ok: false, error: "missing or invalid jsonrpc field", line };
  }

  // Validate envelope: must be a request, response, or notification
  const hasId = Object.hasOwn(obj, "id");
  const hasMethod = typeof obj["method"] === "string";
  const hasResult = Object.hasOwn(obj, "result");
  const hasError = Object.hasOwn(obj, "error");

  if (hasMethod && hasId) {
    // request
    validateRequest(obj as JsonRpcRequest);
  } else if (hasMethod && !hasId) {
    // notification
    validateNotification(obj as JsonRpcNotification);
  } else if (hasResult && hasId) {
    // result response
    return { ok: true, frame: obj as JsonRpcResult };
  } else if (hasError && hasId) {
    // error response
    return validateError(obj as JsonRpcError, line);
  } else {
    return {
      ok: false,
      error: "frame is neither a valid request, response, nor notification",
      line,
    };
  }

  return { ok: true, frame: obj as AcpFrame };
}

function validateRequest(frame: JsonRpcRequest): void {
  // id can be number, string, or null
  const id = frame.id;
  if (id !== null && typeof id !== "number" && typeof id !== "string") {
    throw new Error("invalid request id");
  }
  if (typeof frame.method !== "string") {
    throw new Error("missing method");
  }
}

function validateNotification(frame: JsonRpcNotification): void {
  if (typeof frame.method !== "string") {
    throw new Error("notification missing method");
  }
}

function validateError(frame: JsonRpcError, line: string): ParseResult {
  if (
    typeof frame.error !== "object" ||
    frame.error === null ||
    typeof frame.error.code !== "number" ||
    typeof frame.error.message !== "string"
  ) {
    return {
      ok: false,
      error: "invalid error object in response",
      line,
    };
  }
  return { ok: true, frame };
}

// ---------------------------------------------------------------------------
// Line splitting (buffer management)
// ---------------------------------------------------------------------------

/**
 * Split a buffer/string into complete lines and a remainder.
 * Returns `{ lines: string[], remainder: string }`.
 */
export function splitLines(input: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    if (input[i] === "\n") {
      lines.push(input.slice(start, i));
      start = i + 1;
    }
  }

  const remainder = start < input.length ? input.slice(start) : "";
  return { lines, remainder };
}

// ---------------------------------------------------------------------------
// Frame size validation
// ---------------------------------------------------------------------------

/**
 * Check whether a raw line exceeds the maximum frame size.
 *
 * @param line — the raw NDJSON line (without trailing newline)
 * @param maxSize — maximum allowed bytes
 * @returns `true` if the frame is within bounds
 */
export function isWithinSizeBounds(line: string, maxSize: number): boolean {
  return Buffer.byteLength(line, "utf-8") <= maxSize;
}

// ---------------------------------------------------------------------------
// Error-frame builders
// ---------------------------------------------------------------------------

export function buildParseError(id: unknown): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id: typeof id === "number" || typeof id === "string" ? id : null,
    error: { code: PARSE_ERROR, message: "Parse error" },
  };
}

export function buildInvalidRequestError(id: unknown): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id: typeof id === "number" || typeof id === "string" ? id : null,
    error: { code: INVALID_REQUEST, message: "Invalid Request" },
  };
}

// ---------------------------------------------------------------------------
// Pending frame collector
// ---------------------------------------------------------------------------

/**
 * Incrementally buffer stream chunks and yield complete NDJSON frames.
 * Designed for piping stdout/stdin through a transform.
 */
export class FrameBuffer {
  private buf = "";
  private readonly frames: string[] = [];

  /** Push raw string data; complete lines are stored internally. */
  push(chunk: string): void {
    this.buf += chunk;
    const { lines, remainder } = splitLines(this.buf);
    for (const line of lines) {
      if (line.trim().length > 0) {
        this.frames.push(line);
      }
    }
    this.buf = remainder;
  }

  /** Pop the next complete frame line, or `null` if none available. */
  next(): string | null {
    return this.frames.shift() ?? null;
  }

  /** Array of all buffered complete frame lines (drains). */
  drain(): string[] {
    const out = [...this.frames];
    this.frames.length = 0;
    return out;
  }

  /** Number of complete frame lines available. */
  get length(): number {
    return this.frames.length;
  }

  /** Remaining incomplete data. */
  get pending(): string {
    return this.buf;
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRequest(frame: AcpFrame): frame is JsonRpcRequest {
  return "method" in frame && "id" in frame;
}

export function isNotification(frame: AcpFrame): frame is JsonRpcNotification {
  return "method" in frame && !("id" in frame);
}

export function isResult(frame: AcpFrame): frame is JsonRpcResult {
  return "result" in frame && "id" in frame;
}

export function isError(frame: AcpFrame): frame is JsonRpcError {
  return "error" in frame && "id" in frame;
}

export function isResponse(frame: AcpFrame): frame is JsonRpcResponse {
  return isResult(frame) || isError(frame);
}
