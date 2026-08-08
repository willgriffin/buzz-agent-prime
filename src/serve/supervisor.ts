import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** Options for launching a supervised child process. */
export interface SupervisorOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Grace period in ms before SIGKILL on shutdown (default 10 000). */
  shutdownTimeoutMs?: number;
}

/** Exit information for the supervised process. */
export interface SupervisorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Supervise a single child process and manage graceful shutdown.
 *
 * The child is spawned in its own process group (`detached: true`) so that
 * a signal sent to the group reaches every descendant (the full process
 * tree — buzz-acp → buzz-agent-prime acp → prime-agent).
 *
 * On SIGTERM/SIGINT the supervisor:
 *   1. Marks itself as shutting down (stops accepting work).
 *   2. Emits `shutdown` so listeners can flush state.
 *   3. Delivers the signal to the entire process group.
 *   4. Waits up to `shutdownTimeoutMs` then escalates to SIGKILL.
 */
export class Supervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private shuttingDown = false;
  readonly shutdownTimeoutMs: number;

  constructor(private readonly options: SupervisorOptions) {
    super();
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  }

  /** True while the child process is alive and no shutdown has begun. */
  get running(): boolean {
    return this.child !== null && !this.shuttingDown;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Start the supervised child process. */
  start(): void {
    const child = spawn(this.options.command, this.options.args, {
      env: this.options.env,
      cwd: this.options.cwd,
      stdio: "inherit",
      detached: true,
    });
    this.child = child;

    child.on("exit", (code, signal) => {
      this.emit("exit", code, signal);
    });

    child.on("error", (err) => {
      this.emit("error", err);
    });
  }

  /** Whether shutdown has been initiated. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Gracefully shut down the supervised process tree.
   *
   * Flushes state via the `shutdown` event, then signals the process group.
   * Resolves once the child has exited (or been killed).
   */
  async shutdown(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Let listeners flush state before we signal the tree.
    this.emit("shutdown", signal);

    const child = this.child;
    if (!child || child.killed) return;

    await this.terminate(child, signal);
  }

  private terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;

      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };

      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        done();
      }, this.shutdownTimeoutMs);

      child.once("exit", () => done());

      // Signal the entire process group so descendants receive the signal.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Process group may not exist yet; fall back to direct kill.
          child.kill(signal);
        }
      }
    });
  }
}
