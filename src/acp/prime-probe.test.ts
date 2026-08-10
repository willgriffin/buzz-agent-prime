import { describe, expect, it } from "vitest";
import { probePrimeAgent } from "./prime-probe.js";
import { FAKE_AGENT } from "./test-utils.js";
import pinnedInitializeResult from "./__fixtures__/prime-agent-0.7.1-initialize.json" with { type: "json" };

const CLIENT_INFO = { name: "buzz-agent-prime", version: "0.1.0-test" };

describe("probePrimeAgent", () => {
  it("captures the pinned Prime 0.7.1 initialize shape and preserves _meta", async () => {
    const result = await probePrimeAgent({
      primeBin: FAKE_AGENT,
      clientInfo: CLIENT_INFO,
      cwd: process.cwd(),
      env: { FAKE_AGENT_INSTANCE: "probe-instance" },
    });
    expect(result.protocolVersion).toBe(pinnedInitializeResult.protocolVersion);
    expect(result.agentCapabilities).toEqual(pinnedInitializeResult.agentCapabilities);
    expect(result.agentInfo).toEqual(pinnedInitializeResult.agentInfo);
    expect(result.meta).toEqual(pinnedInitializeResult._meta);
  });

  it("tolerates omitted optional initialize fields", async () => {
    const result = await probePrimeAgent({
      primeBin: FAKE_AGENT,
      clientInfo: CLIENT_INFO,
      cwd: process.cwd(),
      env: { FAKE_AGENT_OMIT_OPTIONAL_INITIALIZE: "1" },
    });
    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities).toEqual({});
    expect(result.agentInfo).toEqual({});
    expect(result.meta).toEqual({});
  });

  it("normalizes nullable optional initialize fields", async () => {
    const result = await probePrimeAgent({
      primeBin: FAKE_AGENT,
      clientInfo: CLIENT_INFO,
      cwd: process.cwd(),
      env: { FAKE_AGENT_NULL_OPTIONAL_INITIALIZE: "1" },
    });
    expect(result.agentCapabilities).toEqual(pinnedInitializeResult.agentCapabilities);
    expect(result.agentInfo).toEqual({});
    expect(result.meta).toEqual({});
  });

  it("rejects a null required agentCapabilities response", async () => {
    await expect(
      probePrimeAgent({
        primeBin: FAKE_AGENT,
        clientInfo: CLIENT_INFO,
        cwd: process.cwd(),
        env: { FAKE_AGENT_MALFORMED_INITIALIZE: "1" },
      }),
    ).rejects.toThrow(/non-object agentCapabilities/);
  });

  it("rejects when the executable cannot be spawned", async () => {
    await expect(
      probePrimeAgent({
        primeBin: "/nonexistent/prime-agent",
        clientInfo: CLIENT_INFO,
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/failed to spawn|spawn/i);
  });

  it("times out and reaps a prime-agent that never answers initialize", async () => {
    const started = Date.now();
    await expect(
      probePrimeAgent({
        primeBin: FAKE_AGENT,
        clientInfo: CLIENT_INFO,
        cwd: process.cwd(),
        env: { FAKE_AGENT_HANG_ON_INITIALIZE: "1" },
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  });

  it("captures the protocol version prime-agent reports, even if it trails v2", async () => {
    const result = await probePrimeAgent({
      primeBin: FAKE_AGENT,
      clientInfo: CLIENT_INFO,
      cwd: process.cwd(),
      env: { FAKE_AGENT_PROTOCOL_VERSION: "1" },
    });
    expect(result.protocolVersion).toBe(1);
    expect(result.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
    });
  });
});
