import { describe, expect, it } from "vitest";
import { LineDecoder, MAX_FRAME_BYTES } from "./frame-codec.js";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("LineDecoder (ACP NDJSON framing)", () => {
  it("splits complete lines in a single chunk", () => {
    const decoder = new LineDecoder();
    const events = decoder.push(encode('{"a":1}\n{"b":2}\n'));
    expect(events).toEqual([
      { type: "frame", text: '{"a":1}' },
      { type: "frame", text: '{"b":2}' },
    ]);
  });

  it("carries a partial line across chunks", () => {
    const decoder = new LineDecoder();
    const first = decoder.push(encode('{"par'));
    expect(first).toEqual([]);
    const second = decoder.push(encode('tial":true}\n'));
    expect(second).toEqual([{ type: "frame", text: '{"partial":true}' }]);
  });

  it("handles multiple lines split across chunk boundaries", () => {
    const decoder = new LineDecoder();
    const events = [
      ...decoder.push(encode('{"a":1}\n{"b"')),
      ...decoder.push(encode(':2}\n{"c":3}\n')),
    ];
    expect(events).toEqual([
      { type: "frame", text: '{"a":1}' },
      { type: "frame", text: '{"b":2}' },
      { type: "frame", text: '{"c":3}' },
    ]);
  });

  it("flushes a trailing unterminated line at EOF", () => {
    const decoder = new LineDecoder();
    decoder.push(encode('{"a":1}\n{"trailing":true}'));
    expect(decoder.flush()).toEqual([{ type: "frame", text: '{"trailing":true}' }]);
  });

  it("does not re-report an oversized frame on flush", () => {
    const decoder = new LineDecoder(16);
    decoder.push(encode("0123456789abcdef0123456789"));
    expect(decoder.flush()).toEqual([]);
  });

  it("rejects an oversized line and recovers at the next newline", () => {
    const decoder = new LineDecoder(16);
    const events = decoder.push(encode('0123456789abcdef0123456789\n{"ok":true}\n'));
    expect(events).toEqual([
      { type: "tooLarge", bytes: 26, limit: 16 },
      { type: "frame", text: '{"ok":true}' },
    ]);
  });

  it("tracks pending bytes for a growing tail", () => {
    const decoder = new LineDecoder(16);
    decoder.push(encode("0123456789"));
    expect(decoder.pendingBytes).toBe(10);
    decoder.push(encode("abc"));
    expect(decoder.pendingBytes).toBe(13);
    expect(decoder.flush()).toEqual([{ type: "frame", text: "0123456789abc" }]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("defaults to the 10 MiB transport limit", () => {
    expect(new LineDecoder().pendingBytes).toBe(0);
    const decoder = new LineDecoder();
    const payload = "x".repeat(MAX_FRAME_BYTES + 1);
    const events = decoder.push(encode(`${payload}\n`));
    expect(events).toEqual([
      { type: "tooLarge", bytes: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES },
    ]);
  });
});
