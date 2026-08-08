import { describe, expect, it } from "vitest";
import {
  formatChecksumFile,
  parseChecksumFile,
  sha256,
  verifyChecksums,
  type ChecksumEntry,
} from "../checksums.js";

describe("sha256", () => {
  it("computes the digest of an empty buffer", () => {
    expect(sha256(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("computes the digest of known input", () => {
    const data = new TextEncoder().encode("hello");
    expect(sha256(data)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("formatChecksumFile / parseChecksumFile round-trip", () => {
  const entries: ChecksumEntry[] = [
    { digest: "aaa".repeat(21) + "a", filename: "foo.txt" },
    { digest: "bbb".repeat(21) + "b", filename: "bar.txt" },
  ];
  it("formats sorted lines with two-space separator", () => {
    const out = formatChecksumFile(entries);
    expect(out).toContain("  bar.txt");
    expect(out).toContain("  foo.txt");
    // bar comes before foo alphabetically.
    expect(out.indexOf("bar.txt")).toBeLessThan(out.indexOf("foo.txt"));
  });
  it("round-trips through parse", () => {
    const formatted = formatChecksumFile(entries);
    const parsed = parseChecksumFile(formatted);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.filename).toBe("bar.txt");
    expect(parsed[1]?.filename).toBe("foo.txt");
  });
  it("handles empty input", () => {
    expect(formatChecksumFile([])).toBe("");
    expect(parseChecksumFile("")).toEqual([]);
  });
  it("throws on malformed line", () => {
    expect(() => parseChecksumFile("not a checksum line")).toThrow();
  });
});

describe("verifyChecksums", () => {
  it("passes when all digests match", () => {
    const data = new TextEncoder().encode("test");
    const digest = sha256(data);
    const recorded: ChecksumEntry[] = [{ digest, filename: "test.txt" }];
    const artifacts = new Map([["test.txt", data]]);
    const result = verifyChecksums(recorded, artifacts);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
  });
  it("reports missing files", () => {
    const recorded: ChecksumEntry[] = [{ digest: "0".repeat(64), filename: "missing.txt" }];
    const artifacts = new Map<string, Uint8Array>();
    const result = verifyChecksums(recorded, artifacts);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["missing.txt"]);
  });
  it("reports mismatched digests", () => {
    const data = new TextEncoder().encode("test");
    const recorded: ChecksumEntry[] = [{ digest: "0".repeat(64), filename: "test.txt" }];
    const artifacts = new Map([["test.txt", data]]);
    const result = verifyChecksums(recorded, artifacts);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual(["test.txt"]);
  });
});
