/**
 * Nostr relay access for Buzz pull-request conversations.
 *
 * The relay may allow an initial read without authentication, or require
 * NIP-42 after the initial REQ.  This client supports both without treating a
 * closed unauthenticated subscription as a successful partial response.
 */

import * as secp from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

secp.hashes.sha256 = sha256;

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((total, array) => total + array.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

secp.hashes.hmacSha256 = (key: Uint8Array, ...messages: Uint8Array[]) =>
  hmac(sha256, key, concatBytes(...messages));

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
const HEX_64_BYTES = /^[0-9a-fA-F]{128}$/;
const SUBSCRIPTION_ID = "bap-pr-thread";
export const RELAY_PAGE_LIMIT = 1_000;
export const MAX_RELAY_FILTERS = 16;
export const MAX_AUTH_CHALLENGE_BYTES = 1_024;
export const MAX_RELAY_FRAME_BYTES = 512 * 1024;
export const MAX_RELAY_CUMULATIVE_BYTES = 16 * 1024 * 1024;
export const MAX_RELAY_EVENT_FRAMES = 5_000;
/** Allows a full normal PR page while bounding queued parse/signature work. */
export const MAX_PENDING_MESSAGE_WORK = 2_048;
const MAX_RELAY_REASON_LENGTH = 500;
const STATUS_LABEL: Record<PrStatusEvent["kind"], PrStatusEvent["status"]> = {
  1630: "open",
  1631: "merged",
  1632: "closed",
  1633: "draft",
};

export interface NostrEvent extends Record<string, unknown> {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface UnsignedNostrEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** A verified event, normalized for CLI and machine consumers. */
export interface PrConversationEvent {
  id: string;
  created_at: number;
  kind: number;
  content: string;
  pubkey: string;
  tags: string[][];
  /** The complete, signature-verified Nostr event (including its signature). */
  raw: NostrEvent;
}

export interface PrStatusEvent extends PrConversationEvent {
  kind: 1630 | 1631 | 1632 | 1633;
  status: "open" | "merged" | "closed" | "draft";
  /** Compatibility alias for the event content. */
  body: string;
}

/** Complete PR conversation, with every collection ordered by time then ID. */
export interface PrConversation {
  root: PrConversationEvent;
  /** The owner pubkey parsed from the root event's 30617 `a` tag. */
  repositoryOwner: string;
  updates: PrConversationEvent[];
  comments: PrConversationEvent[];
  statuses: PrStatusEvent[];
  /** Root, updates, comments, and statuses in deterministic chronological order. */
  events: PrConversationEvent[];
}

interface RelaySubscriptionResult {
  events: NostrEvent[];
  /** Includes invalid events so a relay page cannot hide a later valid event. */
  filterEventCounts: number[];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(
    Array.from({ length: hex.length / 2 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

function normalizePrivateKey(key: string): Uint8Array {
  const value = key.trim();
  let privateKey: Uint8Array;

  if (value.slice(0, 5).toLowerCase() === "nsec1") {
    try {
      const decoded = bech32.decode(value, 90);
      if (decoded.prefix.toLowerCase() !== "nsec") {
        throw new Error("unexpected prefix");
      }
      privateKey = bech32.fromWords(decoded.words);
    } catch {
      throw new Error("invalid nsec private key");
    }
  } else {
    if (!HEX_32_BYTES.test(value)) {
      throw new Error("private key must be exactly 32 bytes of hexadecimal or a valid nsec");
    }
    privateKey = hexToBytes(value);
  }

  if (privateKey.length !== 32) {
    throw new Error("private key must decode to exactly 32 bytes");
  }

  try {
    secp.schnorr.getPublicKey(privateKey);
  } catch {
    throw new Error("private key is not a valid secp256k1 scalar");
  }
  return privateKey;
}

function serializeEvent(event: UnsignedNostrEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

function eventHash(event: UnsignedNostrEvent): Uint8Array {
  return sha256(new TextEncoder().encode(serializeEvent(event)));
}

async function signEvent(event: UnsignedNostrEvent, privateKey: Uint8Array): Promise<string> {
  return bytesToHex(secp.schnorr.sign(eventHash(event), privateKey));
}

function getPubkey(privateKey: Uint8Array): string {
  return bytesToHex(secp.schnorr.getPublicKey(privateKey));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    HEX_32_BYTES.test(event.id) &&
    typeof event.pubkey === "string" &&
    HEX_32_BYTES.test(event.pubkey) &&
    typeof event.created_at === "number" &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at >= 0 &&
    typeof event.kind === "number" &&
    Number.isSafeInteger(event.kind) &&
    event.kind >= 0 &&
    Array.isArray(event.tags) &&
    event.tags.every(isStringArray) &&
    typeof event.content === "string" &&
    typeof event.sig === "string" &&
    HEX_64_BYTES.test(event.sig)
  );
}

async function verifyEvent(value: unknown): Promise<NostrEvent | null> {
  if (!isNostrEvent(value)) return null;
  const event: NostrEvent = {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    tags: value.tags.map((tag) => [...tag]),
    content: value.content,
    sig: value.sig,
  };
  const hash = eventHash(event);
  if (event.id !== bytesToHex(hash)) return null;
  try {
    return (await secp.schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey)))
      ? event
      : null;
  } catch {
    return null;
  }
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

function isClosedAuthRequired(reason: string): boolean {
  return /^auth-required(?:$|:|\s)/i.test(reason);
}

function isNoticeAuthRequired(notice: string): boolean {
  return /^auth-required(?:$|:)/i.test(notice);
}

function relayReason(value: unknown): string {
  const reason = typeof value === "string" ? value : "no reason provided";
  const printable = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (printable.length <= MAX_RELAY_REASON_LENGTH) return printable || "no reason provided";
  return `${printable.slice(0, MAX_RELAY_REASON_LENGTH - 1)}…`;
}

function normalizeRelayUrl(relayUrl: string): string {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new Error("relay URL must be a valid ws:// or wss:// origin");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("relay URL must use ws:// or wss://");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("relay URL must be a bare ws:// or wss:// origin");
  }
  return url.origin;
}

function deliveredEventKey(value: unknown, uniqueFrameId: number): string {
  if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" && HEX_32_BYTES.test(id)) return `id:${id.toLowerCase()}`;
  }
  return `invalid:${uniqueFrameId}`;
}

/**
 * Subscribe immediately, authenticate only when challenged, and resolve only
 * after EOSE.  Returned events have passed both Nostr ID and Schnorr checks.
 */
async function subscribeToRelayDetails(
  relayUrl: string,
  privateKey: string,
  filters: Record<string, unknown>[],
  timeoutMs = 30_000,
): Promise<RelaySubscriptionResult> {
  if (filters.length === 0 || filters.length > MAX_RELAY_FILTERS) {
    throw new Error(`subscription requires between 1 and ${MAX_RELAY_FILTERS} filters`);
  }
  const canonicalRelayUrl = normalizeRelayUrl(relayUrl);
  const privateKeyBytes = normalizePrivateKey(privateKey);
  const pubkey = getPubkey(privateKeyBytes);
  const websocket = new WebSocket(canonicalRelayUrl);
  const events = new Map<string, NostrEvent>();

  return new Promise<RelaySubscriptionResult>((resolve, reject) => {
    let opened = false;
    let settled = false;
    let authEventId: string | null = null;
    let authAttempts = 0;
    let authenticated = false;
    let authRequired = false;
    let authResubscriptionRequired = false;
    let subscriptionReissued = false;
    let generation = 0;
    let totalEventFrames = 0;
    let deliveredEventFrames = 0;
    let cumulativeFrameBytes = 0;
    let pendingMessageWork = 0;
    let filterEventIds = filters.map(() => new Set<string>());
    let activeSubscriptions = new Map<string, number>();
    let generationSubscriptions = new Map<string, number>();
    let messageQueue = Promise.resolve();

    const connectTimeout = setTimeout(() => fail(new Error("WebSocket connect timeout")), 10_000);
    const timeout = setTimeout(() => fail(new Error("Subscription timeout")), timeoutMs);

    function close(): void {
      try {
        websocket.close();
      } catch {
        // The original relay error is more useful than a close failure.
      }
    }

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      clearTimeout(timeout);
      close();
      resolve({
        events: [...events.values()],
        filterEventCounts: filterEventIds.map((eventIds) => eventIds.size),
      });
    }

    function finishIfComplete(): void {
      if (activeSubscriptions.size !== 0) return;
      if (authEventId !== null && !authenticated) return;
      finish();
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      clearTimeout(timeout);
      close();
      reject(error);
    }

    function invalidateCurrentGeneration(): void {
      activeSubscriptions = new Map();
      generationSubscriptions = new Map();
      filterEventIds = filters.map(() => new Set<string>());
      events.clear();
    }

    function sendRequests(): void {
      generation += 1;
      activeSubscriptions = new Map();
      generationSubscriptions = new Map();
      filterEventIds = filters.map(() => new Set<string>());
      for (const [index, filter] of filters.entries()) {
        const subscriptionId = `${SUBSCRIPTION_ID}-${generation}-${index}`;
        activeSubscriptions.set(subscriptionId, index);
        generationSubscriptions.set(subscriptionId, index);
        try {
          websocket.send(JSON.stringify(["REQ", subscriptionId, filter]));
        } catch (error) {
          fail(new Error(`Unable to send subscription request: ${String(error)}`));
          return;
        }
      }
    }

    function retrySubscriptionAfterAuth(): void {
      if (!authRequired || subscriptionReissued) return;
      subscriptionReissued = true;
      sendRequests();
    }

    async function respondToAuthChallenge(challenge: unknown): Promise<void> {
      if (authenticated) {
        throw new Error("Relay sent a repeated AUTH challenge after authentication");
      }
      if (
        typeof challenge !== "string" ||
        challenge.length === 0 ||
        new TextEncoder().encode(challenge).byteLength > MAX_AUTH_CHALLENGE_BYTES
      ) {
        throw new Error("Relay sent an invalid AUTH challenge");
      }
      if (authAttempts >= 2) {
        throw new Error("Relay sent too many AUTH challenges");
      }

      authAttempts += 1;
      authenticated = false;
      authResubscriptionRequired = true;
      invalidateCurrentGeneration();
      const authEvent: UnsignedNostrEvent = {
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 22242,
        tags: [
          ["relay", canonicalRelayUrl],
          ["challenge", challenge],
        ],
        content: "",
      };
      const id = bytesToHex(eventHash(authEvent));
      authEventId = id;
      const sig = await signEvent(authEvent, privateKeyBytes);
      if (!settled) websocket.send(JSON.stringify(["AUTH", { ...authEvent, id, sig }]));
    }

    function handleAuthenticationRequirement(reason: string): void {
      if (generationSubscriptions.size === 0) return;
      authRequired = true;
      invalidateCurrentGeneration();
      if (authenticated) {
        if (subscriptionReissued) {
          fail(new Error(`Subscription remained auth-required after retry: ${reason}`));
        } else {
          retrySubscriptionAfterAuth();
        }
      }
    }

    async function handleMessage(messageTextValue: string): Promise<void> {
      if (settled) return;
      const message: unknown = JSON.parse(messageTextValue);
      if (!Array.isArray(message) || typeof message[0] !== "string") {
        throw new Error("Relay sent an invalid protocol message");
      }

      switch (message[0]) {
        case "AUTH":
          await respondToAuthChallenge(message[1]);
          return;
        case "OK": {
          const eventId = message[1];
          if (typeof eventId !== "string" || authEventId === null || eventId !== authEventId) {
            return;
          }
          const accepted = message[2];
          const reason = relayReason(message[3]);
          if (accepted !== true) {
            throw new Error(`AUTH rejected: ${reason}`);
          }
          authenticated = true;
          if (authResubscriptionRequired) {
            authResubscriptionRequired = false;
            subscriptionReissued = true;
            sendRequests();
          } else {
            retrySubscriptionAfterAuth();
          }
          finishIfComplete();
          return;
        }
        case "EVENT": {
          if (typeof message[1] !== "string") return;
          const filterIndex = activeSubscriptions.get(message[1]);
          if (filterIndex === undefined) return;
          totalEventFrames += 1;
          deliveredEventFrames += 1;
          if (totalEventFrames > MAX_RELAY_EVENT_FRAMES) {
            throw new Error("Relay exceeded the event frame limit");
          }
          filterEventIds[filterIndex]?.add(deliveredEventKey(message[2], deliveredEventFrames));
          const event = await verifyEvent(message[2]);
          if (event) {
            events.set(event.id, event);
          }
          return;
        }
        case "EOSE": {
          if (typeof message[1] !== "string" || !activeSubscriptions.has(message[1])) return;
          activeSubscriptions.delete(message[1]);
          finishIfComplete();
          return;
        }
        case "CLOSED": {
          if (typeof message[1] !== "string" || !generationSubscriptions.has(message[1])) {
            return;
          }
          const reason = relayReason(message[2]);
          if (isClosedAuthRequired(reason)) {
            handleAuthenticationRequirement(reason);
            return;
          }
          throw new Error(`Subscription closed: ${reason}`);
        }
        case "NOTICE": {
          const notice = relayReason(message[1]);
          if (activeSubscriptions.size > 0 && isNoticeAuthRequired(notice)) {
            handleAuthenticationRequirement(notice);
          }
          return;
        }
        default:
          return;
      }
    }

    websocket.onopen = () => {
      if (settled) return;
      opened = true;
      clearTimeout(connectTimeout);
      sendRequests();
    };
    websocket.onmessage = (raw) => {
      if (settled) return;
      let rawText: string;
      try {
        rawText = messageText(raw.data);
      } catch {
        fail(new Error("Relay sent an unreadable message"));
        return;
      }
      const frameBytes = new TextEncoder().encode(rawText).byteLength;
      if (frameBytes > MAX_RELAY_FRAME_BYTES) {
        fail(new Error("Relay message exceeded the frame size limit"));
        return;
      }
      cumulativeFrameBytes += frameBytes;
      if (cumulativeFrameBytes > MAX_RELAY_CUMULATIVE_BYTES) {
        fail(new Error("Relay exceeded the cumulative message size limit"));
        return;
      }
      pendingMessageWork += 1;
      if (pendingMessageWork > MAX_PENDING_MESSAGE_WORK) {
        fail(new Error("Relay exceeded the pending message work limit"));
        return;
      }
      messageQueue = messageQueue
        .then(() => handleMessage(rawText))
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          pendingMessageWork -= 1;
        });
    };
    websocket.onerror = () => {
      if (!opened) fail(new Error("WebSocket connection error"));
    };
    websocket.onclose = () => {
      if (!settled) {
        fail(new Error("WebSocket closed before EOSE"));
      }
    };
  });
}

