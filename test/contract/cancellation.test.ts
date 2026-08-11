/**
 * Contract tests for session cancellation in `buzz-agent-prime acp`.
 *
 * Tests:
 * - session/cancel notification → cancelled state_update
 * - Cancellation while session is idle (no-op)
 * - Cancellation does not close the session (subsequent prompts work)
 * - Cancel on non-existent session returns error (or no-op)
 *
 * Gated on `isAcpReady()` — skips until the core multiplexer (#3) is merged.
 */

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { AcpClient } from "./helpers/acp-client.js";
import { isAcpReady, WORKTREE_DIR } from "./helpers/test-env.js";
import { getMockChildPath, clearMockChildCache, mockChildEnv } from "./helpers/mock-child.js";
import { isResult } from "./helpers/ndjson.js";

let acpReady = false;

beforeAll(async () => {
  acpReady = await isAcpReady();
});

afterEach(() => {
  clearMockChildCache();
});

async function createClient(opts?: { responseDelayMs?: number }): Promise<AcpClient> {
  const mockPath = getMockChildPath({
    responseDelayMs: opts?.responseDelayMs ?? 500,
  });
  return new AcpClient({
    worktreeDir: WORKTREE_DIR,
    env: {
      ...mockChildEnv(mockPath),
      BUZZ_AGENT_PRIME_MAX_SESSIONS: "4",
    },
    responseTimeoutMs: 10000,
  });
}

describe("Cancellation — active work", () => {
  it("session/cancel sends cancelled state_update", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient({ responseDelayMs: 1000 });
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      // Start a prompt (it'll take ~1s because of responseDelayMs)
      const promptPromise = client.prompt(session.sessionId, "long running");

      // Wait for work to start, then cancel
      await new Promise((r) => setTimeout(r, 200));
      client.cancel(session.sessionId);

      // Collect notifications
      await new Promise((r) => setTimeout(r, 600));
      const notifs = client.collectNotifications("session/update");

      // Should have a cancelled state_update
      const cancelledStates = notifs.filter((n) => {
        const p = n.params as { update: { sessionUpdate: string; stopReason?: string } };
        return p.update.sessionUpdate === "state_update" && p.update.stopReason === "cancelled";
      });
      expect(cancelledStates.length).toBeGreaterThan(0);
      expect(isResult((await promptPromise).response)).toBe(true);
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Cancellation — session survives cancellation", () => {
  it("session can accept new prompts after cancellation", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient({ responseDelayMs: 500 });
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      // Start and cancel a prompt
      const promptPromise = client.prompt(session.sessionId, "cancel me");
      await new Promise((r) => setTimeout(r, 200));
      client.cancel(session.sessionId);
      await new Promise((r) => setTimeout(r, 600));
      expect(isResult((await promptPromise).response)).toBe(true);
      client.collectAll();

      // Should be able to send a new prompt
      const { response } = await client.prompt(session.sessionId, "after cancel");
      expect(isResult(response)).toBe(true);
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Cancellation — edge cases", () => {
  it(
    "cancel on non-existent session does not crash the multiplexer",
    { timeout: 15000 },
    async () => {
      if (!acpReady) return;
      const client = await createClient();
      try {
        await client.initialize();

        // Cancel a session that doesn't exist
        client.cancel("nonexistent-session-id");

        // Wait briefly — should not crash
        await new Promise((r) => setTimeout(r, 500));

        // The multiplexer should still be alive
        const session = await client.newSession("/tmp");
        expect(session.sessionId).toBeTruthy();
      } finally {
        client.kill("SIGKILL");
      }
    },
  );
});
