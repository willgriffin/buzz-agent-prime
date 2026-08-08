/**
 * Contract tests for Prime metadata forwarding in `buzz-agent-prime acp`.
 *
 * The multiplexer must forward extension notifications from children to
 * the outer client, including:
 * - IPython lifecycle events (_prime/ipython_lifecycle)
 * - Subagent lifecycle events (_prime/subagent_lifecycle)
 *
 * Uses a mock child configured to emit Prime metadata during prompts.
 *
 * Gated on `isAcpReady()` — skips until the core multiplexer (#3) is merged.
 */

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { AcpClient } from "./helpers/acp-client.js";
import { isAcpReady, WORKTREE_DIR } from "./helpers/test-env.js";
import { getMockChildPath, clearMockChildCache, mockChildEnv } from "./helpers/mock-child.js";
import {
  PRIME_EXT_IPYTHON_LIFECYCLE,
  PRIME_EXT_SUBAGENT_LIFECYCLE,
  type IPythonLifecycleEvent,
  type SubagentLifecycleEvent,
} from "./helpers/types.js";

let acpReady = false;

beforeAll(async () => {
  acpReady = await isAcpReady();
});

afterEach(() => {
  clearMockChildCache();
});

async function createClient(): Promise<AcpClient> {
  const mockPath = getMockChildPath({ emitPrimeMetadata: true });
  return new AcpClient({
    worktreeDir: WORKTREE_DIR,
    env: {
      ...mockChildEnv(mockPath),
      BUZZ_AGENT_PRIME_MAX_SESSIONS: "4",
    },
    responseTimeoutMs: 10000,
  });
}

describe("Metadata forwarding — IPython lifecycle", () => {
  it.todo("forwards _prime/ipython_lifecycle notifications", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      // Collect all notifications during the prompt
      const promptId = client.sendRequest("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "metadata test" }],
      });

      // Wait for the prompt to complete
      await client.awaitResponse(promptId);

      // Collect ipython lifecycle notifications
      const ipythonEvents = client.collectNotificationsWhere(
        (n) => n.method === PRIME_EXT_IPYTHON_LIFECYCLE,
      );

      expect(ipythonEvents.length).toBeGreaterThan(0);

      // Should have start and ready events
      const events = ipythonEvents.map((n) => (n.params as { event: IPythonLifecycleEvent }).event);
      expect(events).toContain("start");
      expect(events).toContain("ready");
    } finally {
      client.kill("SIGKILL");
    }
  });

  it("ipython lifecycle events reference the correct session ID", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      const promptId = client.sendRequest("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "session ref test" }],
      });
      await client.awaitResponse(promptId);

      const ipythonEvents = client.collectNotificationsWhere(
        (n) => n.method === PRIME_EXT_IPYTHON_LIFECYCLE,
      );

      for (const n of ipythonEvents) {
        const p = n.params as { sessionId: string };
        expect(p.sessionId).toBe(session.sessionId);
      }
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Metadata forwarding — subagent lifecycle", () => {
  it.todo("forwards _prime/subagent_lifecycle notifications", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      const promptId = client.sendRequest("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "subagent test" }],
      });
      await client.awaitResponse(promptId);

      const subagentEvents = client.collectNotificationsWhere(
        (n) => n.method === PRIME_EXT_SUBAGENT_LIFECYCLE,
      );

      expect(subagentEvents.length).toBeGreaterThan(0);

      const events = subagentEvents.map(
        (n) => (n.params as { event: SubagentLifecycleEvent }).event,
      );
      expect(events).toContain("spawn");
      expect(events).toContain("complete");
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Metadata forwarding — ACP session/update passthrough", () => {
  it("forwards standard session/update notifications", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const session = await client.newSession("/tmp");

      const promptId = client.sendRequest("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "update passthrough" }],
      });
      await client.awaitResponse(promptId);

      const updates = client.collectNotifications("session/update");
      expect(updates.length).toBeGreaterThan(0);

      // Should include state_update notifications
      const stateUpdates = updates.filter((n) => {
        const p = n.params as { update: { sessionUpdate: string } };
        return p.update.sessionUpdate === "state_update";
      });
      expect(stateUpdates.length).toBeGreaterThan(0);
    } finally {
      client.kill("SIGKILL");
    }
  });
});

describe("Metadata forwarding — multi-session isolation", () => {
  it("metadata from one session does not leak to another", { timeout: 20000 }, async () => {
    if (!acpReady) return;
    const client = await createClient();
    try {
      await client.initialize();
      const s1 = await client.newSession("/tmp");
      const s2 = await client.newSession("/tmp");

      // Prompt session 1 only
      const promptId = client.sendRequest("session/prompt", {
        sessionId: s1.sessionId,
        prompt: [{ type: "text", text: "session 1 only" }],
      });
      await client.awaitResponse(promptId);

      // All notifications should reference session 1, not session 2
      const allNotifs = client.collectAll();
      for (const cf of allNotifs) {
        if ("method" in cf.frame && cf.frame.method.startsWith("_prime/")) {
          const p = (cf.frame as { params: { sessionId: string } }).params;
          expect(p.sessionId).toBe(s1.sessionId);
          expect(p.sessionId).not.toBe(s2.sessionId);
        }
      }
    } finally {
      client.kill("SIGKILL");
    }
  });
});
