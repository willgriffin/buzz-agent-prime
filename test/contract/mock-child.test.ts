import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  getMockChildPath,
  clearMockChildCache,
  type MockChildOptions,
} from "./helpers/mock-child.js";
import { parseFrame } from "./helpers/ndjson.js";
import type { JsonRpcResult, JsonRpcNotification } from "./helpers/types.js";

/**
 * Spawn the mock child, run an interaction function, close stdin, and
 * collect all stdout frames until the child exits.
 */
async function runMockChild(
  opts: MockChildOptions,
  interactions: (
    send: (frame: Record<string, unknown>) => void,
    frames: Array<Record<string, unknown>>,
  ) => Promise<void>,
  timeoutMs = 5000,
): Promise<{
  frames: Array<Record<string, unknown>>;
  stderr: string;
  exitCode: number | null;
}> {
  const mockPath = getMockChildPath(opts);
  const child = spawn("node", [mockPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const frames: Array<Record<string, unknown>> = [];
  let stderr = "";
  let pending = "";

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");

  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    let idx: number;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx).trimEnd();
      pending = pending.slice(idx + 1);
      if (line.length === 0) continue;
      const result = parseFrame(line);
      if (result.ok) {
        frames.push(result.frame as Record<string, unknown>);
      }
    }
  });

  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const send = (frame: Record<string, unknown>) => {
    child.stdin?.write(JSON.stringify(frame) + "\n");
  };

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  await interactions(send, frames);

  // Close stdin to let the child exit (mock listens for stdin "end")
  child.stdin?.end();

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode = await exitPromise;
  clearTimeout(timer);

  // Brief grace period for any final stdout frames
  await new Promise((r) => setTimeout(r, 50));

  return { frames, stderr, exitCode };
}

afterEach(() => {
  clearMockChildCache();
});

/** Helper: send initialize, wait, then return. */
async function init(send: (f: Record<string, unknown>) => void): Promise<void> {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 2, info: { name: "test", version: "0" } },
  });
  await new Promise((r) => setTimeout(r, 100));
}

/** Helper: send session/new and return the sessionId from collected frames. */
async function newSession(
  send: (f: Record<string, unknown>) => void,
  frames: Array<Record<string, unknown>>,
): Promise<string> {
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
  await new Promise((r) => setTimeout(r, 100));
  const resp = frames.find((f) => f["id"] === 2 && f["result"]) as JsonRpcResult | undefined;
  if (!resp) throw new Error("No session/new response");
  return (resp.result as { sessionId: string }).sessionId;
}

describe("Mock ACP child — protocol compliance", () => {
  it("responds to initialize with protocol version 2", async () => {
    const { frames } = await runMockChild({}, async (send) => {
      await init(send);
    });

    const initResp = frames.find((f) => f["id"] === 1 && f["result"]) as JsonRpcResult | undefined;
    expect(initResp).toBeDefined();
    expect(initResp!.result).toHaveProperty("protocolVersion", 2);
    expect(initResp!.result).toHaveProperty("info.name", "mock-prime-agent");
  });

  it("creates a new session with a unique session ID", async () => {
    const { frames } = await runMockChild({}, async (send, fr) => {
      await init(send);
      await newSession(send, fr);
    });

    const newResp = frames.find((f) => f["id"] === 2 && f["result"]) as JsonRpcResult | undefined;
    expect(newResp).toBeDefined();
    const result = newResp!.result as { sessionId: string };
    expect(result.sessionId).toMatch(/^mock-session-/);
  });

  it("processes a prompt with running → message → idle progression", async () => {
    const { frames } = await runMockChild({}, async (send, fr) => {
      await init(send);
      const sid = await newSession(send, fr);
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: sid, prompt: [{ type: "text", text: "hello" }] },
      });
      await new Promise((r) => setTimeout(r, 200));
    });

    const updates = frames.filter((f) => f["method"] === "session/update") as JsonRpcNotification[];

    expect(updates.length).toBeGreaterThan(0);

    const runningStates = updates.filter((u) => {
      const p = u.params as { update: { sessionUpdate: string; state?: string } };
      return p.update.sessionUpdate === "state_update" && p.update.state === "running";
    });
    expect(runningStates.length).toBeGreaterThan(0);

    const messages = updates.filter((u) => {
      const p = u.params as { update: { sessionUpdate: string } };
      return p.update.sessionUpdate.startsWith("agent_message");
    });
    expect(messages.length).toBeGreaterThan(0);

    const idleStates = updates.filter((u) => {
      const p = u.params as {
        update: { sessionUpdate: string; state?: string; stopReason?: string };
      };
      return (
        p.update.sessionUpdate === "state_update" &&
        p.update.state === "idle" &&
        p.update.stopReason === "end_turn"
      );
    });
    expect(idleStates.length).toBeGreaterThan(0);
  });

  it("responds to session/prompt request with result", async () => {
    const { frames } = await runMockChild({}, async (send, fr) => {
      await init(send);
      const sid = await newSession(send, fr);
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: sid, prompt: [{ type: "text", text: "ack test" }] },
      });
      await new Promise((r) => setTimeout(r, 200));
    });

    const promptResp = frames.find((f) => f["id"] === 3 && f["result"]) as
      JsonRpcResult | undefined;
    expect(promptResp).toBeDefined();
  });
});

