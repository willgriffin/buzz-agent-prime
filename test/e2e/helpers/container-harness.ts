/**
 * Docker container harness for e2e restart recovery tests.
 *
 * Provides helpers to:
 * - Build a test container image (or skip if Docker unavailable)
 * - Start/stop/restart containers
 * - Inspect container state and volumes
 * - Simulate PVC-style persistence via Docker volumes
 *
 * Docker scenarios are opt-in. Every invoked Docker command has a bounded
 * process-group timeout so an unavailable CLI or daemon fails cleanly.
 */

import { spawn } from "node:child_process";

const dockerCommandTimeoutMs = 5000;

export interface ContainerConfig {
  /** Container name prefix (suffixed with random ID). */
  name: string;
  /** Docker image to use. */
  image: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Volume mounts: { hostPath: containerPath } or { volumeName: containerPath }. */
  volumes?: Record<string, string>;
  /** Explicit Docker volume mounts, including Kubernetes-style subpaths. */
  mounts?: ContainerMount[];
  /** Ports to expose: { containerPort: hostPort }. */
  ports?: Record<number, number>;
  /** Command to run. */
  command?: string[];
  /** Working directory inside container. */
  workdir?: string;
  /** Override the image entrypoint for a credential-free fixture. */
  entrypoint?: string;
  /** Run with an immutable root filesystem. */
  readOnlyRootFilesystem?: boolean;
  /** Writable temporary filesystems needed with an immutable root filesystem. */
  tmpfs?: string[];
}

export interface ContainerMount {
  /** Docker volume name. */
  source: string;
  /** Destination path in the container. */
  target: string;
  /** Existing directory inside the volume to mount, like a Kubernetes subPath. */
  subPath?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  running: boolean;
}

/**
 * Check if Docker is available on the system.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker(["info"]);
    return true;
  } catch {
    return false;
  }
}

/** Check for the image used by the explicit Docker E2E job. */
export async function isDockerImageAvailable(image: string): Promise<boolean> {
  try {
    await docker(["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a Docker command and return stdout.
 */
function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
      killProcessGroup();
      finish(() => reject(new Error(`docker ${args[0] ?? "command"} timed out`)));
    }, dockerCommandTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      if (code === 0) {
        finish(() => resolve(stdout.trim()));
      } else {
        finish(() => reject(new Error(stderr.trim() || `docker exited with status ${code}`)));
      }
    });
  });
}

/**
 * Create a Docker volume for PVC-style persistence testing.
 */
export async function createVolume(name: string): Promise<string> {
  await docker(["volume", "create", name]);
  return name;
}

/**
 * Remove a Docker volume.
 */
export async function removeVolume(name: string): Promise<void> {
  try {
    await docker(["volume", "rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Start a container with the given configuration.
 * Returns the container ID.
 */
export async function startContainer(config: ContainerConfig): Promise<string> {
  const args = ["run", "-d", "--name", config.name];

  if (config.readOnlyRootFilesystem) {
    args.push("--read-only");
  }

  if (config.tmpfs) {
    for (const mount of config.tmpfs) {
      args.push("--tmpfs", mount);
    }
  }

  if (config.entrypoint) {
    args.push("--entrypoint", config.entrypoint);
  }

  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      args.push("-e", `${k}=${v}`);
    }
  }

  if (config.volumes) {
    for (const [host, container] of Object.entries(config.volumes)) {
      args.push("-v", `${host}:${container}`);
    }
  }

  if (config.mounts) {
    for (const mount of config.mounts) {
      const fields = ["type=volume", `src=${mount.source}`, `dst=${mount.target}`];
      if (mount.subPath) fields.push(`volume-subpath=${mount.subPath}`);
      args.push("--mount", fields.join(","));
    }
  }

  if (config.ports) {
    for (const [containerPort, hostPort] of Object.entries(config.ports)) {
      args.push("-p", `${hostPort}:${containerPort}`);
    }
  }

  if (config.workdir) {
    args.push("-w", config.workdir);
  }

  args.push(config.image);

  if (config.command) {
    args.push(...config.command);
  }

  return await docker(args);
}

/**
 * Stop a container (graceful, then SIGKILL after 10s).
 */
export async function stopContainer(name: string): Promise<void> {
  try {
    await docker(["stop", "-t", "10", name]);
  } catch {
    // ignore
  }
}

/**
 * Restart a stopped container.
 */
export async function restartContainer(name: string): Promise<void> {
  await docker(["start", name]);
}

/**
 * Remove a container (force).
 */
export async function removeContainer(name: string): Promise<void> {
  try {
    await docker(["rm", "-f", name]);
  } catch {
    // ignore
  }
}

/**
 * Get container info (status, running state).
 */
export async function getContainerInfo(name: string): Promise<ContainerInfo> {
  const inspect = await docker([
    "inspect",
    "--format",
    "{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}",
    name,
  ]);
  const parts = inspect.split("|");
  return {
    id: parts[0] ?? "",
    name: parts[1] ?? "",
    status: parts[2] ?? "unknown",
    running: parts[3] === "true",
  };
}

/**
 * Execute a command inside a running container and return stdout.
 */
export async function execInContainer(name: string, command: string[]): Promise<string> {
  return await docker(["exec", name, ...command]);
}

/**
 * Get container logs.
 */
export async function getContainerLogs(name: string): Promise<string> {
  return await docker(["logs", name]);
}

/**
 * Wait for a container to reach "running" state.
 */
export async function waitForContainerRunning(name: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await getContainerInfo(name);
      if (info.running) return true;
    } catch {
      // container might not exist yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Generate a unique container name.
 */
export function uniqueContainerName(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}
