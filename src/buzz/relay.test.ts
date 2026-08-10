import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RELAY_CUMULATIVE_BYTES,
  MAX_RELAY_EVENT_FRAMES,
  RELAY_PAGE_LIMIT,
  fetchPrConversation,
  subscribeToRelay,
} from "./relay.js";
import {
  OWNER_KEY,
  REPOSITORY_OWNER_KEY,
  REVIEWER_KEY,
  UNTRUSTED_KEY,
  corruptSignature,
  pubkey,
  signedEvent,
} from "../../test/helpers/nostr-fixtures.js";
import {
  ScriptedNostrRelay,
  type RelayWireMessage,
} from "../../test/helpers/scripted-nostr-relay.js";

const FILTERS = [{ kinds: [1], limit: 100 }];
const REQUEST = "REQ";
const AUTH = "AUTH";

const relays: ScriptedNostrRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

async function relay(
  options: ConstructorParameters<typeof ScriptedNostrRelay>[0],
): Promise<ScriptedNostrRelay> {
  const instance = new ScriptedNostrRelay(options);
  relays.push(instance);
  await instance.start();
  return instance;
}

function isCommand(message: RelayWireMessage, name: string): boolean {
  return message[0] === name;
}

function subscriptionId(message: RelayWireMessage): string {
  expect(isCommand(message, REQUEST)).toBe(true);
  expect(typeof message[1]).toBe("string");
  return message[1] as string;
}

