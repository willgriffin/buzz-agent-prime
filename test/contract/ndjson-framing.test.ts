import { describe, expect, it } from "vitest";
import {
  parseFrame,
  serializeFrame,
  serializeFrameLine,
  splitLines,
  isWithinSizeBounds,
  buildParseError,
  buildInvalidRequestError,
  FrameBuffer,
  isRequest,
  isNotification,
  isResult,
  isError,
  isResponse,
} from "./helpers/ndjson.js";
import {
  DEFAULT_MAX_FRAME_SIZE,
  PARSE_ERROR,
  INVALID_REQUEST,
  type JsonRpcRequest,
} from "./helpers/types.js";

describe("NDJSON serialization", () => {
  it("serializes a request frame to compact JSON", () => {
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 2 },
    };
    expect(serializeFrame(frame)).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}',
    );
  });

  it("adds trailing newline with serializeFrameLine", () => {
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    };
    const line = serializeFrameLine(frame);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).toBe(serializeFrame(frame));
  });
});

describe("NDJSON parsing — valid frames", () => {
  it("parses a request frame", () => {
    const result = parseFrame(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isRequest(result.frame)).toBe(true);
      expect(result.frame.method).toBe("initialize");
    }
  });

  it("parses a notification frame (no id)", () => {
    const result = parseFrame(
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isNotification(result.frame)).toBe(true);
      expect(isRequest(result.frame)).toBe(false);
    }
  });

  it("parses a result response", () => {
    const result = parseFrame('{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isResult(result.frame)).toBe(true);
      expect(isResponse(result.frame)).toBe(true);
    }
  });

  it("parses an error response", () => {
    const result = parseFrame(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isError(result.frame)).toBe(true);
    }
  });

  it("parses a notification with null params", () => {
    const result = parseFrame('{"jsonrpc":"2.0","method":"$/cancel_request","params":null}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isNotification(result.frame)).toBe(true);
    }
  });

  it("accepts string request ids", () => {
    const result = parseFrame('{"jsonrpc":"2.0","id":"req-abc","method":"initialize"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const req = result.frame as { id: unknown };
      expect(req.id).toBe("req-abc");
    }
  });

  it("accepts null request ids (valid JSON-RPC 2.0)", () => {
    const result = parseFrame('{"jsonrpc":"2.0","id":null,"method":"initialize"}');
    expect(result.ok).toBe(true);
  });
});

describe("NDJSON parsing — malformed frames", () => {
  it("rejects invalid JSON", () => {
    const result = parseFrame('{"jsonrpc": "2.0", broken}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("rejects empty lines", () => {
    expect(parseFrame("").ok).toBe(false);
    expect(parseFrame("   ").ok).toBe(false);
    expect(parseFrame("\t").ok).toBe(false);
  });

  it("rejects JSON arrays", () => {
    const result = parseFrame("[]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON object");
    }
  });

  it("rejects JSON primitives", () => {
    expect(parseFrame("42").ok).toBe(false);
    expect(parseFrame('"string"').ok).toBe(false);
    expect(parseFrame("true").ok).toBe(false);
    expect(parseFrame("null").ok).toBe(false);
  });

  it("rejects missing jsonrpc field", () => {
    const result = parseFrame('{"id":1,"method":"initialize"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("jsonrpc");
    }
  });

  it("rejects wrong jsonrpc version", () => {
    const result = parseFrame('{"jsonrpc":"1.0","id":1,"method":"initialize"}');
    expect(result.ok).toBe(false);
  });

  it("rejects frames that are neither request, response, nor notification", () => {
    const result = parseFrame('{"jsonrpc":"2.0","foo":"bar"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("neither a valid request");
    }
  });

  it("rejects error responses with missing code or message", () => {
    const result = parseFrame('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}');
    expect(result.ok).toBe(false);
  });

  it("rejects error responses with non-numeric code", () => {
    const result = parseFrame('{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"msg"}}');
    expect(result.ok).toBe(false);
  });
});

describe("NDJSON line splitting", () => {
  it("splits multiple lines", () => {
    const { lines, remainder } = splitLines('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(lines).toHaveLength(3);
    expect(remainder).toBe("");
  });

  it("handles trailing partial line", () => {
    const { lines, remainder } = splitLines('{"a":1}\n{"b":2}\n{"c":3');
    expect(lines).toHaveLength(2);
    expect(remainder).toBe('{"c":3');
  });

  it("handles empty input", () => {
    const { lines, remainder } = splitLines("");
    expect(lines).toHaveLength(0);
    expect(remainder).toBe("");
  });

  it("handles single complete line", () => {
    const { lines, remainder } = splitLines('{"a":1}\n');
    expect(lines).toHaveLength(1);
    expect(remainder).toBe("");
  });

  it("handles \\r\\n line endings", () => {
    const { lines } = splitLines('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toHaveLength(2);
  });
});

describe("Frame size bounds", () => {
  it("accepts frames within bounds", () => {
    const fontSize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" });
    expect(isWithinSizeBounds(fontSize, DEFAULT_MAX_FRAME_SIZE)).toBe(true);
  });

  it("rejects oversized frames", () => {
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
      params: { data: "x".repeat(DEFAULT_MAX_FRAME_SIZE + 100) },
    });
    expect(isWithinSizeBounds(huge, DEFAULT_MAX_FRAME_SIZE)).toBe(false);
  });

  it("respects custom max size", () => {
    const small = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(isWithinSizeBounds(small, 10)).toBe(false);
    expect(isWithinSizeBounds(small, 1000)).toBe(true);
  });
});

describe("Error-frame builders", () => {
  it("builds a parse error response", () => {
    const err = buildParseError(null);
    expect(err.jsonrpc).toBe("2.0");
    expect(err.id).toBeNull();
    expect(err.error.code).toBe(PARSE_ERROR);
    expect(err.error.message).toBe("Parse error");
  });

  it("builds an invalid-request error response", () => {
    const err = buildInvalidRequestError(42);
    expect(err.jsonrpc).toBe("2.0");
    expect(err.id).toBe(42);
    expect(err.error.code).toBe(INVALID_REQUEST);
  });

  it("normalizes invalid ids to null in error builders", () => {
    const err = buildParseError({ weird: true });
    expect(err.id).toBeNull();
  });
});

describe("FrameBuffer", () => {
  it("buffers and yields complete frames", () => {
    const fb = new FrameBuffer();
    fb.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    expect(fb.length).toBe(2);
    expect(fb.next()).toContain('"id":1');
    expect(fb.next()).toContain('"id":2');
    expect(fb.next()).toBeNull();
  });

  it("handles partial frames across pushes", () => {
    const fb = new FrameBuffer();
    fb.push('{"jsonrpc":"2.0","id":1,');
    expect(fb.length).toBe(0);
    expect(fb.pending).toBe('{"jsonrpc":"2.0","id":1,');
    fb.push('"method":"a"}\n');
    expect(fb.length).toBe(1);
    expect(fb.pending).toBe("");
  });

  it("drains all frames at once", () => {
    const fb = new FrameBuffer();
    fb.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    const all = fb.drain();
    expect(all).toHaveLength(3);
    expect(fb.length).toBe(0);
  });

  it("ignores empty lines", () => {
    const fb = new FrameBuffer();
    fb.push('\n\n{"a":1}\n\n');
    expect(fb.length).toBe(1);
  });
});
