/**
 * Release artifact naming conventions.
 *
 * Defines the canonical names for all release artifacts (tarball, SBOM,
 * checksums, signatures) so producers and verifiers share one source of truth.
 *
 * @module scripts/release/artifacts
 */

import { normalizeScopedName, tarballName } from "./version.js";

/** Roles for artifacts: source package vs OCI image. */
export type ArtifactRole = "source" | "image";

/** Metadata for a single release artifact. */
export interface ReleaseArtifact {
  role: ArtifactRole;
  name: string;
  description: string;
}

/**
 * Enumerate all artifacts produced for a source-only release.
 *
 * @param pkgName - npm package name (e.g. `@willgriffin/buzz-agent-prime`)
 * @param version - semantic version string (e.g. `0.1.0`)
 */
export function sourceArtifacts(pkgName: string, version: string): ReleaseArtifact[] {
  const tarball = tarballName(pkgName, version);
  const scoped = normalizeScopedName(pkgName);
  return [
    { role: "source", name: tarball, description: "npm package tarball" },
    { role: "source", name: `${tarball}.sha256`, description: "SHA-256 digest of the tarball" },
    {
      role: "source",
      name: `${tarball}.sig`,
      description: "Cosign keyless signature (DSSE envelope) of the tarball",
    },
    {
      role: "source",
      name: `${scoped}-${version}.sbom.json`,
      description: "CycloneDX SBOM for the source package",
    },
    {
      role: "source",
      name: `SHA256SUMS-${version}.txt`,
      description: "SHA-256 checksum file for all source artifacts",
    },
    {
      role: "source",
      name: `SHA256SUMS-${version}.txt.sig`,
      description: "Cosign keyless signature of the checksum file",
    },
  ];
}

/**
 * Enumerate all artifacts produced for an OCI image release.
 *
 * @param pkgName - used to derive the GHCR repository name
 * @param version - semantic version string
 */
export function imageArtifacts(pkgName: string, version: string): ReleaseArtifact[] {
  const scoped = normalizeScopedName(pkgName);
  return [
    { role: "image", name: `${scoped}-${version}.sbom.json`, description: "CycloneDX SBOM for the OCI image" },
    {
      role: "image",
      name: `${scoped}-${version}.provenance.json`,
      description: "SLSA provenance attestation for the OCI image",
    },
  ];
}

/** Combined list of all artifacts for a full release. */
export function allArtifacts(pkgName: string, version: string): ReleaseArtifact[] {
  return [...sourceArtifacts(pkgName, version), ...imageArtifacts(pkgName, version)];
}

/** GHCR repository path derived from the package name. */
export function ghcrRepository(owner: string, pkgName: string): string {
  const scoped = normalizeScopedName(pkgName);
  return `ghcr.io/${owner.toLowerCase()}/${scoped}`;
}
