/**
 * Contract tests for session multiplexing in `buzz-agent-prime acp`.
 *
 * The multiplexer maintains one ACP child per outer `session/new`.
 * These tests verify:
 * - One-channel scenario: a single session works end-to-end
 * - Multi-channel scenario: concurrent sessions are isolated
 * - Max sessions enforcement
 *
 * Gated on `isAcpReady()` — skips until the core multiplexer (#3) is merged.
 */

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { AcpClient } from "./helpers/acp-client.js";
import { isAcpReady, WORKTREE_DIR } from "./helpers/test-env.js";
import { getMockChildPath, clearMockChildCache, mockChildEnv } from "./helpers/mock-child.js";
import { isResult, isError } from "./helpers/types.js";

let acpReady = false;

beforeAll(async () => {
  acpReady = await isAcpReady();
});

afterEach(() => {
  clearMockChildCache();
});

async function createClient(maxSessions = 4, timeoutMs = 10000): Promise<AcpClient> {
  const mockPath = getMockChildPath({});
  return new AcpClient({
    worktreeDir: WORKTREE_DIR,
    env: {
      ...mockChildEnv(mockPath),
      BUZZ_AGENT_PRIME_MAX_SESSIONS: String(maxSessions),
    },
    responseTimeoutMs: timeoutMs,
  });
}

describe("Session multiplexing — one-channel scenario", () => {
  it("single session: initialize → new → prompt → updates → idle", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");
      const { response, notifications } = await client.prompt(session.sessionId, "hello world");

      expect(isResult(response)).toBe(true);

      // Should have session/update notifications
      expect(notifications.length).toBeGreaterThan(0);

      // Should have at least one agent_message or agent_message_chunk
      const agentMessages = notifications.filter((n) => {
        const p = n.params as { update: { sessionUpdate: string } };
        return p.update.sessionUpdate.startsWith("agent_message");
      });
      expect(agentMessages.length).toBeGreaterThan(0);

      // Should end with idle state
      const idleStates = notifications.filter((n) => {
        const p = n.params as { update: { sessionUpdate: string; state?: string } };
        return p.update.sessionUpdate === "state_update" && p.update.state === "idle";
      });
      expect(idleStates.length).toBeGreaterThan(0);
    } finally {
      client.kill("SIGKILL");
    }
  });

  it("single session: close terminates the session", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");
      await client.closeSession(session.sessionId);
      // After close, the session should be gone
      // Attempting to prompt should fail
      const id = client.sendRequest("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "after close" }],
      });
      const resp = await client.awaitResponse(id);
      expect(isError(resp)).toBe(true);
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Session multiplexing — multi-channel scenario", () => {
  it("two concurrent sessions are isolated", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();

      // Create two sessions
      const session1 = await client.newSession("/tmp");
      const session2 = await client.newSession("/tmp");

      expect(session1.sessionId).not.toBe(session2.sessionId);

      // Prompt both concurrently
      const p1 = client.prompt(session1.sessionId, "first prompt");
      const p2 = client.prompt(session2.sessionId, "second prompt");
      const [r1, r2] = await Promise.all([p1, p2]);

      // Both should succeed
      expect(isResult(r1.response)).toBe(true);
      expect(isResult(r2.response)).toBe(true);

      // Both should have session updates
      expect(r1.notifications.length).toBeGreaterThan(0);
      expect(r2.notifications.length).toBeGreaterThan(0);

      // Notifications for session1 should reference session1
      for (const n of r1.notifications) {
        const p = n.params as { sessionId: string };
        expect(p.sessionId).toBe(session1.sessionId);
      }
      for (const n of r2.notifications) {
        const p = n.params as { sessionId: string };
        expect(p.sessionId).toBe(session2.sessionId);
      }
    } finally {
      client.kill("SIGKILL");
    }
  });

  it("max sessions limit is enforced", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient(2);
    try {
      await client.initialize();

      // Create sessions up to the limit
      const _s1 = await client.newSession("/tmp");
      const _s2 = await client.newSession("/tmp");

      // Third session should fail
      const id = client.sendRequest("session/new", { cwd: "/tmp" });
      const resp = await client.awaitResponse(id);
      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        // Should be some kind of capacity/limit error
        expect(resp.error.code).toBeLessThanOrEqual(0);
      }
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Session multiplexing — session ID uniqueness", () => {
  it("each session gets a distinct ID", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();

      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await client.newSession("/tmp");
        ids.push(s.sessionId);
      }
      expect(new Set(ids).size).toBe(3);
    } finally {
      client.kill("SIGKILL");
    }
  });
});
