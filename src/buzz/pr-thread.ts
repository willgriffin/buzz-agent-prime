/**
 * `buzz-agent-prime pr-thread` — resolve a Buzz PR conversation from the relay.
 *
 * Connects to the configured Buzz relay, authenticates with the agent's
 * identity, and returns the PR conversation thread (status events of
 * kinds 1630-1633) as NDJSON on stdout.
 */

import { DEFAULT_BUZZ_RELAY_URL } from "../state/config.js";
import { fetchPrConversation } from "./relay.js";

const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const ANSI_ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[()][0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;
const TERMINAL_CONTROL_CHARACTER = /[\u007f-\u009f]/g;
const PRIVATE_KEY_REFERENCE = /\bprivate(?:\s|-|_)*key\b|\bnsec/i;
const URL_USERINFO = /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@]+@/i;
const AUTHORIZATION_CREDENTIAL = /\b(?:bearer|basic)\s+\S+/i;
const NAMED_CREDENTIAL =
  /\b(?:api(?:[-_ ]?key)?|access(?:[-_ ]?token)?|auth(?:orization)?|password|secret|token)\s*(?:=|:)\s*\S+/i;
const SENSITIVE_QUERY_VALUE =
  /[?&](?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)=[^&#\s]*/i;
const HEX_VALUE = /[0-9a-f]{64}/i;

export interface PrThreadErrorSanitizationOptions {
  /** Configured private key, which must never be repeated in diagnostics. */
  privateKey?: string;
  /** Safe replacement for a diagnostic that contains credential-like text. */
  sensitiveMessage?: string;
  /** Treat any 64-hex substring as sensitive in an untrusted CLI argument. */
  redactHexValues?: boolean;
}

export interface PrThreadOptions {
  /** PR event id (64-char hex). */
  event: string;
  /** Relay URL (defaults to $BUZZ_RELAY_URL). */
  relayUrl?: string;
  /** Agent private key (defaults to $BUZZ_PRIVATE_KEY). */
  privateKey?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

export interface PrThreadConfig {
  relayUrl: string;
  privateKey: string | undefined;
}

/**
 * Resolve command configuration with the same precedence as the other runtime
 * commands: explicit options, then environment, then the documented default.
 */
export function resolvePrThreadConfig(
  options: Pick<PrThreadOptions, "relayUrl" | "privateKey">,
  env: NodeJS.ProcessEnv = process.env,
): PrThreadConfig {
  return {
    relayUrl: options.relayUrl ?? env["BUZZ_RELAY_URL"] ?? DEFAULT_BUZZ_RELAY_URL,
    privateKey: options.privateKey ?? env["BUZZ_PRIVATE_KEY"],
  };
}

/** Convert an HTTP(S) relay origin to its WebSocket equivalent. */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay URL must be a valid absolute ws, wss, http, or https URL");
  }

  if (!url.hostname) {
    throw new Error("relay URL must include a host");
  }
  if (url.username || url.password) {
    throw new Error("relay URL must not include user information");
  }
  if (url.pathname !== "/") {
    throw new Error("relay URL must not include a path");
  }
  if (url.search || url.hash) {
    throw new Error("relay URL must not include a query or fragment");
  }

  switch (url.protocol) {
    case "http:":
      url.protocol = "ws:";
      break;
    case "https:":
      url.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new Error("relay URL must use ws, wss, http, or https");
  }

  return url.origin;
}

function redactConfiguredPrivateKey(message: string, privateKey: string | undefined): string {
  const secret = privateKey?.trim();
  if (!secret) return message;
  const escapedSecret = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escapedSecret, "gi"), "[redacted private key]");
}

/** Make untrusted relay failures safe and bounded before writing to a terminal. */
export function sanitizePrThreadError(
  error: unknown,
  options: PrThreadErrorSanitizationOptions = {},
): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unexpected error";
  const sanitized = redactConfiguredPrivateKey(message, options.privateKey)
    // Preserve a boundary so stripped controls cannot join a prefix to key material.
    .replace(ANSI_ESCAPE_SEQUENCE, " ")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (PRIVATE_KEY_REFERENCE.test(sanitized)) {
    return "private key rejected";
  }
  if (
    URL_USERINFO.test(sanitized) ||
    AUTHORIZATION_CREDENTIAL.test(sanitized) ||
    NAMED_CREDENTIAL.test(sanitized) ||
    SENSITIVE_QUERY_VALUE.test(sanitized) ||
    (options.redactHexValues && HEX_VALUE.test(sanitized))
  ) {
    return options.sensitiveMessage ?? "relay request failed";
  }
  if (sanitized.length === 0) {
    return "unexpected error";
  }
  return sanitized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : sanitized;
}

