import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpHarmess, notification, request, startAcp, successResponse } from "./test-utils.js";
import { JSONRPC_ERROR, PROTOCOL_VERSION } from "./protocol.js";

function tempCwd(label: string): string {
  // spawn() resolves the child cwd via realpath (macOS /var -> /private/var),
  // so assertions compare against the canonical path the child actually sees.
  return realpathSync(mkdtempSync(join(tmpdir(), `buzz-acp-${label}-`)));
}

/** Wait for the response frame with the given request id. */
async function responseFor(harness: AcpHarmess, id: number | string, timeoutMs = 5_000) {
  return harness.nextFrame(
    (f) => Object.hasOwn(f, "id") && f.id === id && !("method" in f),
    timeoutMs,
  );
}

async function initialize(harness: AcpHarmess): Promise<Record<string, unknown>> {
  harness.send(request(1, "initialize", { protocolVersion: PROTOCOL_VERSION }));
  return responseFor(harness, 1);
}

async function newSession(
  harness: AcpHarmess,
  id: number,
  cwd: string,
  fake: Record<string, unknown> = {},
  durableKey?: string,
): Promise<string> {
  const meta: Record<string, unknown> = { fake };
  if (durableKey !== undefined) meta.durableSessionKey = durableKey;
  harness.send(request(id, "session/new", { cwd, _meta: meta }));
  const result = await responseFor(harness, id);
  const sessionId = String(result.result && (result.result as Record<string, unknown>).sessionId);
  return sessionId;
}

const harnesses: AcpHarmess[] = [];

function harness(options: Parameters<typeof startAcp>[0] = {}): AcpHarmess {
  const h = startAcp(options);
  harnesses.push(h);
  return h;
}

async function stopAll() {
  for (const h of harnesses.splice(0)) {
    await h.close().catch(() => undefined);
  }
}
afterEach(stopAll);

describe("ACP multiplexer: initialize", () => {
  it("probes prime-agent and returns standard ACP fields with namespaced metadata", async () => {
    const h = harness();
    const init = await initialize(h);
    const result = init.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.agentInfo).toMatchObject({ name: "buzz-agent-prime", title: "Buzz Agent Prime" });
    expect(result.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { close: {} },
    });
    const meta = result._meta as Record<string, unknown>;
    expect(meta["ai.primeintellect.prime-agent"]).toEqual({});
    const buzz = meta["ai.buzz.buzz-agent-prime"] as Record<string, unknown>;
    expect(buzz).toMatchObject({ multiplexer: { protocolVersion: 2, maxSessions: 4 } });
  });

  it("rejects an unsupported protocol version", async () => {
    const h = harness();
    h.send(request(2, "initialize", { protocolVersion: 99 }));
    const resp = await responseFor(h, 2);
    expect((resp.error as Record<string, unknown>).code).toBe(JSONRPC_ERROR.invalidParams);
  });

  it("returns method not found for unknown requests", async () => {
    const h = harness();
    h.send(request(3, "frobnicate", {}));
    const resp = await responseFor(h, 3);
    expect((resp.error as Record<string, unknown>).code).toBe(JSONRPC_ERROR.methodNotFound);
  });
});

