import { createHash } from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";

export type RelayWireMessage = readonly unknown[];
export interface FilterableRelayEvent {
  id: string;
  kind: number;
  tags: string[][];
}

export interface ScriptedNostrRelayOptions {
  onConnect?: (relay: ScriptedNostrRelay) => void | Promise<void>;
  onMessage?: (message: RelayWireMessage, relay: ScriptedNostrRelay) => void | Promise<void>;
  /** When set, automatically return only events matching the Nostr REQ filters. */
  filterEvents?: readonly FilterableRelayEvent[];
  /** Maximum automatically-returned events per event-loop turn (defaults to 16). */
  filterBatchSize?: number;
}

/** A deliberately small RFC 6455 server for deterministic Nostr client tests. */
export class ScriptedNostrRelay {
  private readonly server = http.createServer();
  private socket: Socket | undefined;
  private readonly sockets = new Set<Socket>();
  private portNumber = 0;
  private input = Buffer.alloc(0);
  private readonly waiters: Array<(message: RelayWireMessage) => void> = [];
  readonly messages: RelayWireMessage[] = [];
  connections = 0;

  constructor(private readonly options: ScriptedNostrRelayOptions = {}) {
    this.server.on("upgrade", (request, socket) => this.accept(request, socket));
  }

  get url(): string {
    return `ws://127.0.0.1:${this.portNumber}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("relay did not bind a TCP port"));
          return;
        }
        this.portNumber = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      // A conversation fetch can open several sequential sockets. `server.close`
      // waits for all upgraded sockets, so destroy every tracked connection.
      for (const socket of this.sockets) socket.destroy();
    });
  }

  send(message: RelayWireMessage): void {
    if (!this.socket || this.socket.destroyed) throw new Error("relay has no connected client");
    this.sendText(JSON.stringify(message));
  }

  sendText(text: string): void {
    if (!this.socket || this.socket.destroyed) throw new Error("relay has no connected client");
    const payload = Buffer.from(text, "utf8");
    const header = websocketHeader(0x1, payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    this.socket?.end(Buffer.from([0x88, 0x00]));
  }

  /** Resolve once the next client message arrives, with a test-sized deadline. */
  nextMessage(timeoutMs = 1_000): Promise<RelayWireMessage> {
    const buffered = this.messages.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for relay client message")),
        timeoutMs,
      );
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  private accept(request: http.IncomingMessage, socket: Socket): void {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    this.socket = socket;
    this.sockets.add(socket);
    this.connections++;
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    void this.options.onConnect?.(this);
  }

  private read(chunk: Buffer): void {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 2) {
      const first = this.input[0]!;
      const second = this.input[1]!;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.input.length < 4) return;
        length = this.input.readUInt16BE(2);
        offset = 4;
      }
      const masked = (second & 0x80) !== 0;
      if (!masked || this.input.length < offset + 4 + length) return;
      const mask = this.input.subarray(offset, offset + 4);
      offset += 4;
      const body = this.input.subarray(offset, offset + length);
      this.input = this.input.subarray(offset + length);
      if (opcode === 0x8) return;
      if (opcode !== 0x1) continue;
      const decoded = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index++) decoded[index] = body[index]! ^ mask[index % 4]!;
      const message = JSON.parse(decoded.toString("utf8")) as RelayWireMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
      void this.respondToFilteredRequest(message);
      void this.options.onMessage?.(message, this);
    }
  }

  private async respondToFilteredRequest(message: RelayWireMessage): Promise<void> {
    if (!this.options.filterEvents || message[0] !== "REQ" || typeof message[1] !== "string")
      return;
    const filters = message.slice(2).filter(isRecord);
    const matching = this.options.filterEvents.filter((event) =>
      filters.some((filter) => matchesFilter(event, filter)),
    );
    const batchSize = this.options.filterBatchSize ?? 16;
    for (let index = 0; index < matching.length; index++) {
      this.send(["EVENT", message[1], matching[index]!]);
      if ((index + 1) % batchSize === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.send(["EOSE", message[1]]);
  }
}

function websocketHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesFilter(event: FilterableRelayEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter["ids"]) && !filter["ids"].includes(event.id)) return false;
  if (Array.isArray(filter["kinds"]) && !filter["kinds"].includes(event.kind)) return false;
  return ["#e", "#E"].every((key) => {
    const expected = filter[key];
    if (!Array.isArray(expected)) return true;
    const tagName = key.slice(1);
    return event.tags.some((tag) => tag[0] === tagName && expected.includes(tag[1]));
  });
}