/** Serialize one event as JSON without leaving C1 terminal controls on stdout. */
export function stringifyPrThreadEvent(entry: object): string {
  return JSON.stringify(entry).replace(
    TERMINAL_CONTROL_CHARACTER,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

/**
 * Writes complete NDJSON frames while handling downstream pipe closure.
 *
 * A consumer such as `head` is allowed to close stdout early. That is a
 * successful, quiet termination for a Unix filter, not a command failure.
 */
class PrThreadOutput {
  #closed = false;
  #failure: Error | undefined;
  #listening = false;
  #onError = (error: Error): void => {
    if (isBrokenPipe(error)) {
      this.#closed = true;
    } else {
      this.#failure = error;
    }
  };

  constructor(private readonly output: NodeJS.WritableStream = process.stdout) {}

  async write(frame: string): Promise<boolean> {
    this.#listen();
    if (this.#closed || this.#isUnavailable()) return false;
    if (this.#failure) throw this.#failure;

    try {
      if (this.output.write(frame) === false) {
        return this.#waitForDrain();
      }
    } catch (error) {
      if (isBrokenPipe(error)) {
        this.#closed = true;
        return false;
      }
      throw error;
    }

    if (this.#failure) throw this.#failure;
    return !this.#closed;
  }

  /** Give an asynchronously reported stdout error a chance to arrive. */
  async settle(): Promise<boolean> {
    if (!this.#listening) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.#failure) throw this.#failure;
    return !this.#closed && !this.#isUnavailable();
  }

  dispose(): void {
    if (!this.#listening) return;
    this.output.off("error", this.#onError);
    this.#listening = false;
  }

  #listen(): void {
    if (this.#listening) return;
    this.output.on("error", this.#onError);
    this.#listening = true;
  }

  #isUnavailable(): boolean {
    const stream = this.output as { destroyed?: boolean; writableEnded?: boolean };
    return stream.destroyed === true || stream.writableEnded === true;
  }

  #waitForDrain(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.output.off("drain", onDrain);
        this.output.off("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        if (this.#failure) reject(this.#failure);
        else resolve(!this.#closed && !this.#isUnavailable());
      };
      const onError = (error: Error): void => {
        cleanup();
        if (isBrokenPipe(error)) {
          this.#closed = true;
          resolve(false);
        } else {
          reject(error);
        }
      };
      this.output.once("drain", onDrain);
      this.output.once("error", onError);
    });
  }
}

export async function runPrThread(options: PrThreadOptions): Promise<number> {
  if (!EVENT_ID_PATTERN.test(options.event)) {
    process.stderr.write(
      "buzz-agent-prime pr-thread: event id must be 64 hexadecimal characters\n",
    );
    return 2;
  }

  const { relayUrl, privateKey } = resolvePrThreadConfig(options);

  if (!privateKey) {
    process.stderr.write("buzz-agent-prime pr-thread: BUZZ_PRIVATE_KEY must be set\n");
    return 1;
  }

  try {
    const thread = await fetchPrConversation(
      options.event,
      normalizeRelayUrl(relayUrl),
      privateKey,
      options.timeoutMs,
    );

    const output = new PrThreadOutput();
    try {
      // Output NDJSON. A closed downstream pipe (for example, `| head`) is
      // normal early termination, so no summary is written after it closes.
      for (const entry of thread.events) {
        if (!(await output.write(stringifyPrThreadEvent(entry) + "\n"))) return 0;
      }
      if (!(await output.settle())) return 0;
    } finally {
      output.dispose();
    }

    process.stderr.write(
      `pr-thread: ${thread.events.length} verified event(s) ` +
        `(${thread.updates.length} update(s), ${thread.comments.length} comment(s), ` +
        `${thread.statuses.length} status event(s)) for PR ${thread.root.id.slice(0, 12)}...\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`pr-thread: error: ${sanitizePrThreadError(error, { privateKey })}\n`);
    return 1;
  }
}
