import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { FakeOpenAIServer } from "./helpers/fake-openai-server.js";

describe("FakeOpenAIServer", () => {
  let server: FakeOpenAIServer;

  beforeAll(async () => {
    server = new FakeOpenAIServer({ port: 0 });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("starts and listens on a free port", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("responds to /v1/models", async () => {
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.id).toBe("gpt-4o");
  });

  it("responds to /v1/chat/completions (non-streaming)", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello world" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]!.message.content.length).toBeGreaterThan(0);
  });

  it("returns deterministic responses for the same prompt", async () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "deterministic test prompt" }],
      stream: false,
    };
    const res1 = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res2 = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data1 = (await res1.json()) as { choices: Array<{ message: { content: string } }> };
    const data2 = (await res2.json()) as { choices: Array<{ message: { content: string } }> };
    expect(data1.choices[0]!.message.content).toBe(data2.choices[0]!.message.content);
  });

  it("records requests for later inspection", async () => {
    server.clearRecorded();
    await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "recorded request" }],
      }),
    });
    expect(server.recorded).toHaveLength(1);
    expect(server.recorded[0]!.url).toBe("/v1/chat/completions");
    expect(server.recorded[0]!.method).toBe("POST");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${server.url}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe("FakeOpenAIServer — auth enforcement", () => {
  let server: FakeOpenAIServer;

  beforeAll(async () => {
    server = new FakeOpenAIServer({ port: 0, requireAuth: true });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects requests without authorization", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "no auth" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with valid bearer key", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test-key",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "with auth" }],
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("FakeOpenAIServer — streaming", () => {
  let server: FakeOpenAIServer;

  beforeAll(async () => {
    server = new FakeOpenAIServer({ port: 0, chunkDelayMs: 0 });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("streams SSE chunks and terminates with [DONE]", async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "stream me" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");

    // Should have at least one content chunk and one stop chunk
    const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    expect(lines.length).toBeGreaterThan(0);

    // Last non-DONE chunk should have finish_reason "stop"
    const lastChunk = JSON.parse(lines[lines.length - 1]!.slice(6));
    expect(lastChunk.choices[0].finish_reason).toBe("stop");
  });
});
