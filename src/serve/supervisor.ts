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
      // POSIX process groups let shutdown reach every descendant. Windows has
      // no compatible negative-PID signalling, so it uses direct-child
      // signalling below instead.
      detached: process.platform !== "win32",
      windowsHide: true,
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
    // A failed spawn has no OS process to signal or reap.
    if (!child || child.pid === undefined || this.hasExited(child)) return;

    await this.terminate(child, signal);
  }

  private async terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    const groupSignalled = this.signalProcessTree(child, signal);
    if (groupSignalled) {
      // A group can outlive its leader when a descendant ignores SIGTERM. Keep
      // watching the group through the grace period rather than treating the
      // direct child's exit as a complete shutdown.
      if (await this.waitForProcessGroupExit(child.pid!, this.shutdownTimeoutMs)) {
        await this.waitForExit(child);
        return;
      }

      this.signalProcessTree(child, "SIGKILL");
      // Reap the direct child and wait for the group to disappear so callers
      // cannot observe a briefly surviving descendant after shutdown resolves.
      await Promise.all([this.waitForExit(child), this.waitForProcessGroupExit(child.pid!)]);
      return;
    }

    if (await this.waitForExit(child, this.shutdownTimeoutMs)) return;

    // The initial signal may have been delivered successfully without causing
    // an exit. Escalate, then wait until Node has observed the child exit
    // before declaring shutdown complete.
    this.signalProcessTree(child, "SIGKILL");
    await this.waitForExit(child);
  }

  /** Whether Node has observed the child process exit and reaped it. */
  private hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  /**
   * Signal the child's POSIX process group, with a direct-child fallback.
   *
   * Never use a negative PID on Windows or when it could target this process's
   * own group. The latter cannot occur for a detached child, but the guard
   * keeps this safety property explicit even if spawning changes later.
   */
  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
    const pid = child.pid;
    if (pid === undefined || pid <= 0 || pid === process.pid) return false;

    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        // The group may have gone away between liveness checking and signal
        // delivery. Its direct child remains safe to signal as a fallback.
      }
    }

    try {
      child.kill(signal);
    } catch {
      // The child exited between liveness checking and signal delivery.
    }
    return false;
  }

  /** Wait until a POSIX process group no longer exists, optionally up to a grace period. */
  private async waitForProcessGroupExit(pid: number, timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (this.isProcessGroupAlive(pid)) {
      if (deadline === undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      } else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 25)));
      }
    }
    return true;
  }

  /** Check a detached POSIX process group without ever probing our own group. */
  private isProcessGroupAlive(pid: number): boolean {
    if (process.platform === "win32" || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH proves the group is gone. Other errors (for example EPERM) mean
      // it may still be running, so retain the safer escalation path.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /** Wait for an observed exit, optionally returning false when grace expires. */
  private async waitForExit(child: ChildProcess, timeoutMs?: number): Promise<boolean> {
    if (this.hasExited(child)) return true;

    let onExit: () => void;
    const exited = new Promise<boolean>((resolve) => {
      onExit = () => resolve(true);
      child.once("exit", onExit);
      if (this.hasExited(child)) {
        child.removeListener("exit", onExit);
        resolve(true);
      }
    });

    if (timeoutMs === undefined) return exited;

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) child.removeListener("exit", onExit!);
    return result;
  }
}
