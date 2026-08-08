/**
 * SHA-256 checksum generation and verification.
 *
 * Provides pure functions for computing digests, formatting and parsing
 * `SHA256SUMS` files, and verifying file contents against recorded
 * checksums.
 *
 * @module scripts/release/checksums
 */

import { createHash } from "node:crypto";

/** A single checksum entry as it appears in a SHA256SUMS file. */
export interface ChecksumEntry {
  /** Lowercase hex digest (64 characters). */
  digest: string;
  /** Basename of the artifact (no directory component). */
  filename: string;
}

/** Compute the SHA-256 digest of a buffer and return lowercase hex. */
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Format a list of checksum entries as a SHA256SUMS file. */
export function formatChecksumFile(entries: readonly ChecksumEntry[]): string {
  const lines = entries
    .slice()
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((e) => `${e.digest}  ${e.filename}`);
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Parse a SHA256SUMS file into checksum entries. Throws on malformed lines. */
export function parseChecksumFile(content: string): ChecksumEntry[] {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const entries: ChecksumEntry[] = [];
  for (const line of lines) {
    // Format: <64-hex>  <filename>  (two spaces per GNU coreutils)
    const m = /^([0-9a-f]{64})\s\s+(\S.+)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error(`malformed checksum line: ${line}`);
    }
    entries.push({ digest: m[1], filename: m[2].trim() });
  }
  return entries;
}

/** Verify that a set of (filename → content) pairs match recorded checksums. */
export interface VerifyResult {
  ok: boolean;
  missing: string[];
  mismatched: string[];
}

/** Verify buffers against a checksum list. Returns mismatch/missing details. */
export function verifyChecksums(
  recorded: readonly ChecksumEntry[],
  artifacts: ReadonlyMap<string, Uint8Array>,
): VerifyResult {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of recorded) {
    const data = artifacts.get(entry.filename);
    if (!data) {
      missing.push(entry.filename);
      continue;
    }
    if (sha256(data) !== entry.digest) {
      mismatched.push(entry.filename);
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}