describe("ACP multiplexer: session lifecycle and update routing", () => {
  it("maps outer session ids and rewrites forwarded updates", async () => {
    const h = harness();
    await initialize(h);
    const cwd = tempCwd("route");
    const outerId = await newSession(h, 10, cwd, { instance: "route", emitUpdates: true });
    expect(outerId).toMatch(/^[0-9a-f-]{36}$/);

    h.send(
      request(11, "session/prompt", { sessionId: outerId, prompt: [{ type: "text", text: "hi" }] }),
    );

    // The first update must use the OUTER session id and carry the fake's
    // namespaced metadata, preserved verbatim.
    const chunk = await h.nextFrame((f) => f.method === "session/update");
    const params = chunk.params as Record<string, unknown>;
    expect(params.sessionId).toBe(outerId);
    const update = params.update as Record<string, unknown>;
    expect(update.sessionUpdate).toBe("agent_message_chunk");
    const content = update.content as Record<string, unknown>;
    expect(content.text).toBe("[route] hello from " + cwd);

    const infoUpdate = await h.nextFrame(
      (f) =>
        f.method === "session/update" &&
        ((f.params as Record<string, unknown>).update as Record<string, unknown>).sessionUpdate ===
          "session_info_update",
    );
    const infoUpdateParams = infoUpdate.params as Record<string, unknown>;
    const info = (infoUpdateParams.update as Record<string, unknown>)._meta as Record<
      string,
      unknown
    >;
    const primeMeta = info["ai.primeintellect.prime-agent"] as Record<string, unknown>;
    expect(primeMeta.compaction).toBeDefined();
    expect(primeMeta.subagents).toBeDefined();
    expect(primeMeta.goal).toBeDefined();
    expect(primeMeta.refinement).toBeDefined();
    expect(primeMeta.ipython).toBeDefined();

    const promptResp = await responseFor(h, 11);
    expect((promptResp.result as Record<string, unknown>).stopReason).toBe("end_turn");

    h.send(request(12, "session/close", { sessionId: outerId }));
    expect(await responseFor(h, 12)).toEqual(successResponse(12, {}));
  });

  it("rejects prompt/close for an unknown session", async () => {
    const h = harness();
    await initialize(h);
    h.send(request(20, "session/prompt", { sessionId: "nope", prompt: [] }));
    expect(((await responseFor(h, 20)).error as Record<string, unknown>).code).toBe(
      JSONRPC_ERROR.invalidParams,
    );
    h.send(request(21, "session/close", { sessionId: "nope" }));
    expect(((await responseFor(h, 21)).error as Record<string, unknown>).code).toBe(
      JSONRPC_ERROR.invalidParams,
    );
  });
});

describe("ACP multiplexer: concurrency and isolation", () => {
  it("runs four concurrent isolated sessions", async () => {
    const h = harness();
    await initialize(h);
    const cwds = [tempCwd("iso1"), tempCwd("iso2"), tempCwd("iso3"), tempCwd("iso4")];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await newSession(h, 100 + i, cwds[i]!, { instance: `iso${i + 1}`, emitUpdates: true }),
      );
    }
    expect(new Set(ids).size).toBe(4);

    for (let i = 0; i < 4; i++) {
      const id = ids[i]!;
      h.send(
        request(200 + i, "session/prompt", {
          sessionId: id,
          prompt: [{ type: "text", text: "x" }],
        }),
      );
      const chunk = await h.nextFrame(
        (f) =>
          f.method === "session/update" &&
          ((f.params as Record<string, unknown>).sessionId as string) === id,
      );
      const text = (
        ((chunk.params as Record<string, unknown>).update as Record<string, unknown>)
          .content as Record<string, unknown>
      ).text as string;
      expect(text).toBe(`[iso${i + 1}] hello from ${cwds[i]!}`);
      const resp = await responseFor(h, 200 + i);
      expect((resp.result as Record<string, unknown>).stopReason).toBe("end_turn");
    }

    for (let i = 0; i < 4; i++) {
      h.send(request(300 + i, "session/close", { sessionId: ids[i]! }));
      await responseFor(h, 300 + i);
    }
  });

  it("bounds concurrency at BUZZ_AGENT_PRIME_MAX_SESSIONS", async () => {
    const h = harness({ maxSessions: 2 });
    await initialize(h);
    const a = await newSession(h, 1, tempCwd("cap-a"), { instance: "cap-a" });
    const b = await newSession(h, 2, tempCwd("cap-b"), { instance: "cap-b" });
    void a;
    void b;
    h.send(
      request(3, "session/new", { cwd: tempCwd("cap-c"), _meta: { fake: { instance: "cap-c" } } }),
    );
    const resp = await responseFor(h, 3);
    const error = resp.error as Record<string, unknown>;
    expect(error.code).toBe(JSONRPC_ERROR.serverError);
    const data = error.data as Record<string, unknown>;
    expect(data.maxSessions).toBe(2);
    expect(data.reason).toBe("capacity");
  });
});

