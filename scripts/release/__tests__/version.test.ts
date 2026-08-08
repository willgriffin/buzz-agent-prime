import { describe, expect, it } from "vitest";
import {
  imageTags,
  isVersionTag,
  normalizeScopedName,
  parseTag,
  parseVersion,
  tagForVersion,
  tarballName,
  validateVersion,
  stripBuildMetadata,
} from "../version.js";

describe("validateVersion", () => {
  it("accepts well-formed semver", () => {
    expect(validateVersion("0.1.0")).toBe(true);
    expect(validateVersion("1.2.3")).toBe(true);
    expect(validateVersion("10.20.30")).toBe(true);
    expect(validateVersion("0.1.0-rc.1")).toBe(true);
    expect(validateVersion("0.1.0+build.1")).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(validateVersion("v0.1.0")).toBe(false);
    expect(validateVersion("0.1")).toBe(false);
    expect(validateVersion("latest")).toBe(false);
    expect(validateVersion("")).toBe(false);
  });
});

describe("parseVersion", () => {
  it("parses stable releases", () => {
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: null });
  });
  it("parses prereleases", () => {
    expect(parseVersion("0.1.0-rc.1")).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: "rc.1",
    });
  });
  it("throws on invalid version", () => {
    expect(() => parseVersion("bogus")).toThrow();
  });
});

describe("parseTag / isVersionTag / tagForVersion", () => {
  it("parses a v-prefixed tag", () => {
    expect(parseTag("v0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: null });
  });
  it("recognises version tags", () => {
    expect(isVersionTag("v0.1.0")).toBe(true);
    expect(isVersionTag("v1.2.3-rc.1")).toBe(true);
    expect(isVersionTag("0.1.0")).toBe(false);
    expect(isVersionTag("not-a-tag")).toBe(false);
  });
  it("generates a tag from a version", () => {
    expect(tagForVersion("0.1.0")).toBe("v0.1.0");
    expect(() => tagForVersion("bad")).toThrow();
  });
});

describe("imageTags", () => {
  it("returns full tag set for a stable release", () => {
    const tags = imageTags("0.1.0");
    expect(tags).toEqual(["0", "0.1", "0.1.0", "latest"]);
  });
  it("returns only the exact tag for a prerelease", () => {
    const tags = imageTags("0.1.0-rc.1");
    expect(tags).toEqual(["0.1.0-rc.1"]);
  });
  it("omits latest when includeLatest=false", () => {
    const tags = imageTags("1.2.3", false);
    expect(tags).toEqual(["1", "1.2", "1.2.3"]);
  });
});

describe("tarballName / normalizeScopedName", () => {
  it("normalises scoped names", () => {
    expect(normalizeScopedName("@willgriffin/buzz-agent-prime")).toBe(
      "willgriffin-buzz-agent-prime",
    );
  });
  it("computes the npm tarball name", () => {
    expect(tarballName("@willgriffin/buzz-agent-prime", "0.1.0")).toBe(
      "willgriffin-buzz-agent-prime-0.1.0.tgz",
    );
  });
});

describe("stripBuildMetadata", () => {
  it("strips build metadata", () => {
    expect(stripBuildMetadata("1.2.3+build.1")).toBe("1.2.3");
    expect(stripBuildMetadata("0.1.0")).toBe("0.1.0");
  });
});
