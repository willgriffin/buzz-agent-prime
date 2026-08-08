/**
 * Mock ACP v2 child process for testing the buzz-agent-prime multiplexer.
 *
 * The buzz-agent-prime multiplexer spawns one child per `session/new`.
 * In production, this child is `prime-agent --mode acp`. For tests,
 * we provide a deterministic mock that speaks ACP v2 NDJSON over
 * stdin/stdout without requiring the real Prime binary or paid model
 * credentials.
 *
 * The mock is generated as a JS script string and written to a temp
 * file at test time, then spawned via `node <path>`. This avoids
 * committing a non-TS file that would need special ESLint handling.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface MockChildOptions {
  /**
   * If set, the child will exit with this code on the next `session/prompt`
   * instead of producing a normal response, simulating a crash.
   */
  crashOnPrompt?: boolean;
  /** Exit immediately with this code after start (before initialize). */
  crashOnStart?: boolean;
  /** Delay (ms) before each response — simulates latency. */
  responseDelayMs?: number;
  /**
   * If true, emit Prime extension notifications for IPython and
   * subagent lifecycle during session/prompt processing.
   */
  emitPrimeMetadata?: boolean;
  /**
   * Deterministic response text for agent messages.
   * Default: "Mock response for prompt N".
   */
  agentResponseText?: string;
  /**
   * Write to stderr instead of stdout (simulates stdout discipline violation).
   */
  violateStdout?: boolean;
}

/**
 * Get the path to a mock ACP child script. The script is written to a
 * temp file based on the provided options. Reuses the same file if the
 * options match.
 */
const cache = new Map<string, string>();