describe("Mock ACP child — cancellation", () => {
  it("sends cancelled state_update after session/cancel", async () => {
    const { frames } = await runMockChild(
      { responseDelayMs: 500 },
      async (send, fr) => {
        await init(send);
        const sid = await newSession(send, fr);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: sid, prompt: [{ type: "text", text: "cancel me" }] },
        });
        // Wait for running, then cancel
        await new Promise((r) => setTimeout(r, 200));
        send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } });
        await new Promise((r) => setTimeout(r, 600));
      },
      8000,
    );

    const updates = frames.filter((f) => f["method"] === "session/update") as JsonRpcNotification[];

    const cancelledStates = updates.filter((u) => {
      const p = u.params as { update: { sessionUpdate: string; stopReason?: string } };
      return p.update.sessionUpdate === "state_update" && p.update.stopReason === "cancelled";
    });
    expect(cancelledStates.length).toBeGreaterThan(0);
  });
});

describe("Mock ACP child — crash simulation", () => {
  it("exits with code 1 on crashOnStart", async () => {
    const { exitCode } = await runMockChild({ crashOnStart: true }, async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(exitCode).toBe(1);
  });

  it("exits with code 1 on crashOnPrompt and writes crash to stderr", async () => {
    const { exitCode, stderr } = await runMockChild(
      { crashOnPrompt: true },
      async (send, fr) => {
        await init(send);
        const sid = await newSession(send, fr);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: sid, prompt: [{ type: "text", text: "crash" }] },
        });
        await new Promise((r) => setTimeout(r, 300));
      },
      5000,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("crash");
  });
});

describe("Mock ACP child — Prime metadata forwarding", () => {
  it("emits IPython lifecycle events during prompt", async () => {
    const { frames } = await runMockChild(
      { emitPrimeMetadata: true },
      async (send, fr) => {
        await init(send);
        const sid = await newSession(send, fr);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: sid, prompt: [{ type: "text", text: "metadata" }] },
        });
        await new Promise((r) => setTimeout(r, 300));
      },
      5000,
    );

    const ipythonEvents = frames.filter((f) => f["method"] === "_prime/ipython_lifecycle");
    expect(ipythonEvents.length).toBeGreaterThan(0);

    const events = ipythonEvents.map((f) => (f as { params: { event: string } }).params.event);
    expect(events).toContain("start");
    expect(events).toContain("ready");
  });

  it("emits subagent lifecycle events during prompt", async () => {
    const { frames } = await runMockChild(
      { emitPrimeMetadata: true },
      async (send, fr) => {
        await init(send);
        const sid = await newSession(send, fr);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: sid, prompt: [{ type: "text", text: "sub" }] },
        });
        await new Promise((r) => setTimeout(r, 300));
      },
      5000,
    );

    const subagentEvents = frames.filter((f) => f["method"] === "_prime/subagent_lifecycle");
    expect(subagentEvents.length).toBeGreaterThan(0);

    const events = subagentEvents.map((f) => (f as { params: { event: string } }).params.event);
    expect(events).toContain("spawn");
    expect(events).toContain("complete");
  });
});

describe("Mock ACP child — session/close", () => {
  it("responds to session/close and exits cleanly", async () => {
    const { frames, exitCode } = await runMockChild({}, async (send, fr) => {
      await init(send);
      const sid = await newSession(send, fr);
      send({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: sid } });
      await new Promise((r) => setTimeout(r, 200));
    });

    const closeResp = frames.find((f) => f["id"] === 3 && f["result"]) as JsonRpcResult | undefined;
    expect(closeResp).toBeDefined();
    expect(exitCode).toBe(0);
  });
});

describe("Mock ACP child — stdout discipline", () => {
  it("writes only valid ACP frames to stdout by default", async () => {
    const { frames, stderr } = await runMockChild({}, async (send) => {
      await init(send);
    });

    for (const f of frames) {
      expect(f["jsonrpc"]).toBe("2.0");
    }
    expect(stderr.trim()).toBe("");
  });

  it("violates stdout when configured (sends response to stderr)", async () => {
    const { frames, stderr } = await runMockChild({ violateStdout: true }, async (send) => {
      await init(send);
    });

    // No stdout frames since it writes to stderr instead
    expect(frames.length).toBe(0);
    // stderr should contain the response
    expect(stderr).toContain("jsonrpc");
  });
});

describe("Mock ACP child — unknown method", () => {
  it("returns method-not-found error for unknown methods", async () => {
    const { frames } = await runMockChild({}, async (send) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 2, info: { name: "test", version: "0" } },
      });
      await new Promise((r) => setTimeout(r, 100));
      send({ jsonrpc: "2.0", id: 99, method: "unknown/method", params: {} });
      await new Promise((r) => setTimeout(r, 100));
    });

    const errResp = frames.find((f) => f["id"] === 99 && f["error"]) as
      { error: { code: number; message: string } } | undefined;
    expect(errResp).toBeDefined();
    expect(errResp!.error.code).toBe(-32601);
  });
});
