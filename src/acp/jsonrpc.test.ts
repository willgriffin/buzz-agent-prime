import { describe, expect, it } from "vitest";
import { parseFrame } from "./jsonrpc.js";
import { JSONRPC_ERROR } from "./protocol.js";

describe("parseFrame (outer ACP link)", () => {
  it("parses a valid request", () => {
    const outcome = parseFrame('{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}}');
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.message).toMatchObject({ id: 1, method: "session/prompt" });
    }
  });

  it("parses a valid notification", () => {
    const outcome = parseFrame(
      '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}',
    );
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.message).toMatchObject({ method: "session/cancel" });
    }
  });

  it("parses a valid response", () => {
    const outcome = parseFrame('{"jsonrpc":"2.0","id":"x","result":{}}');
    expect(outcome.kind).toBe("message");
  });

  it("rejects invalid JSON with a parse error and null id", () => {
    const outcome = parseFrame("{not json");
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.response.id).toBeNull();
      expect(outcome.response.error.code).toBe(JSONRPC_ERROR.parseError);
    }
  });

  it("rejects non-object JSON as an invalid request", () => {
    for (const text of ["42", '"hello"', "true"]) {
      const outcome = parseFrame(text);
      expect(outcome.kind).toBe("invalid");
      if (outcome.kind === "invalid") {
        expect(outcome.response.error.code).toBe(JSONRPC_ERROR.invalidRequest);
      }
    }
  });

  it("rejects batches: a single multiplexer cannot route them per session", () => {
    const outcome = parseFrame('[{"jsonrpc":"2.0","id":1,"method":"initialize"}]');
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.response.error.code).toBe(JSONRPC_ERROR.invalidRequest);
      expect(outcome.response.error.data).toEqual({ reason: "batch_not_supported" });
    }
  });

  it("tolerates surrounding whitespace", () => {
    const outcome = parseFrame('  {"jsonrpc":"2.0","id":2,"method":"initialize"}\r');
    expect(outcome.kind).toBe("message");
  });

  it("rejects an empty frame as invalid", () => {
    const outcome = parseFrame("");
    expect(outcome.kind).toBe("invalid");
  });
});
