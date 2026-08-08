/**
 * Newline-delimited JSON framing for the ACP transport.
 *
 * One JSON-RPC 2.0 message per line. A line that exceeds the frame limit is
 * reported as `tooLarge` so the caller can fail the frame *without* corrupting
 * the stdout stream: the decoder keeps its position at the next newline and
 * the protocol continues. Malformed JSON is likewise a caller-level decision;
 * this module only guarantees framing is bounded and deterministic.
 *
 * The limit is deliberately symmetric with buzz-acp's `MAX_LINE_SIZE`
 * (10 MB), so the multiplexer never accepts a frame it could not itself
 * forward over a standard harness link.
 */

/** Maximum accepted size of a single NDJSON frame, in bytes. */
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;

/** A decoded frame, or an oversized-line failure. */
export type DecodeEvent =
  { type: "frame"; text: string } | { type: "tooLarge"; bytes: number; limit: number };

/**
 * Incrementally splits a byte stream into newline-terminated lines.
 *
 * Only the newly pushed chunk is scanned for newlines, so splitting costs
 * O(total bytes) no matter how many chunks a line spans. The pending tail is
 * copied so a caller cannot pin a large chunk by mutating it later.
 */
export class LineDecoder {
  /** Bytes of the current (incomplete) line, carried across chunks. */
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  readonly #limit: number;

  constructor(limit: number = MAX_FRAME_BYTES) {
    this.#limit = limit;
  }

  /** Consume a chunk, returning each complete frame and any overflow. */
  push(chunk: Uint8Array): DecodeEvent[] {
    const events: DecodeEvent[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      events.push(...this.#takeLine(chunk.subarray(start, i)));
      start = i + 1;
    }
    if (start < chunk.length) {
      this.#pending.push(new Uint8Array(chunk.subarray(start)));
      this.#pendingBytes += chunk.length - start;
      // Fail fast on a tail that already exceeds the limit: do not wait for a
      // newline that may never come (a rogue peer could stream forever).
      if (this.#pendingBytes > this.#limit) {
        this.#pending = [];
        const bytes = this.#pendingBytes;
        this.#pendingBytes = 0;
        events.push({ type: "tooLarge", bytes, limit: this.#limit });
      }
    }
    return events;
  }

  /**
   * Return the trailing unterminated line at end of stream and reset the
   * buffer. A frame that was already rejected as oversized is not re-reported.
   */
  flush(): DecodeEvent[] {
    if (this.#pending.length === 0) return [];
    const events = this.#takeLine(new Uint8Array(0));
    this.#pending = [];
    this.#pendingBytes = 0;
    return events;
  }

  /** Bytes currently buffered awaiting a newline. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  #takeLine(tail: Uint8Array): DecodeEvent[] {
    const total = this.#pendingBytes + tail.length;
    if (total > this.#limit) {
      this.#pending = [];
      this.#pendingBytes = 0;
      return [{ type: "tooLarge", bytes: total, limit: this.#limit }];
    }
    if (this.#pending.length === 0) {
      return tail.length === 0 ? [] : [{ type: "frame", text: decodeUtf8(tail) }];
    }
    const line = new Uint8Array(total);
    let offset = 0;
    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.length;
    }
    line.set(tail, offset);
    this.#pending = [];
    this.#pendingBytes = 0;
    return [{ type: "frame", text: decodeUtf8(line) }];
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
