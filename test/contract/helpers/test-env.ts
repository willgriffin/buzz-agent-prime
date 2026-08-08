/**
 * Shared test environment helpers for contract and e2e test suites.
 */

import * as path from "node:path";
import { isAcpImplemented } from "./acp-client.js";

/** Resolve the worktree root from the test file location. */
export const WORKTREE_DIR = path.resolve(import.meta.dirname, "..", "..", "..");

let acpReady: boolean | null = null;

/**
 * Check (once, cached) whether `buzz-agent-prime acp` is implemented.
 * Contract tests gate on this to skip when the core multiplexer (#3)
 * hasn't been merged yet.
 */
export async function isAcpReady(): Promise<boolean> {
  if (acpReady !== null) return acpReady;
  acpReady = await isAcpImplemented(WORKTREE_DIR);
  return acpReady;
}

/**
 * Check if Docker is available on the system (for e2e tests).
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("docker", ["info"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if buzz-acp binary is available (for e2e tests).
 */
export async function isBuzzAcpAvailable(): Promise<boolean> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("buzz-acp", ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