describe("ACP multiplexer: durable session keys", () => {
  it("rejects a duplicate live durable key, then accepts after close", async () => {
    const h = harness();
    await initialize(h);
    const cwd = tempCwd("durable");
    const first = await newSession(h, 1, cwd, { instance: "durable-1" }, "channel-x");
    void first;
    h.send(
      request(2, "session/new", {
        cwd,
        _meta: { durableSessionKey: "channel-x", fake: { instance: "durable-2" } },
      }),
    );
    const dup = await responseFor(h, 2);
    const err = dup.error as Record<string, unknown>;
    expect(err.code).toBe(JSONRPC_ERROR.invalidParams);
    const data = err.data as Record<string, unknown>;
    expect(data.durableSessionKey).toBe("channel-x");
    expect(data.reason).toBe("duplicate_live_key");

    h.send(request(3, "session/close", { sessionId: first }));
    await responseFor(h, 3);
    const reopened = await newSession(h, 4, cwd, { instance: "durable-3" }, "channel-x");
    expect(reopened).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ACP multiplexer: cancellation", () => {
  it("cancels an in-flight prompt via session/cancel", async () => {
    const h = harness();
    await initialize(h);
    const sid = await newSession(h, 1, tempCwd("cancel"), {
      instance: "cancel",
      hangOnPrompt: true,
    });
    h.send(request(2, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "x" }] }));
    // Give the child a moment to register the prompt before cancelling.
    await new Promise((r) => setTimeout(r, 150));
    h.send(notification("session/cancel", { sessionId: sid }));
    const resp = await responseFor(h, 2);
    expect((resp.result as Record<string, unknown>).stopReason).toBe("cancelled");
  });

  it("cancels an in-flight prompt via $/cancel_request", async () => {
    const h = harness();
    await initialize(h);
    const sid = await newSession(h, 1, tempCwd("cancelproto"), {
      instance: "cancelproto",
      hangOnPrompt: true,
    });
    h.send(request(2, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "x" }] }));
    await new Promise((r) => setTimeout(r, 150));
    h.send(notification("$/cancel_request", { requestId: 2 }));
    const resp = await responseFor(h, 2);
    expect((resp.result as Record<string, unknown>).stopReason).toBe("cancelled");
  });
});

describe("ACP multiplexer: failure isolation", () => {
  it("a session's child crash fails only that session", async () => {
    const h = harness();
    await initialize(h);
    const crashing = await newSession(h, 1, tempCwd("crash"), {
      instance: "crash",
      dieOnPrompt: true,
    });
    const healthy = await newSession(h, 2, tempCwd("healthy"), {
      instance: "healthy",
      emitUpdates: true,
    });

    h.send(
      request(3, "session/prompt", { sessionId: crashing, prompt: [{ type: "text", text: "x" }] }),
    );
    const errResp = await responseFor(h, 3, 8_000);
    const err = errResp.error as Record<string, unknown>;
    expect(err.code).toBe(JSONRPC_ERROR.internalError);
    // The crash is surfaced as namespaced metadata so a harness can tell an
    // agent-chosen stop from a subprocess death.
    await h.nextFrame((f) => {
      if (f.method !== "session/update") return false;
      const p = f.params as Record<string, unknown>;
      if (p.sessionId !== crashing) return false;
      const u = p.update as Record<string, unknown>;
      return u.sessionUpdate === "session_info_update";
    }, 8_000);

    // The healthy session is unaffected.
    h.send(
      request(4, "session/prompt", { sessionId: healthy, prompt: [{ type: "text", text: "x" }] }),
    );
    await h.nextFrame(
      (f) =>
        f.method === "session/update" &&
        ((f.params as Record<string, unknown>).sessionId as string) === healthy,
    );
    const healthyResp = await responseFor(h, 4);
    expect((healthyResp.result as Record<string, unknown>).stopReason).toBe("end_turn");

    h.send(request(5, "session/close", { sessionId: healthy }));
    await responseFor(h, 5);
  });
});

