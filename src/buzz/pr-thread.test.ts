import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRelayUrl, runPrThread, sanitizePrThreadError } from "./pr-thread.js";
import {
  OWNER_KEY,
  REPOSITORY_OWNER_KEY,
  nsec,
  pubkey,
  signedEvent,
} from "../../test/helpers/nostr-fixtures.js";
import { ScriptedNostrRelay } from "../../test/helpers/scripted-nostr-relay.js";

const EVENT_ID = "a".repeat(64);
const relays: ScriptedNostrRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

async function unusedRelay(): Promise<ScriptedNostrRelay> {
  const relay = new ScriptedNostrRelay();
  relays.push(relay);
  await relay.start();
  return relay;
}

async function filterRelay(
  events: ConstructorParameters<typeof ScriptedNostrRelay>[0]["filterEvents"],
): Promise<ScriptedNostrRelay> {
  const relay = new ScriptedNostrRelay({ filterEvents: events });
  relays.push(relay);
  await relay.start();
  return relay;
}

describe("runPrThread input validation", () => {
  it.each(["", "abc", "z".repeat(64), "a".repeat(63)])(
    "rejects invalid event id %j before connecting",
    async (event) => {
      const relay = await unusedRelay();

      await expect(
        runPrThread({ event, relayUrl: relay.url, privateKey: "1".padStart(64, "0") }),
      ).resolves.toBe(2);
      expect(relay.connections).toBe(0);
    },
  );

  it("rejects malformed hexadecimal private keys before connecting", async () => {
    const relay = await unusedRelay();

    await expect(
      runPrThread({ event: EVENT_ID, relayUrl: relay.url, privateKey: "z".repeat(64) }),
    ).resolves.toBe(1);
    expect(relay.connections).toBe(0);
  });

  it("rejects nsec values with an invalid bech32 checksum before connecting", async () => {
    const relay = await unusedRelay();
    const valid = nsec();
    const corrupted = `${valid.slice(0, -1)}${valid.endsWith("q") ? "p" : "q"}`;

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runPrThread({ event: EVENT_ID, relayUrl: relay.url, privateKey: corrupted }),
      ).resolves.toBe(1);
      expect(relay.connections).toBe(0);
      expect(stderr.mock.calls.flat().join("")).not.toContain(corrupted);
      expect(stderr.mock.calls.flat().join("")).toContain("private key rejected");
    } finally {
      stderr.mockRestore();
    }
  });

  it("sanitizes C0/C1 terminal controls, secrets, and oversized relay failures", () => {
    const dangerous =
      "\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u009b31m\u0085bad\u0000";
    const sanitized = sanitizePrThreadError(dangerous);

    expect(sanitized).toContain("link");
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(sanitizePrThreadError(`invalid nsec private key: ${nsec()}`)).toBe(
      "private key rejected",
    );
    expect(sanitizePrThreadError("x".repeat(300))).toHaveLength(240);
  });

  it("writes only terminal-safe NDJSON and a summary on a successful thread", async () => {
    const root = await signedEvent({
      kind: 1618,
      created_at: 1,
      content: "root",
      tags: [["a", `30617:${pubkey(REPOSITORY_OWNER_KEY)}:safe-output`]],
    });
    const comment = await signedEvent({
      kind: 1111,
      created_at: 2,
      content: "\u009b31mterminal control",
      tags: [
        ["E", root.id],
        ["K", "1618"],
        ["P", root.pubkey],
        ["x", "\u0007bell"],
      ],
    });
    const relay = await filterRelay([root, comment]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runPrThread({ event: root.id, relayUrl: relay.url, privateKey: OWNER_KEY }),
      ).resolves.toBe(0);
      const output = stdout.mock.calls.flat().join("");
      const lines = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { content: string });
      expect(
        output
          .trim()
          .split("\n")
          .every((line) => !/[\u0000-\u001f\u007f-\u009f]/.test(line)),
      ).toBe(true);
      expect(lines.map((line) => line.content)).toContain(comment.content);
      expect(stderr.mock.calls.flat().join("")).toMatch(/verified event\(s\)/);
      expect(stderr.mock.calls.flat().join("")).toContain(root.id.slice(0, 12));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("handles a closed stdout pipe as quiet Unix-pipeline success", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      tags: [["a", `30617:${pubkey(REPOSITORY_OWNER_KEY)}:epipe`]],
    });
    const relay = await filterRelay([root]);
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw epipe;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runPrThread({ event: root.id, relayUrl: relay.url, privateKey: OWNER_KEY }),
      ).resolves.toBe(0);
      const diagnostics = stderr.mock.calls.flat().join("");
      expect(diagnostics).not.toContain("error:");
      expect(diagnostics).not.toMatch(/\n\s*at\s/);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    await expect(
      runPrThread({ event: "not-an-event-id", relayUrl: relay.url, privateKey: OWNER_KEY }),
    ).resolves.toBe(2);
  });

  it.each([
    "ws://user:bearer@relay.example",
    "ws://relay.example/private",
    "wss://relay.example/?token=bearer",
  ])("rejects credentialed or non-canonical relay URL %s without connecting", async (relayUrl) => {
    const relay = await unusedRelay();
    const hostileUrl = relayUrl.replace(
      "relay.example",
      `127.0.0.1:${relay.url.split(":").at(-1)!}`,
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runPrThread({ event: EVENT_ID, relayUrl: hostileUrl, privateKey: OWNER_KEY }),
      ).resolves.toBe(1);
      expect(relay.connections).toBe(0);
      expect(stderr.mock.calls.flat().join("")).not.toMatch(/bearer|user@/i);
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects URL credentials, paths, queries, and fragments at normalization", () => {
    for (const url of [
      "ws://user:secret@relay.example",
      "ws://relay.example/path",
      "wss://relay.example/?token=secret",
      "wss://relay.example/#fragment",
    ]) {
      expect(() => normalizeRelayUrl(url)).toThrow();
    }
  });

  it.each([OWNER_KEY, nsec(OWNER_KEY)])(
    "redacts an exact configured private key echoed by a relay",
    async (privateKey) => {
      const relay = new ScriptedNostrRelay({
        onMessage(message, fake) {
          if (message[0] === "REQ" && typeof message[1] === "string") {
            fake.send(["CLOSED", message[1], `relay echo: ${privateKey}`]);
          }
        },
      });
      relays.push(relay);
      await relay.start();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(
          runPrThread({ event: EVENT_ID, relayUrl: relay.url, privateKey }),
        ).resolves.toBe(1);
        expect(stderr.mock.calls.flat().join("")).not.toContain(privateKey);
      } finally {
        stderr.mockRestore();
      }
    },
  );
});
