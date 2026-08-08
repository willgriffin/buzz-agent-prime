import { describe, expect, it } from "vitest";
import {
  checkCompatibility,
  parseCompatibilityPins,
  validatePin,
} from "../compatibility.js";

const MOCK_MD = `# Upstream Pins

| Component | Source | Pin | Notes |
| --------- | ------ | --- | ----- |
| prime-agent | PrimeIntellect-ai/prime-agent | a18809e00ea30638584d87b3afea7285a9d7296c | pinned commit |
| buzz | block/buzz | 3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42 | release 0.5.3 |
| Node.js | — | 22 | LTS line |
| Python | — | 3.12 | runtime |

## Policy
`;

describe("parseCompatibilityPins", () => {
  it("extracts the pin table", () => {
    const pins = parseCompatibilityPins(MOCK_MD);
    expect(pins).toHaveLength(4);
    expect(pins[0]?.component).toBe("prime-agent");
    expect(pins[1]?.component).toBe("buzz");
    expect(pins[2]?.component).toBe("Node.js");
  });
  it("returns empty array when no table found", () => {
    expect(parseCompatibilityPins("no table here")).toEqual([]);
  });
});

describe("validatePin", () => {
  it("accepts git SHAs", () => {
    expect(validatePin("a18809e00ea30638584d87b3afea7285a9d7296c")).toBe(true);
    expect(validatePin("3a96acea")).toBe(true);
  });
  it("accepts version tags", () => {
    expect(validatePin("v0.7.1")).toBe(true);
  });
  it("accepts runtime major/minor tracks", () => {
    expect(validatePin("22")).toBe(true);
    expect(validatePin("3.12")).toBe(true);
  });
  it("accepts container digests", () => {
    expect(
      validatePin(
        "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
    ).toBe(true);
  });
  it("accepts ref@sha format", () => {
    expect(validatePin("v0.7.1@a18809e00ea30638584d87b3afea7285a9d7296c")).toBe(true);
  });
  it("rejects mutable refs", () => {
    expect(validatePin("latest")).toBe(false);
    expect(validatePin("master")).toBe(false);
    expect(validatePin("main")).toBe(false);
    expect(validatePin("")).toBe(false);
  });
  it("rejects semver ranges", () => {
    expect(validatePin("^22")).toBe(false);
    expect(validatePin(">=3.12")).toBe(false);
  });
});

describe("checkCompatibility", () => {
  it("passes on valid pins", () => {
    const result = checkCompatibility(MOCK_MD);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.pins).toHaveLength(4);
  });
  it("fails when no pins found", () => {
    const result = checkCompatibility("no pins here");
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });
  it("fails on mutable pins", () => {
    const badMd = MOCK_MD.replace(
      "a18809e00ea30638584d87b3afea7285a9d7296c",
      "latest",
    );
    const result = checkCompatibility(badMd);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("prime-agent"))).toBe(true);
  });
});
