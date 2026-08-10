import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, ...messages) => hmac(sha256, key, join(messages));

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export const OWNER_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
export const REVIEWER_KEY = "0000000000000000000000000000000000000000000000000000000000000002";
export const UNTRUSTED_KEY = "0000000000000000000000000000000000000000000000000000000000000003";
export const REPOSITORY_OWNER_KEY =
  "0000000000000000000000000000000000000000000000000000000000000004";

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function pubkey(privateKey = OWNER_KEY): string {
  return hex(secp.schnorr.getPublicKey(privateBytes(privateKey)));
}

export async function signedEvent(
  overrides: Partial<Omit<SignedNostrEvent, "id" | "pubkey" | "sig">> & {
    privateKey?: string;
  } = {},
): Promise<SignedNostrEvent> {
  const privateKey = overrides.privateKey ?? OWNER_KEY;
  const event = {
    pubkey: pubkey(privateKey),
    created_at: overrides.created_at ?? 1_700_000_000,
    kind: overrides.kind ?? 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
  };
  const id = hex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
      ),
    ),
  );
  return {
    ...event,
    id,
    sig: hex(secp.schnorr.sign(Buffer.from(id, "hex"), privateBytes(privateKey))),
  };
}

export function corruptSignature(event: SignedNostrEvent): SignedNostrEvent {
  return { ...event, sig: `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}` };
}

/** Bech32 encode exactly 32 bytes as a valid lower-case nsec. */
export function nsec(privateKey = OWNER_KEY): string {
  const words = convertBits(Buffer.from(privateKey, "hex"), 8, 5, true);
  const checksum = polymod([...expandHrp("nsec"), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  return `nsec1${[...words, ...[5, 4, 3, 2, 1, 0].map((shift) => (checksum >> (shift * 5)) & 31)].map((word) => CHARSET[word]!).join("")}`;
}

function join(messages: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(messages.reduce((size, item) => size + item.length, 0));
  let offset = 0;
  for (const message of messages) {
    output.set(message, offset);
    offset += message.length;
  }
  return output;
}

function privateBytes(privateKey: string): Uint8Array {
  return Buffer.from(privateKey, "hex");
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function convertBits(bytes: Uint8Array, from: number, to: number, pad: boolean): number[] {
  let accumulator = 0;
  let bits = 0;
  const output: number[] = [];
  const maxValue = (1 << to) - 1;
  for (const byte of bytes) {
    accumulator = (accumulator << from) | byte;
    bits += from;
    while (bits >= to) {
      bits -= to;
      output.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad && bits > 0) output.push((accumulator << (to - bits)) & maxValue);
  return output;
}

function expandHrp(hrp: string): number[] {
  return [...hrp]
    .map((char) => char.charCodeAt(0) >> 5)
    .concat(
      0,
      [...hrp].map((char) => char.charCodeAt(0) & 31),
    );
}

function polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= generators[bit]!;
  }
  return checksum;
}
