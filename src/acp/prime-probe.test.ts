import { describe, expect, it } from "vitest";
import { probePrimeAgent } from "./prime-probe.js";
import { FAKE_AGENT } from "./test-utils.js";

const CLIENT_INFO = { name: "buzz-agent-prime", version: "0.1.0-test" };

describe("probePrimeAgent", () => {
  it("captures capabilities, info, and namespaced metadata from prime-agent", async () => {
    const result = await probePrimeAgent({
      primeBin: FAKE_AGENT,
      clientInfo: CLIENT_INFO,
      cwd: process.cwd(),
      env: { FAKE_AGENT_INSTANCE: "probe-instance" },
    });
    expect(result.capabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { close: {} },
    });
    expect(result.info).toMatchObject({ name: "fake-prime-agent", version: "9.9.9" });
    expect(result.meta).toEqual({
      "ai.primeintellect.prime-agent": { instance: "probe-instance", probe: true },
    });
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
    expect(result.capabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
    });
  });
});
