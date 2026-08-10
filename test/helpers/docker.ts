import { spawn } from "node:child_process";

const dockerCommandTimeoutMs = 30000;
const dockerProbeTimeoutMs = 5000;

export interface DockerCommandOptions {
  timeoutMs?: number;
}

/**
 * Run a Docker CLI command with a bounded process-group lifetime.
 *
 * Docker CLI plugins can otherwise outlive a timed-out synchronous caller.
 */
export function runDockerCommand(
  args: string[],
  { timeoutMs = dockerCommandTimeoutMs }: DockerCommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closeTimeout: NodeJS.Timeout | undefined;
    let timeoutError: Error | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeTimeout) clearTimeout(closeTimeout);
      callback();
    };
    const killProcessGroup = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The command already exited or the process group is unavailable.
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timeout = setTimeout(() => {
      timeoutError = new Error(`docker ${args[0] ?? "command"} timed out`);
      killProcessGroup();
      // Prefer the CLI's close event after killing its entire process group;
      // the short fallback prevents a broken plugin from holding the test open.
      closeTimeout = setTimeout(() => finish(() => reject(timeoutError!)), 1000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      if (timeoutError) {
        finish(() => reject(timeoutError));
        return;
      }
      if (code === 0) {
        finish(() => resolve(stdout.trim()));
      } else {
        finish(() => reject(new Error(stderr.trim() || `docker exited with status ${code}`)));
      }
    });
  });
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await runDockerCommand(["info"], { timeoutMs: dockerProbeTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function isDockerImageAvailable(image: string): Promise<boolean> {
  try {
    await runDockerCommand(["image", "inspect", image], { timeoutMs: dockerProbeTimeoutMs });
    return true;
  } catch {
    return false;
  }
}