describe("subscribeToRelay", () => {
  it("sends REQ immediately to unauthenticated relays and resolves only at EOSE", async () => {
    const event = await signedEvent({ content: "stored event" });
    const server = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const id = subscriptionId(message);
        fake.send(["EVENT", id, event]);
        fake.send(["EOSE", id]);
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([event]);
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]?.[0]).toBe(REQUEST);
  });

  it("answers an AUTH challenge and waits for an OK matching the exact AUTH event id", async () => {
    const event = await signedEvent({ content: "after precise auth" });
    let authenticated = false;
    let authId = "";
    let requests = 0;
    const server = await relay({
      onConnect(fake) {
        fake.send([AUTH, "challenge-123"]);
      },
      onMessage(message, fake) {
        if (isCommand(message, AUTH)) {
          const authEvent = message[1] as Record<string, unknown>;
          authId = String(authEvent.id);
          fake.send(["OK", "f".repeat(64), true, "wrong event"]);
          setTimeout(() => {
            authenticated = true;
            fake.send(["OK", authId, true, "accepted"]);
          }, 15);
          return;
        }
        if (isCommand(message, REQUEST)) {
          requests++;
          if (authenticated) {
            const id = subscriptionId(message);
            fake.send(["EVENT", id, event]);
            fake.send(["EOSE", id]);
          }
        }
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([event]);
    expect(authId).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticated).toBe(true);
    expect(requests).toBe(2);
  });

  it("fails when the relay rejects the signed AUTH event", async () => {
    const server = await relay({
      onConnect(fake) {
        fake.send([AUTH, "challenge-reject"]);
      },
      onMessage(message, fake) {
        if (!isCommand(message, AUTH)) return;
        const authEvent = message[1] as Record<string, unknown>;
        fake.send(["OK", authEvent.id, false, "not allowed"]);
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).rejects.toThrow(
      /auth.*not allowed|not allowed.*auth/i,
    );
  });

  it("does not complete at EOSE after AUTH until its exact OK is accepted or rejected", async () => {
    let requestId = "";
    let authId = "";
    let rejectedSent = false;
    const rejected = await relay({
      onConnect(fake) {
        fake.send([AUTH, "eose-before-rejection"]);
      },
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) requestId = subscriptionId(message);
        if (isCommand(message, AUTH)) authId = String((message[1] as Record<string, unknown>).id);
        if (requestId && authId && !rejectedSent) {
          rejectedSent = true;
          fake.send(["EOSE", requestId]);
          fake.send(["OK", authId, false, "denied"]);
        }
      },
    });
    await expect(subscribeToRelay(rejected.url, OWNER_KEY, FILTERS, 500)).rejects.toThrow(
      /AUTH rejected.*denied/i,
    );

    let acceptedRequestId = "";
    let acceptedAuthId = "";
    let acceptedSent = false;
    const accepted = await relay({
      onConnect(fake) {
        fake.send([AUTH, "eose-before-acceptance"]);
      },
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          acceptedRequestId = subscriptionId(message);
          if (acceptedSent) fake.send(["EOSE", acceptedRequestId]);
        }
        if (isCommand(message, AUTH))
          acceptedAuthId = String((message[1] as Record<string, unknown>).id);
        if (acceptedRequestId && acceptedAuthId && !acceptedSent) {
          acceptedSent = true;
          fake.send(["EOSE", acceptedRequestId]);
          fake.send(["OK", acceptedAuthId, true, "accepted"]);
        }
      },
    });
    await expect(subscribeToRelay(accepted.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([]);
  });

  it("retries a subscription after CLOSED auth-required and a subsequent AUTH challenge", async () => {
    const event = await signedEvent({ content: "retried subscription" });
    let requests = 0;
    let authenticated = false;
    const server = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          requests++;
          const id = subscriptionId(message);
          if (!authenticated) {
            fake.send(["CLOSED", id, "auth-required: sign in"]);
            fake.send([AUTH, "retry-challenge"]);
          } else {
            fake.send(["EVENT", id, event]);
            fake.send(["EOSE", id]);
          }
          return;
        }
        if (isCommand(message, AUTH)) {
          const authEvent = message[1] as Record<string, unknown>;
          authenticated = true;
          fake.send(["OK", authEvent.id, true, "accepted"]);
        }
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([event]);
    expect(requests).toBe(2);
  });

  it("treats a close before EOSE as an error, even after receiving events", async () => {
    const event = await signedEvent({ content: "partial result" });
    const server = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        fake.send(["EVENT", subscriptionId(message), event]);
        fake.close();
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).rejects.toThrow(
      /closed.*EOSE|EOSE/i,
    );
  });

  it("returns only events whose id and Schnorr signature verify", async () => {
    const valid = await signedEvent({ content: "valid" });
    const badSignature = corruptSignature(
      await signedEvent({ content: "bad signature", created_at: 1_700_000_001 }),
    );
    const badId = {
      ...(await signedEvent({ content: "bad id", created_at: 1_700_000_002 })),
      id: "0".repeat(64),
    };
    const server = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const id = subscriptionId(message);
        fake.send(["EVENT", id, badSignature]);
        fake.send(["EVENT", id, badId]);
        fake.send(["EVENT", id, valid]);
        fake.send(["EOSE", id]);
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([valid]);
  });

  it("uses a new REQ generation after auth and ignores stale EOSE and partial events", async () => {
    const stale = await signedEvent({ content: "must be discarded", created_at: 1 });
    const accepted = await signedEvent({ content: "fresh after AUTH", created_at: 2 });
    const requestIds: string[] = [];
    let authenticated = false;
    const server = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          const id = subscriptionId(message);
          requestIds.push(id);
          if (!authenticated) {
            fake.send(["EVENT", id, stale]);
            fake.send(["CLOSED", id, "auth-required"]);
            fake.send([AUTH, "generation-challenge"]);
          } else {
            fake.send(["EVENT", id, accepted]);
            fake.send(["EOSE", id]);
          }
          return;
        }
        if (isCommand(message, AUTH)) {
          const authEvent = message[1] as Record<string, unknown>;
          authenticated = true;
          fake.send(["OK", authEvent.id, true, "accepted"]);
          fake.send(["EOSE", requestIds[0]!]);
        }
      },
    });

    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([
      accepted,
    ]);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it("invalidates pre-auth events and reissues every filter after a proactive AUTH challenge", async () => {
    const preAuth = await signedEvent({ kind: 1, content: "discard me", created_at: 1 });
    const freshOne = await signedEvent({ kind: 1, content: "fresh one", created_at: 2 });
    const freshTwo = await signedEvent({ kind: 2, content: "fresh two", created_at: 3 });
    const initialIds: string[] = [];
    const retryIds: string[] = [];
    let challengeSent = false;
    let authenticated = false;
    const server = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          const id = subscriptionId(message);
          if (!authenticated) {
            initialIds.push(id);
            fake.send(["EVENT", id, preAuth]);
            if (initialIds.length === 2 && !challengeSent) {
              challengeSent = true;
              fake.send([AUTH, "proactive-auth"]);
            }
          } else {
            retryIds.push(id);
            const event = retryIds.length === 1 ? freshOne : freshTwo;
            fake.send(["EVENT", id, event]);
            fake.send(["EOSE", id]);
          }
          return;
        }
        if (isCommand(message, AUTH)) {
          const authEvent = message[1] as Record<string, unknown>;
          for (const id of initialIds) fake.send(["EOSE", id]);
          authenticated = true;
          fake.send(["OK", authEvent.id, true, "accepted"]);
        }
      },
    });

    await expect(
      subscribeToRelay(server.url, OWNER_KEY, [{ kinds: [1] }, { kinds: [2] }], 800),
    ).resolves.toEqual(expect.arrayContaining([freshOne, freshTwo]));
    expect(retryIds).toHaveLength(2);
    expect(retryIds.every((id) => !initialIds.includes(id))).toBe(true);
  });

  it("does not lose a late auth-required CLOSED after EOSE while sibling filters settle", async () => {
    const initialIds: string[] = [];
    const retryIds: string[] = [];
    let sentRace = false;
    let authenticated = false;
    const server = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          const id = subscriptionId(message);
          if (!authenticated) {
            initialIds.push(id);
            if (initialIds.length === 2 && !sentRace) {
              sentRace = true;
              fake.send(["EOSE", initialIds[0]!]);
              fake.send(["CLOSED", initialIds[0]!, "auth-required: late policy"]);
              fake.send([AUTH, "late-closed-challenge"]);
              fake.send(["EOSE", initialIds[1]!]);
            }
          } else {
            retryIds.push(id);
            fake.send(["EOSE", id]);
          }
          return;
        }
        if (isCommand(message, AUTH)) {
          authenticated = true;
          fake.send(["OK", (message[1] as Record<string, unknown>).id, true, "accepted"]);
        }
      },
    });

    await expect(
      subscribeToRelay(server.url, OWNER_KEY, [{ kinds: [1] }, { kinds: [2] }], 800),
    ).resolves.toEqual([]);
    expect(retryIds).toHaveLength(2);
  });

  it("counts unique delivered invalid event ids toward a full filter page, but not repeats", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      created_at: 1,
      tags: [["a", `30617:${pubkey(OWNER_KEY)}:unique-page-counts`]],
    });
    const valid = await Promise.all(
      Array.from({ length: 999 }, (_, index) =>
        signedEvent({
          kind: 1,
          content: `valid-${index}`,
          created_at: index + 2,
          tags: [["e", root.id]],
        }),
      ),
    );
    const capped = await relay({
      filterEvents: [root, ...valid],
      onMessage(message, fake) {
        const filter = message[2] as Record<string, unknown> | undefined;
        if (isCommand(message, REQUEST) && Array.isArray(filter?.["#e"])) {
          fake.send(["EVENT", subscriptionId(message), { id: "f".repeat(64) }]);
        }
      },
    });
    await expect(fetchPrConversation(root.id, capped.url, OWNER_KEY, 4_000)).rejects.toThrow(
      /completeness cannot be established/i,
    );

    const repeat = valid[0]!;
    const repeated = await relay({
      filterEvents: [root, ...Array.from({ length: 1_000 }, () => repeat)],
      onMessage(message, fake) {
        const filter = message[2] as Record<string, unknown> | undefined;
        if (isCommand(message, REQUEST) && Array.isArray(filter?.["#e"])) {
          for (let index = 0; index < 20; index++) {
            fake.send(["EVENT", subscriptionId(message), { id: "f".repeat(64) }]);
          }
        }
      },
    });
    await expect(
      fetchPrConversation(root.id, repeated.url, OWNER_KEY, 4_000),
    ).resolves.toMatchObject({
      comments: [{ id: repeat.id }],
    });
  });

  it("ignores malformed pre-challenge OK and prose NOTICE while recognizing canonical auth-required NOTICE", async () => {
    const event = await signedEvent({ content: "after harmless notice" });
    const harmless = await relay({
      onConnect(fake) {
        fake.send(["OK", null, false, "not an AUTH correlation"]);
      },
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const id = subscriptionId(message);
        fake.send(["NOTICE", "documentation prose says auth required elsewhere"]);
        fake.send(["EVENT", id, event]);
        fake.send(["EOSE", id]);
      },
    });
    await expect(subscribeToRelay(harmless.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([event]);

    let retried = false;
    const canonical = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) {
          const id = subscriptionId(message);
          if (!retried) {
            fake.send(["NOTICE", "auth-required: machine policy"]);
            fake.send([AUTH, "machine-required-challenge"]);
          } else fake.send(["EOSE", id]);
          return;
        }
        if (isCommand(message, AUTH)) {
          retried = true;
          fake.send(["OK", (message[1] as Record<string, unknown>).id, true, "accepted"]);
        }
      },
    });
    await expect(subscribeToRelay(canonical.url, OWNER_KEY, FILTERS, 500)).resolves.toEqual([]);
  });

  it("rejects oversized AUTH challenges and repeated post-auth challenges without waiting for timeout", async () => {
    const oversized = await relay({
      onConnect(fake) {
        fake.send([AUTH, "x".repeat(1025)]);
      },
    });
    await expect(subscribeToRelay(oversized.url, OWNER_KEY, FILTERS, 500)).rejects.toThrow(
      /AUTH.*challenge|challenge.*AUTH/i,
    );

    let accepted = false;
    const repeated = await relay({
      onConnect(fake) {
        fake.send([AUTH, "one"]);
      },
      onMessage(message, fake) {
        if (!isCommand(message, AUTH)) return;
        const authEvent = message[1] as Record<string, unknown>;
        if (!accepted) {
          accepted = true;
          fake.send(["OK", authEvent.id, true, "accepted"]);
          fake.send([AUTH, "two"]);
        }
      },
    });
    await expect(subscribeToRelay(repeated.url, OWNER_KEY, FILTERS, 500)).rejects.toThrow(
      /AUTH.*challenge|challenge.*AUTH/i,
    );
  });

  it("fails promptly on a relay text frame above the transport limit", async () => {
    const server = await relay({
      onMessage(message, fake) {
        if (isCommand(message, REQUEST)) fake.sendText("x".repeat(1_100_000));
      },
    });
    const started = Date.now();
    await expect(subscribeToRelay(server.url, OWNER_KEY, FILTERS, 1_500)).rejects.toThrow(
      /frame|message|limit|size/i,
    );
    expect(Date.now() - started).toBeLessThan(750);
  });

  it("fails before timeout when a relay floods event frames or cumulative bytes", async () => {
    const eventFlood = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const id = subscriptionId(message);
        for (let index = 0; index <= MAX_RELAY_EVENT_FRAMES; index++) fake.send(["EVENT", id, {}]);
      },
    });
    await expect(subscribeToRelay(eventFlood.url, OWNER_KEY, FILTERS, 1_500)).rejects.toThrow(
      /event frame|pending message work/i,
    );

    const cumulative = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const chunk = "x".repeat(512 * 1024 - 128);
        for (let size = 0; size <= MAX_RELAY_CUMULATIVE_BYTES; size += chunk.length) {
          fake.send(["NOTICE", chunk]);
        }
      },
    });
    await expect(subscribeToRelay(cumulative.url, OWNER_KEY, FILTERS, 2_000)).rejects.toThrow(
      /cumulative message size/i,
    );
  });
});

