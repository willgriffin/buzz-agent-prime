/**
 * Release version and tag arithmetic.
 *
 * Computes git tags, OCI image tags, and npm tarball names from semantic
 * version strings. All functions throw on malformed input so callers can
 * fail fast during a release gate.
 *
 * @module scripts/release/version
 */

/** A parsed semantic version (without build metadata). */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/;

const TAG_RE =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/;

/** Validate that a string is a well-formed semver (accepts build metadata). */
export function validateVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** Parse a semver string into its components. Throws on invalid input. */
export function parseVersion(v: string): ParsedVersion {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new Error(`invalid semver: "${v}"`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease = m[4] ?? null;
  return { major, minor, patch, prerelease };
}

/** Parse a git tag (e.g. `v0.1.0`) into a {@link ParsedVersion}. */
export function parseTag(tag: string): ParsedVersion {
  const m = TAG_RE.exec(tag);
  if (!m) throw new Error(`invalid version tag: "${tag}"`);
  return parseVersion(m[1]);
}

/** Check whether a git tag is a version tag. */
export function isVersionTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

/** Generate the git tag for a version (e.g. `0.1.0` → `v0.1.0`). */
export function tagForVersion(v: string): string {
  if (!validateVersion(v)) throw new Error(`invalid semver: "${v}"`);
  return `v${v}`;
}

/**
 * OCI image tag set for a version.
 *
 * For a stable release (`0.1.0`) returns `["0.1", "0.1.0", "0", "latest"]`.
 * For a prerelease (`0.1.0-rc.1`) returns only the exact tag
 * (`["0.1.0-rc.1"]`) — short and `latest` tags are omitted because moving
 * tags should not point at pre-release images.
 *
 * @param v - semantic version string
 * @param includeLatest - whether to include the `latest` tag (default true)
 * @returns sorted list of OCI tags
 */
export function imageTags(v: string, includeLatest = true): string[] {
  const { major, minor, patch, prerelease } = parseVersion(v);
  const tags = new Set<string>();
  // Exact tag (includes prerelease suffix if any).
  tags.add(`${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}`);
  // Short tags (minor, major, latest) only for stable releases.
  if (!prerelease) {
    tags.add(`${major}.${minor}`);
    tags.add(`${major}`);
  }
  if (includeLatest && !prerelease) {
    tags.add("latest");
  }
  return [...tags].sort();
}

/** Normalise a scoped npm package name for tarball naming. */
export function normalizeScopedName(name: string): string {
  return name.replace("@", "").replace("/", "-");
}

/** Source package tarball name as npm would produce it. */
export function tarballName(pkgName: string, v: string): string {
  return `${normalizeScopedName(pkgName)}-${v}.tgz`;
}

/** Strip build metadata from a version string (e.g. `1.2.3+build` → `1.2.3`). */
export function stripBuildMetadata(v: string): string {
  return v.split("+")[0] ?? v;
}
