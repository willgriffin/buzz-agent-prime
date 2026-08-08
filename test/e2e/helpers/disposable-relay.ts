/**
 * Disposable Buzz relay mock for e2e tests.
 *
 * Implements a minimal WebSocket relay using only Node built-in modules
 * (no external `ws` dependency). Provides just enough RFC 6455 surface
 * area for e2e tests of buzz-acp + buzz-agent-prime integration without
 * requiring the real Buzz infrastructure or the `ws` npm package.
 *
 * Supports:
 * - WebSocket handshake (HTTP upgrade + Sec-WebSocket-Accept)
 * - Text frames (opcode 0x1)
 * - Close frames (opcode 0x8)
 * - Ping/Pong (opcode 0x9/0xA)
 * - Client-to-server masking (RFC 6455 requirement)
 * - Simple auth, channel join, message/mention routing
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export interface DisposableRelayOptions {
  port?: number;
  host?: string;
}

export interface RelayMessage {
  type: string;
  content: string;
  channel?: string;
  pubkey?: string;
  id: string;
  timestamp: number;
}

// WebSocket opcodes
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

interface ConnectedAgent {
  socket: Socket;
  pubkey?: string;
  channels: Set<string>;
  writeQueue: Buffer[];
  isClosed: boolean;
}

/**
 * A minimal disposable relay that:
 * 1. Accepts WebSocket connections (raw RFC 6455)
 * 2. Handles simple auth (accepts any key for testing)
 * 3. Routes messages between connected agents
 * 4. Records all messages for test inspection
 */
export class DisposableRelay {
  private readonly server: http.Server;
  private readonly agents = new Map<string, ConnectedAgent>();
  private readonly messages: RelayMessage[] = [];
  private startedPort = 0;
  private readonly opts: Required<DisposableRelayOptions>;

  constructor(opts: DisposableRelayOptions = {}) {
    this.opts = {
      port: opts.port ?? 0,
      host: opts.host ?? "127.0.0.1",
    };

    this.server = http.createServer();

    this.server.on("upgrade", (req, socket) => {
      this.handleUpgrade(req, socket);
    });
  }

  get port(): number {
    return this.startedPort;
  }

  get url(): string {
    return `ws://${this.opts.host}:${this.startedPort}`;
  }