describe("fetchPrConversation", () => {
  it("assembles a signed PR root with deterministic update, comment, review, and trusted status ordering", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "PR root",
      created_at: 10,
      tags: [["a", `30617:${pubkey(OWNER_KEY)}:example-repository`]],
    });
    const updateLate = await signedEvent({
      kind: 1619,
      content: "late update",
      created_at: 30,
      tags: [
        ["E", root.id],
        ["P", root.pubkey],
      ],
    });
    const updateEarly = await signedEvent({
      kind: 1619,
      content: "early update",
      created_at: 20,
      tags: [
        ["E", root.id],
        ["P", root.pubkey],
      ],
    });
    const comment = await signedEvent({
      kind: 1,
      content: "comment",
      created_at: 24,
      tags: [["e", root.id]],
      privateKey: REVIEWER_KEY,
    });
    const review = await signedEvent({
      kind: 1,
      content: "review",
      created_at: 25,
      tags: [
        ["e", root.id],
        ["review", "approve"],
      ],
      privateKey: REVIEWER_KEY,
    });
    const trustedStatus = await signedEvent({
      kind: 1631,
      content: "merged",
      created_at: 40,
      tags: [["e", root.id, "", "root"]],
    });
    const untrustedStatus = await signedEvent({
      kind: 1632,
      content: "forged close",
      created_at: 41,
      tags: [["e", root.id, "", "root"]],
      privateKey: UNTRUSTED_KEY,
    });
    const unrelated = await signedEvent({
      kind: 1,
      content: "elsewhere",
      created_at: 1,
      tags: [["e", "a".repeat(64)]],
    });
    const badSignature = corruptSignature(
      await signedEvent({
        kind: 1619,
        content: "tampered",
        created_at: 15,
        tags: [
          ["E", root.id],
          ["P", root.pubkey],
        ],
      }),
    );
    const allEvents = [
      unrelated,
      updateLate,
      badSignature,
      review,
      trustedStatus,
      root,
      comment,
      untrustedStatus,
      updateEarly,
    ];
    const server = await relay({
      onMessage(message, fake) {
        if (!isCommand(message, REQUEST)) return;
        const id = subscriptionId(message);
        for (const event of allEvents) fake.send(["EVENT", id, event]);
        fake.send(["EOSE", id]);
      },
    });

    const thread = await fetchPrConversation(root.id, server.url, OWNER_KEY, 500);
    expect(thread.root.id).toBe(root.id);
    expect(thread.updates.map((event) => event.id)).toEqual([updateEarly.id, updateLate.id]);
    expect(thread.comments.map((event) => event.id)).toEqual([comment.id, review.id]);
    expect(thread.statuses.map((event) => event.id)).toEqual([trustedStatus.id]);
    expect(thread.events.map((event) => event.id)).toEqual([
      root.id,
      updateEarly.id,
      comment.id,
      review.id,
      updateLate.id,
      trustedStatus.id,
    ]);
  });

  it("requests exact #e/#E relations and includes NIP-22 comments plus owner-signed statuses", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      created_at: 10,
      privateKey: REVIEWER_KEY,
      tags: [["a", `30617:${pubkey(REPOSITORY_OWNER_KEY)}:project`]],
    });
    const statusByOwner = await signedEvent({
      kind: 1631,
      content: "merged by owner",
      created_at: 20,
      privateKey: REPOSITORY_OWNER_KEY,
      tags: [["e", root.id, "", "root"]],
    });
    const untrustedStatus = await signedEvent({
      kind: 1632,
      content: "spoofed",
      created_at: 21,
      privateKey: UNTRUSTED_KEY,
      tags: [["e", root.id, "", "root"]],
    });
    const directNip22 = await signedEvent({
      kind: 1111,
      content: "direct NIP-22 comment",
      created_at: 22,
      tags: [
        ["E", root.id],
        ["K", "1618"],
        ["P", root.pubkey],
      ],
      privateKey: UNTRUSTED_KEY,
    });
    const nestedNip22 = await signedEvent({
      kind: 1111,
      content: "nested NIP-22 comment",
      created_at: 23,
      tags: [
        ["E", directNip22.id],
        ["E", root.id, "", "root"],
        ["K", "1618"],
        ["P", root.pubkey],
      ],
      privateKey: OWNER_KEY,
    });
    const upperCaseComment = await signedEvent({
      kind: 1,
      content: "uppercase relation comment",
      created_at: 24,
      tags: [["E", root.id]],
      privateKey: OWNER_KEY,
    });
    const server = await relay({
      filterEvents: [
        root,
        statusByOwner,
        untrustedStatus,
        directNip22,
        nestedNip22,
        upperCaseComment,
      ],
    });

    const thread = await fetchPrConversation(root.id, server.url, OWNER_KEY, 500);
    expect(thread.repositoryOwner).toBe(pubkey(REPOSITORY_OWNER_KEY));
    expect(thread.statuses.map((event) => event.id)).toEqual([statusByOwner.id]);
    expect(thread.comments.map((event) => event.id)).toEqual([
      directNip22.id,
      nestedNip22.id,
      upperCaseComment.id,
    ]);
    expect(thread.events.map((event) => event.id)).not.toContain(untrustedStatus.id);
  });

  it("accepts only root-marked lowercase-e statuses and fully-rooted NIP-22 comments", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      privateKey: REVIEWER_KEY,
      tags: [["a", `30617:${pubkey(REPOSITORY_OWNER_KEY)}:strict-relations`]],
    });
    const acceptedStatus = await signedEvent({
      kind: 1631,
      content: "accepted owner status",
      privateKey: REPOSITORY_OWNER_KEY,
      tags: [["e", root.id, "", "root"]],
    });
    const upperCaseStatus = await signedEvent({
      kind: 1632,
      content: "uppercase injection",
      privateKey: REPOSITORY_OWNER_KEY,
      tags: [["E", root.id, "", "root"]],
    });
    const replyStatus = await signedEvent({
      kind: 1632,
      content: "reply injection",
      privateKey: REPOSITORY_OWNER_KEY,
      tags: [["e", root.id, "", "reply"]],
    });
    const incidentalStatus = await signedEvent({
      kind: 1632,
      content: "incidental injection",
      privateKey: REPOSITORY_OWNER_KEY,
      tags: [["e", root.id]],
    });
    const acceptedComment = await signedEvent({
      kind: 1111,
      content: "accepted NIP-22",
      tags: [
        ["E", root.id],
        ["K", "1618"],
        ["P", root.pubkey],
      ],
    });
    const wrongKind = await signedEvent({
      kind: 1111,
      content: "wrong kind metadata",
      tags: [
        ["E", root.id],
        ["K", "1"],
        ["P", root.pubkey],
      ],
    });
    const missingAuthor = await signedEvent({
      kind: 1111,
      content: "missing author metadata",
      tags: [
        ["E", root.id],
        ["K", "1618"],
      ],
    });
    const incidentalComment = await signedEvent({
      kind: 1111,
      content: "incidental E reference",
      tags: [
        ["E", "b".repeat(64)],
        ["K", "1618"],
        ["P", root.pubkey],
      ],
    });
    const server = await relay({
      filterEvents: [
        root,
        acceptedStatus,
        upperCaseStatus,
        replyStatus,
        incidentalStatus,
        acceptedComment,
        wrongKind,
        missingAuthor,
        incidentalComment,
      ],
    });

    const thread = await fetchPrConversation(root.id, server.url, OWNER_KEY, 800);
    expect(thread.statuses.map((event) => event.id)).toEqual([acceptedStatus.id]);
    expect(thread.comments.map((event) => event.id)).toEqual([acceptedComment.id]);
  });

  it("does not treat per-filter pages as incomplete from aggregate volume or duplicate events", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      tags: [["a", `30617:${pubkey(OWNER_KEY)}:pagination`]],
    });
    const duplicated = await signedEvent({ kind: 1, content: "duplicate", tags: [["e", root.id]] });
    const server = await relay({
      filterEvents: [root, ...Array.from({ length: RELAY_PAGE_LIMIT }, () => duplicated)],
    });

    await expect(fetchPrConversation(root.id, server.url, OWNER_KEY, 2_000)).resolves.toMatchObject(
      {
        root: { id: root.id },
        comments: [{ id: duplicated.id }],
      },
    );
  });

  it("allows more than one thousand aggregate events when every individual filter stays below its page cap", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      tags: [["a", `30617:${pubkey(OWNER_KEY)}:aggregate-pagination`]],
    });
    const overlap = await signedEvent({
      kind: 1,
      content: "matches two relation filters",
      tags: [
        ["e", root.id],
        ["E", root.id],
      ],
    });
    const server = await relay({
      filterEvents: [root, ...Array.from({ length: 600 }, () => overlap)],
    });

    await expect(fetchPrConversation(root.id, server.url, OWNER_KEY, 2_000)).resolves.toMatchObject(
      {
        root: { id: root.id },
        comments: [{ id: overlap.id }],
      },
    );
  });

  it("fails closed only when one filter has a full page of distinct events", async () => {
    const root = await signedEvent({
      kind: 1618,
      content: "root",
      tags: [["a", `30617:${pubkey(OWNER_KEY)}:pagination`]],
    });
    const page = await Promise.all(
      Array.from({ length: RELAY_PAGE_LIMIT }, (_, index) =>
        signedEvent({
          kind: 1,
          content: `comment-${index}`,
          created_at: index + 1,
          tags: [["e", root.id]],
        }),
      ),
    );
    const server = await relay({ filterEvents: [root, ...page] });

    await expect(fetchPrConversation(root.id, server.url, OWNER_KEY, 5_000)).rejects.toThrow(
      /completeness cannot be established/i,
    );
  });
});