describe("ACP multiplexer: stdout discipline", () => {
  it("fails malformed frames without corrupting stdout", async () => {
    const h = harness();
    h.sendRaw("{not valid json\n");
    const parseErr = await h.nextFrame(
      (f) => (f.error as Record<string, unknown> | undefined)?.code === JSONRPC_ERROR.parseError,
    );
    expect(parseErr.id).toBeNull();
    expect((parseErr.error as Record<string, unknown>).code).toBe(JSONRPC_ERROR.parseError);

    // A well-formed request after the malformed frame still succeeds.
    const init = await initialize(h);
    expect((init.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("rejects oversized frames without corrupting stdout", async () => {
    const h = harness({ maxFrameBytes: 128 });
    h.sendRaw("x".repeat(256) + "\n");
    const tooLarge = await h.nextFrame((f) => {
      const error = f.error as Record<string, unknown> | undefined;
      return error?.code === JSONRPC_ERROR.parseError;
    });
    const data = (tooLarge.error as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.frameBytes).toBeGreaterThanOrEqual(256);
    expect(data.limit).toBe(128);

    const init = await initialize(h);
    expect((init.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("ACP multiplexer: child request forwarding", () => {
  it("forwards a child-initiated request and routes the response back", async () => {
    const h = harness();
    await initialize(h);
    const sid = await newSession(h, 1, tempCwd("perm"), {
      instance: "perm",
      requestPermission: true,
    });
    h.send(request(2, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "x" }] }));

    // The child's session/request_permission arrives with a multiplexer-local id.
    const forwarded = await h.nextFrame((f) => f.method === "session/request_permission", 8_000);
    expect(typeof forwarded.id).toBe("string");
    expect(String(forwarded.id).startsWith("bap-req-")).toBe(true);

    h.send(successResponse(forwarded.id as string, { outcome: "allow_once" }));

    const resp = await responseFor(h, 2, 8_000);
    expect((resp.result as Record<string, unknown>).stopReason).toBe("end_turn");

    h.send(request(3, "session/close", { sessionId: sid }));
    await responseFor(h, 3);
  });
});

describe("ACP multiplexer: shutdown", () => {
  it("reaps child processes and exits 0 on stdin EOF", async () => {
    const h = harness();
    await initialize(h);
    await newSession(h, 1, tempCwd("eof"));
    const code = await h.close();
    expect(code).toBe(0);
  });

  it("ignores notifications for unknown sessions", async () => {
    const h = harness();
    await initialize(h);
    h.send(notification("session/cancel", { sessionId: "unknown-xyz" }));
    // Nothing should crash: ensure a subsequent initialize still works.
    h.send(request(40, "initialize", { protocolVersion: PROTOCOL_VERSION }));
    const resp = await responseFor(h, 40);
    expect((resp.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("ACP multiplexer: default cwd", () => {
  it("uses the default working directory when session/new omits cwd", async () => {
    const h = harness({ runOptions: { defaultCwd: process.cwd() } });
    await initialize(h);
    h.send(
      request(1, "session/new", {
        _meta: { fake: { instance: "default-cwd", emitUpdates: true } },
      }),
    );
    const result = await responseFor(h, 1);
    const sid = String((result.result as Record<string, unknown>).sessionId);
    h.send(request(2, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "x" }] }));
    const chunk = await h.nextFrame((f) => f.method === "session/update");
    const text = (
      ((chunk.params as Record<string, unknown>).update as Record<string, unknown>)
        .content as Record<string, unknown>
    ).text as string;
    expect(text).toBe(`[default-cwd] hello from ${process.cwd()}`);
    h.send(request(3, "session/close", { sessionId: sid }));
    await responseFor(h, 3);
  });
});
