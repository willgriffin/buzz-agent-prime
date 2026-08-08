#!/usr/bin/env node
/**
 * Independent release verification CLI.
 *
 * Usage:
 *   node --experimental-strip-types scripts/release/verify.ts --version 0.1.0
 *
 * Checks that all declared artifacts for a given version are present and
 * that their SHA-256 checksums match the published `SHA256SUMS-<version>.txt`
 * file. Intended to be runnable by anyone, in a clean environment, using only
 * the published artifacts and `cosign` for signature verification.
 *
 * @module scripts/release/verify
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseChecksumFile, verifyChecksums, type VerifyResult } from "./checksums.js";
import { tagForVersion, validateVersion, sourceArtifacts } from "./version.js";

const PKG_NAME = "@willgriffin/buzz-agent-prime";

function parseArgs(argv: string[]): { version: string; dir: string } {
  let version = "";
  let dir = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--version" || a === "-v") {
      version = argv[++i] ?? "";
    } else if (a === "--dir" || a === "-d") {
      dir = argv[++i] ?? ".";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: verify.ts --version <semver> [--dir <artifact-dir>]\n");
      process.exit(0);
    }
  }
  if (!validateVersion(version)) {
    process.stderr.write(`Error: invalid or missing --version\n`);
    process.exit(2);
  }
  return { version, dir: resolve(dir) };
}

function main(): number {
  const { version, dir } = parseArgs(process.argv.slice(2));
  const tag = tagForVersion(version);
  const expected = sourceArtifacts(PKG_NAME, version).map((a) => a.name);
  const checksumFile = `SHA256SUMS-${version}.txt`;

  process.stdout.write(`Verifying release ${tag} in ${dir}\n`);
  process.stdout.write(`Expected artifacts:\n`);
  for (const e of expected) process.stdout.write(`  - ${e}\n`);
  process.stdout.write("\n");

  // 1. Check that all expected files are present.
  const missing: string[] = [];
  for (const name of expected) {
    if (!existsSync(join(dir, name))) missing.push(name);
  }
  if (missing.length > 0) {
    process.stderr.write(`Missing artifacts:\n`);
    for (const m of missing) process.stderr.write(`  - ${m}\n`);
    return 1;
  }

  // 2. Verify checksums.
  const checksumsPath = join(dir, checksumFile);
  const checksumsContent = readFileSync(checksumsPath, "utf8");
  const recorded = parseChecksumFile(checksumsContent);
  const artifacts = new Map<string, Uint8Array>();
  for (const entry of recorded) {
    const data = readFileSync(join(dir, entry.filename));
    artifacts.set(entry.filename, new Uint8Array(data));
  }
  const result: VerifyResult = verifyChecksums(recorded, artifacts);

  if (result.missing.length > 0) {
    process.stderr.write(`Checksum file references missing files:\n`);
    for (const m of result.missing) process.stderr.write(`  - ${m}\n`);
  }
  if (result.mismatched.length > 0) {
    process.stderr.write(`Checksum mismatch for:\n`);
    for (const m of result.mismatched) process.stderr.write(`  - ${m}\n`);
  }

  if (!result.ok) {
    process.stderr.write("\nChecksum verification FAILED.\n");
    return 1;
  }

  process.stdout.write("Checksum verification PASSED.\n");
  process.stdout.write("\nTo verify cosign signatures independently:\n");
  process.stdout.write(`  cosign verify-blob --cert-identity=\
https://github.com/willgriffin/buzz-agent-prime/.github/workflows/release.yml@refs/tags/${tag} \
    --bundle ${join(dir, `SHA256SUMS-${version}.txt.sig`)} \
    ${join(dir, checksumFile)}\n`);
  process.stdout.write("\nTo verify the OCI image signature:\n");
  process.stdout.write(
    `  cosign verify ghcr.io/willgriffin/buzz-agent-prime:${version} \
    --certificate-identity=https://github.com/willgriffin/buzz-agent-prime/.github/workflows/release.yml@refs/tags/${tag} \
    --certificate-oidc-issuer=https://token.actions.githubusercontent.com\n`,
  );

  process.stdout.write("\nVerification PASSED.\n");
  return 0;
}

process.exitCode = main();