export function getMockChildPath(opts: MockChildOptions = {}): string {
  const key = JSON.stringify(opts);
  const cached = cache.get(key);
  if (cached !== undefined && fs.existsSync(cached)) {
    return cached;
  }

  const script = createMockChildScript(opts);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-acp-mock-"));
  const scriptPath = path.join(tmpDir, "mock-child.mjs");
  fs.writeFileSync(scriptPath, script, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  cache.set(key, scriptPath);
  return scriptPath;
}

/**
 * Clear the cached mock child scripts. Call in afterEach to avoid
 * temp-file accumulation across many test runs.
 */
export function clearMockChildCache(): void {
  for (const p of cache.values()) {
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  cache.clear();
}

function createMockChildScript(opts: MockChildOptions): string {
  const crashOnPrompt = opts.crashOnPrompt ?? false;
  const crashOnStart = opts.crashOnStart ?? false;
  const responseDelayMs = opts.responseDelayMs ?? 0;
  const emitPrimeMetadata = opts.emitPrimeMetadata ?? false;
  const agentResponseText = opts.agentResponseText ?? "Mock response for prompt {N}";
  const violateStdout = opts.violateStdout ?? false;

  return `#!/usr/bin/env node
// Auto-generated mock ACP v2 child for buzz-agent-prime tests.
// Do not edit — regenerate from test/contract/helpers/mock-child.ts.
"use strict";

const CRASH_ON_PROMPT = ${JSON.stringify(crashOnPrompt)};
const CRASH_ON_START = ${JSON.stringify(crashOnStart)};
const RESPONSE_DELAY_MS = ${JSON.stringify(responseDelayMs)};
const EMIT_PRIME_METADATA = ${JSON.stringify(emitPrimeMetadata)};
const AGENT_RESPONSE_TEXT = ${JSON.stringify(agentResponseText)};
const VIOLATE_STDOUT = ${JSON.stringify(violateStdout)};

const PROTOCOL_VERSION = 2;
let sessionId = null;
let promptCount = 0;
let alive = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStdout(obj) {
  const line = JSON.stringify(obj) + "\\n";
  process.stdout.write(line);
}

function writeStderr(msg) {
  process.stderr.write(msg + "\\n");
}

// --- helpers for writing to the correct stream ---

function respond(id, result) {
  if (VIOLATE_STDOUT) {
    process.stderr.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    return;
  }
  writeStdout({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeStdout({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  writeStdout({ jsonrpc: "2.0", method, params });
}

// --- session/update helpers ---

function stateUpdateRunning(sid) {
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "state_update", state: "running" } });
}

function stateUpdateIdle(sid, stopReason) {
  const update = { sessionUpdate: "state_update", state: "idle" };
  if (stopReason) { update.stopReason = stopReason; }
  notify("session/update", { sessionId: sid, update });
}

function agentMessageChunk(sid, messageId, text) {
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  });
}

function agentMessage(sid, messageId, text) {
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "agent_message",
      messageId,
      content: [{ type: "text", text }],
    },
  });
}

function primeIpythonLifecycle(sid, event, kernelId) {
  notify("_prime/ipython_lifecycle", { sessionId: sid, event, kernelId: kernelId || "mock-kernel-1" });
}

function primeSubagentLifecycle(sid, event, subagentId, subagentName) {
  notify("_prime/subagent_lifecycle", { sessionId: sid, event, subagentId: subagentId || "mock-sub-1", subagentName: subagentName || "worker" });
}

// --- main input handler ---

let stdinBuffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf("\\n")) >= 0) {
    const line = stdinBuffer.slice(0, idx).trimEnd();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (line.length === 0) continue;
    handleLine(line);
  }
});

process.stdin.on("end", () => {
  // stdin closed — child should exit cleanly
  process.exit(0);
});

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }

  if (!msg || msg.jsonrpc !== "2.0") {
    respondError(null, -32600, "Invalid Request");
    return;
  }

  // It's a notification if no "id" field
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, "id");

  if (isNotification) {
    handleNotification(msg);
    return;
  }

  await handleRequest(msg);
}

function handleNotification(msg) {
  const method = msg.method;
  const params = msg.params || {};

  if (method === "session/cancel") {
    if (alive && sessionId !== null) {
      stateUpdateIdle(sessionId, "cancelled");
    }
  } else if (method === "$/cancel_request") {
    // Protocol-level request cancellation — do nothing for mock
  }
  // Notifications don't get responses
}

async function handleRequest(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  if (CRASH_ON_START) {
    process.exit(1);
    return;
  }

  if (method === "initialize") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "mock-prime-agent", version: "0.0.0-mock" },
      capabilities: {
        session: {},
      },
    });
    return;
  }

  if (method === "session/new") {
    sessionId = "mock-session-" + Math.random().toString(36).slice(2, 10);
    respond(id, { sessionId: sessionId });
    return;
  }

  if (method === "session/prompt") {
    if (CRASH_ON_PROMPT) {
      // Simulate a child crash
      writeStderr("mock-child: simulating crash");
      process.exit(1);
      return;
    }

    promptCount++;
    const sid = params.sessionId || sessionId;
    const messageId = "msg-" + promptCount;
    const text = AGENT_RESPONSE_TEXT.replace("{N}", String(promptCount));

    // State: running
    stateUpdateRunning(sid);

    if (RESPONSE_DELAY_MS > 0) {
      await sleep(RESPONSE_DELAY_MS);
    }

    // Emit Prime metadata if configured
    if (EMIT_PRIME_METADATA) {
      primeIpythonLifecycle(sid, "start");
      primeIpythonLifecycle(sid, "ready");
      primeSubagentLifecycle(sid, "spawn");
    }

    // Stream agent message
    agentMessageChunk(sid, messageId, text);
    agentMessage(sid, messageId, text);

    if (EMIT_PRIME_METADATA) {
      primeSubagentLifecycle(sid, "complete");
    }

    // State: idle
    stateUpdateIdle(sid, "end_turn");

    // Acknowledge prompt request
    respond(id, {});
    return;
  }

  if (method === "session/close") {
    alive = false;
    respond(id, {});
    // Optionally exit after close
    setTimeout(() => process.exit(0), 50);
    return;
  }

  if (method === "session/list") {
    respond(id, { sessions: [] });
    return;
  }

  // Unknown method
  respondError(id, -32601, "Method not found");
}

// Keep process alive — wait for stdin
process.stdin.resume();

if (CRASH_ON_START) {
  // Will exit on next tick
  setTimeout(() => process.exit(1), 0);
}
`;
}

/**
 * Build the environment variables that tell buzz-agent-prime to use
 * the mock child instead of the real `prime-agent` binary.
 *
 * The multiplexer (issue #3) is expected to honour:
 * - `BUZZ_AGENT_PRIME_PRIME_BIN` — override the child binary path
 * - `BUZZ_AGENT_PRIME_PRIME_ARGS` — override child args (comma-separated)
 *
 * If the multiplexer uses a different env var, the contract should be
 * proposed as a change via the QA worker's reply to the lead.
 */
export function mockChildEnv(mockPath: string): Record<string, string> {
  return {
    BUZZ_AGENT_PRIME_PRIME_BIN: mockPath,
    BUZZ_AGENT_PRIME_PRIME_ARGS: "",
    // Use a small state dir for test isolation
    BUZZ_AGENT_PRIME_STATE_DIR: path.join(os.tmpdir(), "buzz-acp-test-" + process.pid),
    BUZZ_AGENT_PRIME_MAX_SESSIONS: "4",
  };
}
