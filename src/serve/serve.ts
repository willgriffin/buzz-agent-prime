import { resolveStatePaths, ensureStateDirs, isWritable, type StatePaths } from "../state/paths.js";
import { SessionStore } from "../state/session.js";
import { resolveServeConfig, buildBuzzAcpEnv } from "../state/config.js";
import { Supervisor } from "./supervisor.js";
import { which } from "./which.js";

/** Options for the `serve` command. */
export interface ServeOptions {
  /** Environment to read config from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override the buzz-acp binary path (primarily for testing). */
  buzzAcpBinary?: string;
  /** Stderr writer (defaults to `process.stderr.write`). */
  stderr?: (chunk: string) => void;
}

/** Exit codes for serve. */
export const SERVE_EXIT = {
  OK: 0,
  BINARY_MISSING: 3,
  STATE_UNWRITABLE: 4,
  SPAWN_ERROR: 5,
} as const;

/**
 * Launch `buzz-acp` with `buzz-agent-prime acp` as the agent command and
 * supervise the process tree.
 *
 * Default configuration (from docs/contracts.md):
 *   - One harness process (buzz-acp).
 *   - Owner-only inbound access (`BUZZ_ACP_RESPOND_TO=owner-only`).
 *   - Mention filtering (implied by owner-only).
 *   - Heartbeat disabled (`BUZZ_ACP_HEARTBEAT_INTERVAL=0`).
 *
 * Durable session directories are derived from the canonical working
 * directory plus the session title.  Unnamed sessions are ephemeral.
 * On restart the most recent durable session is resumed.
 */
export async function serve(options: ServeOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((c: string) => process.stderr.write(c));

  // 1. Resolve configuration and state paths.
  const config = resolveServeConfig(env);
  const statePaths = resolveStatePaths(env);

  // 2. Validate state directory writability.
  ensureStateDirs(statePaths);
  if (!isWritable(statePaths.stateDir)) {
    stderr(`buzz-agent-prime serve: state directory is not writable: ${statePaths.stateDir}\n`);
    return SERVE_EXIT.STATE_UNWRITABLE;
  }

  // 3. Resume the most recent durable session (if any).
  const sessionStore = new SessionStore(statePaths.sessionsDir);
  const resumeSession = sessionStore.mostRecent();
  if (resumeSession) {
    const meta = sessionStore.loadMetadata(resumeSession.sessionId);
    if (meta) {
      stderr(`buzz-agent-prime serve: resuming session ${resumeSession.sessionId}\n`);
      sessionStore.touch(resumeSession.sessionId);
    }
  } else {
    stderr("buzz-agent-prime serve: no prior session found; starting fresh\n");
  }

  // 4. Locate the buzz-acp binary.
  const buzzAcp = options.buzzAcpBinary ?? which("buzz-acp", env);
  if (!buzzAcp) {
    stderr("buzz-agent-prime serve: buzz-acp binary not found in PATH\n");
    return SERVE_EXIT.BINARY_MISSING;
  }

  // 5. Build the environment for buzz-acp.
  const acpEnv = buildBuzzAcpEnv(config, statePaths, env);

  // 6. Launch and supervise.
  const supervisor = new Supervisor({
    command: buzzAcp,
    args: [],
    env: acpEnv,
    cwd: statePaths.workspaceDir,
  });

  setupSignalHandlers(supervisor, statePaths, sessionStore);

  return new Promise<number>((resolve) => {
    supervisor.on("error", (err: Error) => {
      stderr(`buzz-agent-prime serve: failed to launch buzz-acp: ${err.message}\n`);
      resolve(SERVE_EXIT.SPAWN_ERROR);
    });

    supervisor.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (supervisor.isShuttingDown) {
        // Clean shutdown initiated by signal — exit 0.
        resolve(0);
      } else if (code !== null) {
        resolve(code);
      } else if (signal !== null) {
        resolve(128 + signalNum(signal));
      } else {
        resolve(SERVE_EXIT.SPAWN_ERROR);
      }
    });

    try {
      supervisor.start();
    } catch (err) {
      stderr(`buzz-agent-prime serve: failed to launch buzz-acp: ${(err as Error).message}\n`);
      resolve(SERVE_EXIT.SPAWN_ERROR);
    }
  });
}

function setupSignalHandlers(
  supervisor: Supervisor,
  _statePaths: StatePaths,
  _sessionStore: SessionStore,
): void {
  const handler = (signal: NodeJS.Signals): void => {
    // The supervisor's shutdown event lets listeners flush state.
    void supervisor.shutdown(signal);
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

function signalNum(signal: NodeJS.Signals): number {
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  return map[signal] ?? 1;
}
