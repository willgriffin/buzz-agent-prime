#!/usr/bin/env node
import pinnedInitializeResult from "./prime-agent-0.7.1-initialize.json" with { type: "json" };

/**
 * A minimal ACP v2 agent used to exercise the buzz-agent-prime multiplexer
 * without a real prime-agent installation.
 *
 * Speaks NDJSON JSON-RPC 2.0 on stdio: initialize, session/new,
 * session/prompt, session/cancel (notification), session/close. Behavior is
 * configured through FAKE_AGENT_* environment variables, and per-session
 * overrides arrive in `session/new` params `_meta.fake` (so a single test run
 * can give different sessions different failure modes).
 */

const env = process.env;

function envConfig() {
  return {
    instance: env.FAKE_AGENT_INSTANCE ?? "fake",
    emitUpdates: env.FAKE_AGENT_EMIT_UPDATES === "1",
    dieOnPrompt: env.FAKE_AGENT_DIE_ON_PROMPT === "1",
    signalOnPrompt: env.FAKE_AGENT_SIGNAL_ON_PROMPT,
    hangOnPrompt: env.FAKE_AGENT_HANG_ON_PROMPT === "1",
    hangOnInitialize: env.FAKE_AGENT_HANG_ON_INITIALIZE === "1",
    requestPermission: env.FAKE_AGENT_REQUEST_PERMISSION === "1",
    promptDelayMs: Number(env.FAKE_AGENT_PROMPT_DELAY_MS ?? 0),
    garbage: env.FAKE_AGENT_GARBAGE === "1",
    metaResult: env.FAKE_AGENT_META_RESULT === "1",
    malformedInitialize: env.FAKE_AGENT_MALFORMED_INITIALIZE === "1",
    omitOptionalInitialize: env.FAKE_AGENT_OMIT_OPTIONAL_INITIALIZE === "1",
    nullOptionalInitialize: env.FAKE_AGENT_NULL_OPTIONAL_INITIALIZE === "1",
    protocolVersion: Number(env.FAKE_AGENT_PROTOCOL_VERSION ?? 1),
    exitCode: Number(env.FAKE_AGENT_EXIT_CODE ?? 0),
  };
}

let config = envConfig();
let buffer = "";
let stdinEnded = false;
let currentSessionId = undefined;
let sessionCounter = 0;
let pendingPrompt = undefined; // { id }
const responseWaiters = new Map();

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function metaPayload() {
  return {
    "ai.primeintellect.prime-agent": {
      instance: config.instance,
      compaction: { tokensBefore: 12345, summary: "compacted by fake agent" },
      subagents: [{ id: "sub-1", sessionName: "reviewer", status: "running", model: "fake-model" }],
      goal: { status: "active", objective: "fake objective", tokenBudget: 1000, tokensUsed: 42 },
      refinement: { status: "complete", summary: "fake refinement" },
      ipython: { diffCount: 2 },
    },
  };
}

/** Merge `_meta.fake` overrides (scalar values only) into the current config. */
function applySessionConfig(meta) {
  const overrides = meta?.fake;
  if (typeof overrides !== "object" || overrides === null) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (key in config) config[key] = value;
  }
}

function handleLine(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      if (config.hangOnInitialize) return;
      if (
        typeof params?.clientCapabilities !== "object" ||
        params.clientCapabilities === null ||
        typeof params?.clientInfo !== "object" ||
        params.clientInfo === null
      ) {
        respondError(id, -32602, "initialize requires clientCapabilities and clientInfo");
        return;
      }
      if (config.malformedInitialize) {
        respond(id, { protocolVersion: config.protocolVersion, agentCapabilities: null });
        return;
      }
      if (config.omitOptionalInitialize) {
        respond(id, { protocolVersion: config.protocolVersion });
        return;
      }
      if (config.nullOptionalInitialize) {
        respond(id, {
          ...pinnedInitializeResult,
          protocolVersion: config.protocolVersion,
          agentInfo: null,
          _meta: null,
        });
        return;
      }
      respond(id, { ...pinnedInitializeResult, protocolVersion: config.protocolVersion });
      return;
    }
    case "session/new": {
      applySessionConfig(params?._meta);
      if (config.garbage) {
        process.stdout.write("this is not json\n");
      }
      currentSessionId = `fake-session-${++sessionCounter}-${config.instance}`;
      respond(id, {
        sessionId: currentSessionId,
        configOptions: [
          {
            configId: "model",
            type: "select",
            name: "Model",
            options: [{ id: "fake-model", label: "Fake Model" }],
          },
        ],
        _meta: {
          "ai.primeintellect.prime-agent": {
            instance: config.instance,
            sessionCwd: process.cwd(),
          },
        },
      });
      return;
    }
    case "session/prompt": {
      if (config.dieOnPrompt) {
        process.exit(3);
        return;
      }
      if (typeof config.signalOnPrompt === "string") {
        process.kill(process.pid, config.signalOnPrompt);
        return;
      }
      if (config.emitUpdates && currentSessionId !== undefined) {
        notify("session/update", {
          sessionId: currentSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[${config.instance}] hello from ${process.cwd()}` },
          },
        });
        notify("session/update", {
          sessionId: currentSessionId,
          update: { sessionUpdate: "session_info_update", _meta: metaPayload() },
        });
      }
      const finish = (stopReason) => {
        const result = { stopReason };
        if (config.metaResult) result._meta = metaPayload();
        respond(id, result);
        pendingPrompt = undefined;
      };
      if (config.requestPermission) {
        // A client-directed request the multiplexer must forward and route.
        const requestId = `fake-req-${Date.now()}`;
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "session/request_permission",
            params: {
              permissionRequestId: requestId,
              title: "Fake permission",
              message: "may the fake agent proceed?",
            },
          })}\n`,
        );
        responseWaiters.set(requestId, () => {
          if (config.promptDelayMs > 0) setTimeout(() => finish("end_turn"), config.promptDelayMs);
          else finish("end_turn");
        });
        return;
      }
      if (config.hangOnPrompt) {
        pendingPrompt = { id };
        return;
      }
      if (config.promptDelayMs > 0) {
        setTimeout(() => finish("end_turn"), config.promptDelayMs);
        return;
      }
      finish("end_turn");
      return;
    }
    case "session/cancel": {
      if (pendingPrompt) {
        respond(pendingPrompt.id, { stopReason: "cancelled" });
        pendingPrompt = undefined;
      }
      return;
    }
    case "session/close": {
      respond(id, {});
      return;
    }
    default:
      if (id !== undefined) {
        respondError(id, -32601, `"Method not found": ${method}`);
      }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message && typeof message === "object" && "id" in message && !("method" in message)) {
      const waiter = responseWaiters.get(message.id);
      if (waiter) {
        responseWaiters.delete(message.id);
        waiter(message);
        continue;
      }
    }
    handleLine(message);
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  process.exit(config.exitCode);
});

// Safety net: exit when stdin closed and nothing is in flight.
setInterval(() => {
  if (stdinEnded && pendingPrompt === undefined && responseWaiters.size === 0) {
    process.exit(config.exitCode);
  }
}, 100);