export async function subscribeToRelay(
  relayUrl: string,
  privateKey: string,
  filters: Record<string, unknown>[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>[]> {
  const { events } = await subscribeToRelayDetails(relayUrl, privateKey, filters, timeoutMs);
  return events;
}

function eventToConversationEvent(event: NostrEvent): PrConversationEvent {
  return {
    id: event.id,
    created_at: event.created_at,
    kind: event.kind,
    content: event.content,
    pubkey: event.pubkey,
    tags: event.tags.map((tag) => [...tag]),
    raw: event,
  };
}

function compareChronologically(left: PrConversationEvent, right: PrConversationEvent): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

function hasParentReference(event: NostrEvent, rootId: string): boolean {
  return event.tags.some((tag) => (tag[0] === "e" || tag[0] === "E") && tag[1] === rootId);
}

function hasPrUpdateReference(event: NostrEvent, root: NostrEvent): boolean {
  return (
    event.tags.some((tag) => tag[0] === "E" && tag[1] === root.id) &&
    event.tags.some((tag) => tag[0] === "P" && tag[1]?.toLowerCase() === root.pubkey.toLowerCase())
  );
}

function hasStatusRootReference(event: NostrEvent, root: NostrEvent): boolean {
  return event.tags.some((tag) => tag[0] === "e" && tag[1] === root.id && tag[3] === "root");
}

function hasNip22RootReference(event: NostrEvent, root: NostrEvent): boolean {
  return (
    event.tags.some((tag) => tag[0] === "E" && tag[1] === root.id) &&
    event.tags.some((tag) => tag[0] === "K" && tag[1] === "1618") &&
    event.tags.some((tag) => tag[0] === "P" && tag[1]?.toLowerCase() === root.pubkey.toLowerCase())
  );
}

function repositoryOwnerFromRoot(event: NostrEvent): string {
  for (const tag of event.tags) {
    if (tag[0] !== "a") continue;
    const match = tag[1]?.match(/^30617:([0-9a-fA-F]{64}):.+$/);
    if (match?.[1]) return match[1].toLowerCase();
  }
  throw new Error("PR root is missing a valid 30617 repository address");
}

function isStatusKind(kind: number): kind is PrStatusEvent["kind"] {
  return kind === 1630 || kind === 1631 || kind === 1632 || kind === 1633;
}

async function fetchCompleteRelayPage(
  relayUrl: string,
  privateKey: string,
  filters: Record<string, unknown>[],
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const { events: received, filterEventCounts } = await subscribeToRelayDetails(
    relayUrl,
    privateKey,
    filters.map((filter) => ({ ...filter, limit: RELAY_PAGE_LIMIT })),
    timeoutMs,
  );
  if (filterEventCounts.some((count) => count >= RELAY_PAGE_LIMIT)) {
    throw new Error(
      `Relay returned ${RELAY_PAGE_LIMIT} events for one PR query; conversation completeness cannot be established`,
    );
  }
  return received.filter(isNostrEvent);
}

/**
 * Fetch the root PR and its complete accepted conversation.
 *
 * Updates and lifecycle status events are security-sensitive: only the PR
 * author or the repository owner encoded by the root's `a` tag can write them.
 * Comments remain visible from any author, but must directly reference the PR.
 */
export async function fetchPrConversation(
  prEventId: string,
  relayUrl: string,
  privateKey: string,
  timeoutMs = 30_000,
): Promise<PrConversation> {
  if (!HEX_32_BYTES.test(prEventId)) {
    throw new Error("PR event id must be exactly 32 bytes of hexadecimal");
  }
  const rootId = prEventId.toLowerCase();
  const received = await fetchCompleteRelayPage(
    relayUrl,
    privateKey,
    [
      { kinds: [1618], ids: [rootId] },
      { kinds: [1, 1111, 1630, 1631, 1632, 1633], "#e": [rootId] },
      { kinds: [1, 1111, 1630, 1631, 1632, 1633], "#E": [rootId] },
      { kinds: [1619], "#E": [rootId] },
    ],
    timeoutMs,
  );
  const events = new Map<string, NostrEvent>();
  for (const event of received) {
    events.set(event.id, event);
  }

  const root = events.get(rootId);
  if (!root || root.kind !== 1618) {
    throw new Error(`PR root ${rootId} was not found`);
  }
  const repositoryOwner = repositoryOwnerFromRoot(root);
  const trustedAuthors = new Set([root.pubkey.toLowerCase(), repositoryOwner]);
  const updates: PrConversationEvent[] = [];
  const comments: PrConversationEvent[] = [];
  const statuses: PrStatusEvent[] = [];

  for (const event of events.values()) {
    if (event.id === root.id) continue;
    const normalized = eventToConversationEvent(event);
    if (event.kind === 1619) {
      if (hasPrUpdateReference(event, root) && trustedAuthors.has(event.pubkey.toLowerCase())) {
        updates.push(normalized);
      }
      continue;
    }
    if (event.kind === 1 && hasParentReference(event, root.id)) {
      comments.push(normalized);
      continue;
    }
    if (event.kind === 1111 && hasNip22RootReference(event, root)) {
      comments.push(normalized);
      continue;
    }
    if (
      isStatusKind(event.kind) &&
      hasStatusRootReference(event, root) &&
      trustedAuthors.has(event.pubkey.toLowerCase())
    ) {
      statuses.push({
        ...normalized,
        kind: event.kind,
        status: STATUS_LABEL[event.kind],
        body: event.content,
      });
    }
  }

  const rootEvent = eventToConversationEvent(root);
  updates.sort(compareChronologically);
  comments.sort(compareChronologically);
  statuses.sort(compareChronologically);
  const eventsInConversation = [rootEvent, ...updates, ...comments, ...statuses].sort(
    compareChronologically,
  );

  return {
    root: rootEvent,
    repositoryOwner,
    updates,
    comments,
    statuses,
    events: eventsInConversation,
  };
}