  get recordedMessages(): readonly RelayMessage[] {
    return this.messages;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server.address();
        this.startedPort = typeof addr === "object" && addr !== null ? addr.port : this.opts.port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const agent of this.agents.values()) {
        if (!agent.isClosed) {
          this.sendClose(agent.socket, 1000, "shutdown");
        }
      }
      this.server.close(() => resolve());
    });
  }

  clearRecorded(): void {
    this.messages.length = 0;
  }

  // --- WebSocket handshake ---

  private handleUpgrade(req: http.IncomingMessage, socket: Socket): void {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const responseLines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ];

    socket.write(responseLines.join("\r\n"));

    const agentId = randomUUID();
    const agent: ConnectedAgent = {
      socket,
      channels: new Set(),
      writeQueue: [],
      isClosed: false,
    };
    this.agents.set(agentId, agent);

    // Start reading frames
    this.readFrames(agentId, socket);
  }

  // --- WebSocket frame parsing ---

  private readFrames(agentId: string, socket: Socket): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Try to parse complete frames
      while (buffer.length >= 2) {
        const result = this.parseFrame(buffer);
        if (result === null) break; // incomplete frame

        const { frame, consumed } = result;
        buffer = buffer.subarray(consumed);

        this.handleFrame(agentId, frame);
      }
    });

    socket.on("close", () => {
      const a = this.agents.get(agentId);
      if (a) a.isClosed = true;
      this.agents.delete(agentId);
    });

    socket.on("error", () => {
      this.agents.delete(agentId);
    });
  }

  private parseFrame(buffer: Buffer): { frame: ParsedFrame; consumed: number } | null {
    if (buffer.length < 2) return null;

    const b0 = buffer[0]!;
    const b1 = buffer[1]!;

    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    // Extended payload length
    if (payloadLen === 126) {
      if (buffer.length < offset + 2) return null;
      payloadLen = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buffer.length < offset + 8) return null;
      // Read as BigInt then convert (frames shouldn't exceed 2^53)
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      payloadLen = high * 0x100000000 + low;
      offset += 8;
    }

    // Masking key
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    // Payload
    if (buffer.length < offset + payloadLen) return null;
    let payload = buffer.subarray(offset, offset + payloadLen);

    // Unmask if needed
    if (masked && maskKey !== null) {
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
      }
      payload = unmasked;
    }

    return {
      frame: { fin, opcode, payload },
      consumed: offset + payloadLen,
    };
  }

  private handleFrame(agentId: string, frame: ParsedFrame): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.isClosed) return;

    switch (frame.opcode) {
      case OP_TEXT: {
        const text = frame.payload.toString("utf-8");
        try {
          const msg = JSON.parse(text);
          this.handleMessage(agentId, msg);
        } catch {
          // ignore malformed JSON
        }
        break;
      }
      case OP_PING:
        this.sendFrame(agent.socket, OP_PONG, frame.payload);
        break;
      case OP_PONG:
        // ignore
        break;
      case OP_CLOSE:
        agent.isClosed = true;
        this.sendClose(agent.socket, 1000, "");
        this.agents.delete(agentId);
        break;
      case OP_CONT:
      case OP_BINARY:
        // not used in our protocol
        break;
    }
  }

  // --- WebSocket frame sending (server-to-client, no mask) ---

  private sendFrame(socket: Socket, opcode: number, payload: Buffer | string): void {
    const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
    const frames: number[] = [];

    // FIN + opcode
    frames.push(0x80 | opcode);

    // Payload length (no mask for server-to-client)
    if (data.length < 126) {
      frames.push(data.length);
    } else if (data.length < 65536) {
      frames.push(126);
      // 16-bit length
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(data.length, 0);
      socket.write(Buffer.from(frames));
      socket.write(lenBuf);
      socket.write(data);
      return;
    } else {
      frames.push(127);
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64BE(BigInt(data.length), 0);
      socket.write(Buffer.from(frames));
      socket.write(lenBuf);
      socket.write(data);
      return;
    }

    socket.write(Buffer.from(frames));
    socket.write(data);
  }

  private sendClose(socket: Socket, code: number, reason: string): void {
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, "utf-8");
    this.sendFrame(socket, OP_CLOSE, payload);
    socket.end();
  }

  // --- Message routing ---

  private sendTo(agent: ConnectedAgent, msg: Record<string, unknown>): void {
    if (agent.isClosed) return;
    this.sendFrame(agent.socket, OP_TEXT, JSON.stringify(msg));
  }

  private handleMessage(agentId: string, msg: Record<string, unknown>): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Handle auth
    if (msg["type"] === "auth" && typeof msg["pubkey"] === "string") {
      agent.pubkey = msg["pubkey"];
      this.sendTo(agent, { type: "auth_ok", pubkey: msg["pubkey"] });
      return;
    }

    // Handle channel join
    if (msg["type"] === "join" && typeof msg["channel"] === "string") {
      agent.channels.add(msg["channel"]);
      this.sendTo(agent, { type: "joined", channel: msg["channel"] });
      return;
    }

    // Handle message broadcast
    if (msg["type"] === "message") {
      const relayMsg: RelayMessage = {
        id: randomUUID(),
        type: "message",
        content: String(msg["content"] ?? ""),
        channel: typeof msg["channel"] === "string" ? msg["channel"] : undefined,
        pubkey: agent.pubkey,
        timestamp: Date.now(),
      };
      this.messages.push(relayMsg);

      // Broadcast to all agents in the same channel
      for (const other of this.agents.values()) {
        if (
          other !== agent &&
          relayMsg.channel !== undefined &&
          other.channels.has(relayMsg.channel)
        ) {
          this.sendTo(other, relayMsg as unknown as Record<string, unknown>);
        }
      }

      // Echo back to sender as ACK
      this.sendTo(agent, { type: "ack", id: relayMsg.id });
      return;
    }

    // Handle mention (Nostr-style)
    if (msg["type"] === "mention") {
      const relayMsg: RelayMessage = {
        id: randomUUID(),
        type: "mention",
        content: String(msg["content"] ?? ""),
        channel: typeof msg["channel"] === "string" ? msg["channel"] : undefined,
        pubkey: agent.pubkey,
        timestamp: Date.now(),
      };
      this.messages.push(relayMsg);

      // Broadcast to all agents (mentions are channel-wide)
      for (const other of this.agents.values()) {
        if (other !== agent) {
          this.sendTo(other, relayMsg as unknown as Record<string, unknown>);
        }
      }
      this.sendTo(agent, { type: "ack", id: relayMsg.id });
      return;
    }
  }
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}
