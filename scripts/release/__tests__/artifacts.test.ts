import { describe, expect, it } from "vitest";
import {
  sourceArtifacts,
  imageArtifacts,
  allArtifacts,
  ghcrRepository,
} from "../artifacts.js";

const PKG = "@willgriffin/buzz-agent-prime";

describe("sourceArtifacts", () => {
  it("includes tarball, checksum, signature, and SBOM", () => {
    const arts = sourceArtifacts(PKG, "0.1.0");
    const names = arts.map((a) => a.name);
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.tgz");
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.tgz.sha256");
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.tgz.sig");
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.sbom.json");
    expect(names).toContain("SHA256SUMS-0.1.0.txt");
    expect(names).toContain("SHA256SUMS-0.1.0.txt.sig");
    expect(arts.every((a) => a.role === "source")).toBe(true);
    expect(arts.every((a) => a.description.length > 0)).toBe(true);
  });
});

describe("imageArtifacts", () => {
  it("includes SBOM and provenance", () => {
    const arts = imageArtifacts(PKG, "0.1.0");
    const names = arts.map((a) => a.name);
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.sbom.json");
    expect(names).toContain("willgriffin-buzz-agent-prime-0.1.0.provenance.json");
    expect(arts.every((a) => a.role === "image")).toBe(true);
  });
});

describe("allArtifacts", () => {
  it("combines source and image artifacts", () => {
    const all = allArtifacts(PKG, "0.1.0");
    expect(all.length).toBeGreaterThan(sourceArtifacts(PKG, "0.1.0").length);
    expect(all.some((a) => a.role === "source")).toBe(true);
    expect(all.some((a) => a.role === "image")).toBe(true);
  });
});

describe("ghcrRepository", () => {
  it("builds a lowercase GHCR path", () => {
    expect(ghcrRepository("WillGriffin", PKG)).toBe(
      "ghcr.io/willgriffin/willgriffin-buzz-agent-prime",
    );
  });
});
