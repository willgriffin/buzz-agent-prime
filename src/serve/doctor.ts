import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { execFileSync } from "node:child_process";
import { resolveStatePaths, ensureStateDirs, isWritable } from "../state/paths.js";
import { which } from "./which.js";

/* ---------- Types ---------- */

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: number;
}

/* ---------- Expected pins (docs/compatibility.md) ---------- */

const EXPECTED_PRIME_AGENT_VERSION = "0.7.1";
const EXPECTED_BUZZ_VERSION = "0.5.3";

/* ---------- Public API ---------- */

/**
 * Run non-destructive environment diagnostics.
 *
 * Checks:
 *   1. Required binaries are present in PATH.
 *   2. Installed versions are compatible with the pinned targets.
 *   3. The state directory is writable.
 *   4. Required configuration (env vars) is set.
 *
 * **Never** prints secrets — sensitive values are checked for presence only.
 */
export function doctor(env: NodeJS.ProcessEnv = process.env): DoctorResult {
  const checks: DoctorCheck[] = [];

  checkBinary(checks, "buzz-acp", env);
  checkBinary(checks, "buzz-agent-prime", env);
  checkBinary(checks, "prime-agent", env);

  checkVersion(checks, "prime-agent", (bin) => {
    const out = execVersion(bin, ["--version"]);
    return { raw: out, expected: EXPECTED_PRIME_AGENT_VERSION };
  });
  checkVersion(checks, "buzz-acp", (bin) => {
    const out = execVersion(bin, ["--version"]);
    return { raw: out, expected: EXPECTED_BUZZ_VERSION };
  });

  checkStateDir(checks, env);
  checkRequiredConfig(checks, env);

  const exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
  return { checks, exitCode };
}

/**
 * Print doctor results to `writer` (defaults to `process.stdout`) and return
 * the exit code.  This is the function the CLI `doctor` command should call.
 */
export function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  writer: (s: string) => void = (s) => process.stdout.write(s),
): number {
  const result = doctor(env);

  writer("buzz-agent-prime doctor\n");
  writer("========================\n\n");

  for (const check of result.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    writer(`${icon} ${check.name}: ${check.message}\n`);
  }

  writer("\n");
  if (result.exitCode === 0) {
    writer("All checks passed.\n");
  } else {
    writer("One or more checks failed.\n");
  }

  return result.exitCode;
}

/* ---------- Individual checks ---------- */

function checkBinary(checks: DoctorCheck[], name: string, env: NodeJS.ProcessEnv): void {
  const path = which(name, env);
  if (path) {
    checks.push({ name: `binary:${name}`, status: "ok", message: `found at ${path}` });
  } else {
    checks.push({ name: `binary:${name}`, status: "fail", message: `'${name}' not found in PATH` });
  }
}

interface VersionInfo {
  raw: string;
  expected: string;
}

function checkVersion(
  checks: DoctorCheck[],
  name: string,
  get: (binary: string) => VersionInfo | null,
): void {
  const path = which(name);
  if (!path) {
    // Already reported by checkBinary; don't duplicate.
    return;
  }

  let info: VersionInfo | null = null;
  try {
    info = get(path);
  } catch (err) {
    checks.push({
      name: `version:${name}`,
      status: "warn",
      message: `failed to get version: ${(err as Error).message}`,
    });
    return;
  }

  if (!info || !info.raw) {
    checks.push({
      name: `version:${name}`,
      status: "warn",
      message: "could not determine version",
    });
    return;
  }

  const found = extractVersion(info.raw);
  if (found && found === info.expected) {
    checks.push({
      name: `version:${name}`,
      status: "ok",
      message: `v${found} (expected ${info.expected})`,
    });
  } else if (found) {
    checks.push({
      name: `version:${name}`,
      status: "warn",
      message: `v${found} (expected ${info.expected}) — pin mismatch`,
    });
  } else {
    checks.push({
      name: `version:${name}`,
      status: "warn",
      message: `version output not recognised: "${info.raw.trim()}"`,
    });
  }
}

function execVersion(binary: string, args: string[]): string {
  try {
    return execFileSync(binary, args, { encoding: "utf-8", timeout: 5000 });
  } catch {
    return "";
  }
}

/** Extract a semver-like version string from arbitrary output. */
export function extractVersion(raw: string): string | null {
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function checkStateDir(checks: DoctorCheck[], env: NodeJS.ProcessEnv): void {
  const statePaths = resolveStatePaths(env);

  try {
    ensureStateDirs(statePaths);
  } catch (err) {
    checks.push({
      name: "state-writable",
      status: "fail",
      message: `cannot create state directory ${statePaths.stateDir}: ${(err as Error).message}`,
    });
    return;
  }

  if (!isWritable(statePaths.stateDir)) {
    checks.push({
      name: "state-writable",
      status: "fail",
      message: `state directory is not writable: ${statePaths.stateDir}`,
    });
    return;
  }

  // Prove writability by creating and removing a temp file.
  try {
    const probe = mkdtempSync(join(statePaths.tmpDir, "doctor-"));
    writeFileSync(join(probe, ".probe"), "ok");
    rmSync(probe, { recursive: true, force: true });
    checks.push({
      name: "state-writable",
      status: "ok",
      message: `${statePaths.stateDir} is writable`,
    });
  } catch (err) {
    checks.push({
      name: "state-writable",
      status: "fail",
      message: `write probe failed: ${(err as Error).message}`,
    });
  }
}

/* ---------- Required configuration ---------- */

const REQUIRED_CONFIG: ReadonlyArray<{ key: string; label: string }> = [
  { key: "BUZZ_RELAY_URL", label: "Buzz relay URL" },
  { key: "BUZZ_PRIVATE_KEY", label: "Buzz private key (nsec or hex)" },
];

function checkRequiredConfig(checks: DoctorCheck[], env: NodeJS.ProcessEnv): void {
  for (const { key, label } of REQUIRED_CONFIG) {
    const value = env[key];
    if (value === undefined || value === "") {
      checks.push({
        name: `config:${key}`,
        status: "fail",
        message: `${label} is not set (env: ${key})`,
      });
    } else {
      // Never print the value — just confirm presence.
      checks.push({
        name: `config:${key}`,
        status: "ok",
        message: `${key} is set (value hidden)`,
      });
    }
  }
}

/* ---------- Test helper re-exports ---------- */

export function isSecretKey(name: string): boolean {
  return /PRIVATE_KEY|SECRET|TOKEN|PASSWORD|NSEC/i.test(name);
}
