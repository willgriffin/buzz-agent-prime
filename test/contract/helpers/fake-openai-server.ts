/**
 * Deterministic fake OpenAI-compatible server for ACP tests.
 *
 * Provides a minimal `/v1/chat/completions` endpoint that returns
 * deterministic responses based on the input prompt. No paid model
 * credentials required.
 *
 * Intended for contract tests that need to verify the Prime agent's
 * model call path through the multiplexer. The fake server supports
 * both streaming (SSE) and non-streaming responses.
 */

import * as http from "node:http";
import { randomUUID } from "node:crypto";

export interface FakeOpenAIOptions {
  /** Port to listen on (0 = random free port). */
  port?: number;
  /** Host to bind (default: 127.0.0.1). */
  host?: string;
  /** Delay before sending each chunk (ms). */
  chunkDelayMs?: number;
  /** Fallback response text. */
  defaultResponse?: string;
  /**
   * If true, return 401 for requests without an Authorization header
   * that starts with "Bearer sk-". Tests can set this to verify
   * credential handling.
   */
  requireAuth?: boolean;
  /**
   * Record all requests for inspection in tests.
   * Default: true.
   */
  recordRequests?: boolean;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  timestamp: number;
}

export class FakeOpenAIServer {
  private readonly server: http.Server;
  private readonly opts: Required<FakeOpenAIOptions>;
  private readonly requests: RecordedRequest[] = [];
  private startedPort = 0;

  constructor(opts: FakeOpenAIOptions = {}) {
    this.opts = {
      port: opts.port ?? 0,
      host: opts.host ?? "127.0.0.1",
      chunkDelayMs: opts.chunkDelayMs ?? 0,
      defaultResponse: opts.defaultResponse ?? "Hello from fake OpenAI server.",
      requireAuth: opts.requireAuth ?? false,
      recordRequests: opts.recordRequests ?? true,
    };

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  get port(): number {
    return this.startedPort;
  }

  get url(): string {
    return `http://${this.opts.host}:${this.startedPort}`;
  }

  get recorded(): readonly RecordedRequest[] {
    return this.requests;
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
      this.server.close(() => resolve());
    });
  }

  clearRecorded(): void {
    this.requests.length = 0;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsedBody: unknown = null;
      try {
        if (body.length > 0) {
          parsedBody = JSON.parse(body);
        }
      } catch {
        // leave as null
      }

      if (this.opts.recordRequests) {
        this.requests.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: parsedBody,
          timestamp: Date.now(),
        });
      }

      // Auth check
      if (this.opts.requireAuth) {
        const auth = req.headers["authorization"];
        if (typeof auth !== "string" || !auth.startsWith("Bearer sk-")) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Missing API key" } }));
          return;
        }
      }

      if (req.url === "/v1/models") {
        this.handleListModels(res);
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        this.handleChatCompletions(res, parsedBody);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
    });
  }

  private handleListModels(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "gpt-4o", object: "model", created: 0, owned_by: "fake" },
          { id: "gpt-4o-mini", object: "model", created: 0, owned_by: "fake" },
        ],
      }),
    );
  }

  private handleChatCompletions(res: http.ServerResponse, body: unknown): void {
    const reqBody = body as {
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
      model?: string;
    } | null;

    if (reqBody === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid request body" } }));
      return;
    }

    // Deterministic response: echo back the last user message content
    const messages = reqBody.messages ?? [];
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg?.content ?? "";
    const responseText = this.deterministicResponse(prompt);

    const id = `chatcmpl-${randomUUID()}`;
    const model = reqBody.model ?? "gpt-4o";
    const created = Math.floor(Date.now() / 1000);

    if (reqBody.stream === true) {
      this.handleStreamingResponse(res, id, model, created, responseText);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseText },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: responseText.split(" ").length,
            total_tokens: 10 + responseText.split(" ").length,
          },
        }),
      );
    }
  }

  private handleStreamingResponse(
    res: http.ServerResponse,
    id: string,
    model: string,
    created: number,
    text: string,
  ): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const words = text.split(" ");
    let sentWordCount = 0;

    const sendChunk = (delta: Record<string, unknown>) => {
      const data: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const sendWord = () => {
      if (sentWordCount < words.length) {
        const word = words[sentWordCount];
        const prefix = sentWordCount > 0 ? " " : "";
        sendChunk({ content: prefix + word });
        sentWordCount++;
        if (this.opts.chunkDelayMs > 0) {
          setTimeout(sendWord, this.opts.chunkDelayMs);
        } else {
          sendWord();
        }
      } else {
        // Final chunk
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    };

    sendWord();
  }

  private deterministicResponse(prompt: string): string {
    if (prompt.length === 0) {
      return this.opts.defaultResponse;
    }

    // Deterministic: hash the prompt to a fixed response
    let hash = 0;
    for (let i = 0; i < prompt.length; i++) {
      hash = ((hash << 5) - hash + prompt.charCodeAt(i)) | 0;
    }

    const responses = [
      this.opts.defaultResponse,
      `Response to "${prompt.slice(0, 50)}": analysis complete.`,
      `Processed prompt (hash=${hash}): all checks passed.`,
      `Mock model output for prompt length ${prompt.length}.`,
    ];

    return responses[Math.abs(hash) % responses.length];
  }
}

/**
 * Start a fake OpenAI server, run a test function, then stop it.
 */
export async function withFakeOpenAI<T>(
  opts: FakeOpenAIOptions,
  fn: (server: FakeOpenAIServer) => Promise<T>,
): Promise<T> {
  const server = new FakeOpenAIServer(opts);
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}
