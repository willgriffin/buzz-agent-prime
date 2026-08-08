import { mkdirSync, accessSync, constants, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Default persistent state directory (see docs/contracts.md). */
export const DEFAULT_STATE_DIR = "/var/lib/buzz-agent-prime";

/** Absolute paths for every durable subdirectory under the state root. */
export interface StatePaths {
  stateDir: string;
  workspaceDir: string;
  tmpDir: string;
  sessionsDir: string;
  configDir: string;
}

function getVar(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[name];
}

/** Resolve the state root directory from the env or the default. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(getVar("BUZZ_AGENT_PRIME_STATE_DIR", env) ?? DEFAULT_STATE_DIR);
}

/** Resolve the workspace directory (defaults to `<state>/workspace`). */
export function resolveWorkspaceDir(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(getVar("BUZZ_AGENT_PRIME_WORKSPACE_DIR", env) ?? join(stateDir, "workspace"));
}

/** Resolve the tmp directory (defaults to `<state>/tmp`). */
export function resolveTmpDir(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(getVar("BUZZ_AGENT_PRIME_TMP_DIR", env) ?? join(stateDir, "tmp"));
}

/** Resolve every state subdirectory from the environment. */
export function resolveStatePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const stateDir = resolveStateDir(env);
  return {
    stateDir,
    workspaceDir: resolveWorkspaceDir(stateDir, env),
    tmpDir: resolveTmpDir(stateDir, env),
    sessionsDir: join(stateDir, "sessions"),
    configDir: join(stateDir, "config"),
  };
}

/** Create all state subdirectories if they don't already exist. */
export function ensureStateDirs(paths: StatePaths): void {
  for (const dir of [
    paths.stateDir,
    paths.workspaceDir,
    paths.tmpDir,
    paths.sessionsDir,
    paths.configDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Return true when `dir` exists and is writable by the current process. */
export function isWritable(dir: string): boolean {
  try {
    const st: Stats = statSync(dir);
    return st.isDirectory() && hasAccess(dir, constants.W_OK);
  } catch {
    return false;
  }
}

function hasAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}
